import "dotenv/config";
import http from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import {
  buildSystemPrompt,
  getCandidateProfile,
  getJobPrep,
  getSttKeyterms,
} from "./jobContext.js";
import {
  clearMockAudioCache,
  getMockInterview,
  synthesizeSpeech,
} from "./mockInterview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.5";
const SAMPLE_RATE = Number(process.env.XAI_STT_SAMPLE_RATE || 16000);
const REASONING_EFFORT = process.env.XAI_REASONING_EFFORT || "low";
const FETCH_TIMEOUT_MS = Number(process.env.XAI_FETCH_TIMEOUT_MS || 15000);
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// ~3 seconds of 16-bit mono audio at the configured sample rate.
const MAX_PENDING_AUDIO_BYTES = SAMPLE_RATE * 2 * 3;

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin / curl (no origin) and explicitly allowed dev origins.
      if (!origin || ALLOWED_ORIGINS.size === 0 || ALLOWED_ORIGINS.has(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error("Not allowed by CORS"));
    },
  }),
);
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(XAI_API_KEY),
    model: XAI_MODEL,
    reasoningEffort: REASONING_EFFORT,
    sampleRate: SAMPLE_RATE,
    host: HOST,
  });
});

app.get("/api/job-prep", (_req, res) => {
  res.json(getJobPrep());
});

app.get("/api/candidate", (_req, res) => {
  res.json(getCandidateProfile());
});

app.get("/api/mock-interview", (_req, res) => {
  res.json(getMockInterview());
});

app.post("/api/mock-interview/speak", async (req, res) => {
  if (!XAI_API_KEY) {
    res.status(503).json({ error: "Missing XAI_API_KEY" });
    return;
  }

  // stepId-only: never accept arbitrary text, so the key can't be used as a
  // general-purpose TTS spend surface if the port is reached.
  const { stepId } = req.body || {};
  const script = getMockInterview();
  const step = script.steps.find((s) => s.id === stepId);

  if (!step) {
    res.status(400).json({ error: "Unknown stepId." });
    return;
  }

  try {
    const audio = await synthesizeSpeech({
      text: step.text,
      apiKey: XAI_API_KEY,
      voiceId: script.voiceId || "rex",
      cacheKey: step.id,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    res.setHeader("Content-Type", audio.contentType);
    res.setHeader("Cache-Control", "no-store");
    res.send(audio.buffer);
  } catch (err) {
    console.error("tts error", err);
    res.status(502).json({
      error: err instanceof Error ? err.message : "TTS failed",
    });
  }
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
  for (const term of getSttKeyterms()) {
    params.append("keyterm", term);
  }

  const xaiUrl = `wss://api.x.ai/v1/stt?${params.toString()}`;
  const upstream = new WebSocket(xaiUrl, {
    headers: { Authorization: `Bearer ${XAI_API_KEY}` },
  });

  let ready = false;
  const pendingAudio = [];
  let pendingBytes = 0;
  let droppedBytes = 0;

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
      pendingBytes = 0;
      forwardToClient({
        type: "session.ready",
        droppedAudioMs: Math.round((droppedBytes / 2 / SAMPLE_RATE) * 1000),
      });
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
    forwardToClient({ type: "session.closed" });
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  client.on("message", (data, isBinary) => {
    // In the `ws` library, text frames are still Buffer objects — use isBinary.
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!ready) {
        // Bound the pre-ready buffer so a slow upstream can't balloon memory.
        pendingAudio.push(buf);
        pendingBytes += buf.length;
        while (pendingBytes > MAX_PENDING_AUDIO_BYTES && pendingAudio.length > 0) {
          const dropped = pendingAudio.shift();
          pendingBytes -= dropped.length;
          droppedBytes += dropped.length;
        }
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
  const run = () =>
    fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${XAI_API_KEY}`,
        "Content-Type": "application/json",
        "x-grok-conv-id": "interview-helper-optum-est",
      },
      body: JSON.stringify({
        model: XAI_MODEL,
        temperature: 0.3,
        max_tokens: 450,
        reasoning_effort: REASONING_EFFORT,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content: `Latest interview transcript window:\n\n${transcript}\n\nProduce the coaching JSON now.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

  let response = await run();
  if (!response.ok && response.status >= 500) {
    response = await run(); // one retry on transient upstream failures
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`xAI chat error ${response.status}: ${body.slice(0, 400)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty model response");

  const parsed = parseJsonLoose(content);
  return {
    topic: String(parsed.topic || "General discussion"),
    whyItMatters: String(parsed.whyItMatters || ""),
    talkingPoints: Array.isArray(parsed.talkingPoints)
      ? parsed.talkingPoints.map(String).slice(0, 3)
      : [],
    sayThis: String(parsed.sayThis || ""),
    watchOut: String(parsed.watchOut || ""),
    storyToUse: String(parsed.storyToUse || ""),
    confidence: ["high", "medium", "low"].includes(parsed.confidence)
      ? parsed.confidence
      : "medium",
    model: XAI_MODEL,
    at: new Date().toISOString(),
  };
}

function parseJsonLoose(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Model returned non-JSON brief");
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Interview helper listening on http://${HOST}:${PORT}`);
  if (!XAI_API_KEY) {
    console.warn("WARNING: XAI_API_KEY is not set. Live listen will not work.");
  }
});

// Warm the TTS cache so the first mock question plays instantly.
if (XAI_API_KEY) {
  clearMockAudioCache();
  const script = getMockInterview();
  synthesizeSpeech({
    text: script.steps[0].text,
    apiKey: XAI_API_KEY,
    voiceId: script.voiceId || "rex",
    cacheKey: script.steps[0].id,
    timeoutMs: FETCH_TIMEOUT_MS,
  }).catch(() => {});
}
