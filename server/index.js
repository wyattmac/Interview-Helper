import "dotenv/config";
import http from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { buildSystemPrompt, getJobPrep } from "./jobContext.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

const PORT = Number(process.env.PORT || 8787);
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.3";
const SAMPLE_RATE = Number(process.env.XAI_STT_SAMPLE_RATE || 16000);

const KEYTERMS = [
  "Optum",
  "UnitedHealth",
  "Allen-Bradley",
  "Rockwell",
  "RSLogix",
  "Studio 5000",
  "Beckhoff",
  "PLC",
  "HMI",
  "CMMS",
  "SAP",
  "pneumatic",
  "480 volt",
  "three phase",
  "pill dispenser",
  "mail order pharmacy",
];

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(XAI_API_KEY),
    model: XAI_MODEL,
    sampleRate: SAMPLE_RATE,
  });
});

app.get("/api/job-prep", (_req, res) => {
  res.json(getJobPrep());
});

app.post("/api/brief", async (req, res) => {
  if (!XAI_API_KEY) {
    res.status(503).json({
      error: "Missing XAI_API_KEY. Copy .env.example to .env and add your key.",
    });
    return;
  }

  const { transcript = "", recentUtterances = [] } = req.body || {};
  const text = String(transcript || recentUtterances.join("\n")).trim();
  if (text.length < 12) {
    res.status(400).json({ error: "Need more transcript before briefing." });
    return;
  }

  try {
    const brief = await createTopicBrief(text);
    res.json(brief);
  } catch (err) {
    console.error("brief error", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "Failed to create brief",
    });
  }
});

if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
      next();
      return;
    }
    res.sendFile(join(DIST, "index.html"));
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/stt" });

wss.on("connection", (client) => {
  if (!XAI_API_KEY) {
    client.send(
      JSON.stringify({
        type: "error",
        message: "Server missing XAI_API_KEY",
      }),
    );
    client.close(1011, "Missing API key");
    return;
  }

  const params = new URLSearchParams({
    sample_rate: String(SAMPLE_RATE),
    encoding: "pcm",
    interim_results: "true",
    language: "en",
    smart_turn: "0.6",
    smart_turn_timeout: "2500",
    vad_threshold: "0.05",
    endpointing: "300",
  });
  for (const term of KEYTERMS) {
    params.append("keyterm", term);
  }

  const xaiUrl = `wss://api.x.ai/v1/stt?${params.toString()}`;
  const upstream = new WebSocket(xaiUrl, {
    headers: { Authorization: `Bearer ${XAI_API_KEY}` },
  });

  let ready = false;
  const pendingAudio = [];

  const forwardToClient = (payload) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  };

  upstream.on("open", () => {
    forwardToClient({ type: "session.opening" });
  });

  upstream.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "transcript.created") {
      ready = true;
      for (const chunk of pendingAudio) {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(chunk);
      }
      pendingAudio.length = 0;
      forwardToClient({ type: "session.ready" });
      return;
    }

    if (msg.type === "transcript.partial") {
      forwardToClient({
        type: "transcript",
        text: msg.text || "",
        isFinal: Boolean(msg.is_final),
        speechFinal: Boolean(msg.speech_final),
        start: msg.start,
        duration: msg.duration,
      });
      return;
    }

    if (msg.type === "transcript.done") {
      forwardToClient({
        type: "transcript.done",
        text: msg.text || "",
        duration: msg.duration,
      });
      return;
    }

    if (msg.type === "error") {
      forwardToClient({
        type: "error",
        message: msg.message || "Upstream STT error",
      });
    }
  });

  upstream.on("error", (err) => {
    forwardToClient({
      type: "error",
      message: err.message || "Upstream connection error",
    });
  });

  upstream.on("close", () => {
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  client.on("message", (data, isBinary) => {
    if (isBinary || data instanceof Buffer) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!ready) {
        pendingAudio.push(buf);
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(buf);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "finalize" && upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: "Finalize" }));
    }
    if (msg.type === "audio.done" && upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: "audio.done" }));
    }
  });

  client.on("close", () => {
    if (upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.send(JSON.stringify({ type: "audio.done" }));
      } catch {
        /* ignore */
      }
      upstream.close();
    }
  });
});

async function createTopicBrief(transcript) {
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${XAI_API_KEY}`,
      "Content-Type": "application/json",
      "x-grok-conv-id": "interview-helper-optum-est",
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      temperature: 0.4,
      max_tokens: 700,
      reasoning_effort: "none",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        {
          role: "user",
          content: `Latest interview transcript window:\n\n${transcript}\n\nProduce the coaching JSON now.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`xAI chat error ${response.status}: ${body.slice(0, 400)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty model response");

  const parsed = JSON.parse(content);
  return {
    topic: String(parsed.topic || "General discussion"),
    whyItMatters: String(parsed.whyItMatters || ""),
    talkingPoints: Array.isArray(parsed.talkingPoints)
      ? parsed.talkingPoints.map(String).slice(0, 6)
      : [],
    sayThis: String(parsed.sayThis || ""),
    watchOut: String(parsed.watchOut || ""),
    confidence: ["high", "medium", "low"].includes(parsed.confidence)
      ? parsed.confidence
      : "medium",
    model: XAI_MODEL,
    at: new Date().toISOString(),
  };
}

server.listen(PORT, () => {
  console.log(`Interview helper listening on http://localhost:${PORT}`);
  if (!XAI_API_KEY) {
    console.warn("WARNING: XAI_API_KEY is not set. Live listen will not work.");
  }
});
