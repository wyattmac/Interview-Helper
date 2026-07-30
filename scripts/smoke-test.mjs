import "dotenv/config";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8787";
const API_KEY = process.env.XAI_API_KEY;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log("1) Health check…");
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert(health.ok, "health not ok");
  assert(health.hasApiKey, "XAI_API_KEY missing on server");
  console.log("   model:", health.model);

  console.log("2) Mock interview script…");
  const script = await fetch(`${BASE}/api/mock-interview`).then((r) => r.json());
  assert(script.steps?.length >= 3, "mock script missing steps");
  const question = script.steps.find((s) => s.id === "cmms") || script.steps[2];
  console.log("   using step:", question.id);

  console.log("3) Grok TTS…");
  const ttsRes = await fetch(`${BASE}/api/mock-interview/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stepId: question.id }),
  });
  if (!ttsRes.ok) {
    throw new Error(`TTS failed: ${ttsRes.status} ${await ttsRes.text()}`);
  }
  const mp3 = Buffer.from(await ttsRes.arrayBuffer());
  assert(mp3.length > 1000, "TTS audio too small");
  const mp3Path = join(tmpdir(), `mock-${question.id}.mp3`);
  writeFileSync(mp3Path, mp3);
  console.log("   audio bytes:", mp3.length);

  console.log("4) xAI STT on spoken question…");
  assert(API_KEY, "XAI_API_KEY required in env for direct STT check");
  const form = new FormData();
  form.append("language", "en");
  form.append("format", "true");
  form.append("file", new Blob([mp3]), `${question.id}.mp3`);
  const sttRes = await fetch("https://api.x.ai/v1/stt", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
  });
  if (!sttRes.ok) {
    throw new Error(`STT failed: ${sttRes.status} ${await sttRes.text()}`);
  }
  const stt = await sttRes.json();
  assert(stt.text && stt.text.length > 10, "STT returned empty text");
  console.log("   transcript:", stt.text.slice(0, 160));

  console.log("5) Topic brief via /api/brief…");
  const briefRes = await fetch(`${BASE}/api/brief`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript: `Interviewer asked: ${stt.text}`,
    }),
  });
  const brief = await briefRes.json();
  if (!briefRes.ok) {
    throw new Error(`brief failed: ${JSON.stringify(brief)}`);
  }
  assert(brief.topic, "brief missing topic");
  assert(Array.isArray(brief.talkingPoints), "brief missing talkingPoints");
  console.log("   topic:", brief.topic);
  console.log("   sayThis:", (brief.sayThis || "").slice(0, 160));
  if (brief.storyToUse) console.log("   story:", brief.storyToUse);

  // Optional: convert to PCM and hit local STT websocket quickly
  console.log("6) Streaming STT websocket via local proxy…");
  const pcmPath = join(tmpdir(), `mock-${question.id}.pcm`);
  await run("ffmpeg", [
    "-y",
    "-i",
    mp3Path,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    pcmPath,
  ]);
  const pcm = readFileSync(pcmPath);

  const wsUrl = BASE.replace("http", "ws") + "/ws/stt";
  const transcript = await streamStt(wsUrl, pcm);
  assert(transcript.length > 5, "websocket STT produced no transcript");
  console.log("   ws transcript:", transcript.slice(0, 160));

  try {
    unlinkSync(mp3Path);
    unlinkSync(pcmPath);
  } catch {
    /* ignore */
  }

  console.log("\nSMOKE OK — TTS, STT, brief, and WS proxy are working.");
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed: ${err.slice(-400)}`));
    });
  });
}

function streamStt(url, pcm) {
  return new Promise((resolve, reject) => {
    import("ws").then(({ default: WebSocket }) => {
      const ws = new WebSocket(url);
      let finalText = "";
      let ready = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("STT websocket timeout"));
      }, 60000);

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "session.ready") {
          ready = true;
          const frame = 3200; // 100ms @ 16k mono int16
          let offset = 0;
          const pump = setInterval(() => {
            if (offset >= pcm.length) {
              clearInterval(pump);
              ws.send(JSON.stringify({ type: "audio.done" }));
              return;
            }
            ws.send(pcm.subarray(offset, offset + frame));
            offset += frame;
          }, 100);
        }
        if (msg.type === "transcript" && msg.text) {
          finalText = msg.text;
        }
        if (msg.type === "transcript.done") {
          finalText = msg.text || finalText;
          clearTimeout(timer);
          ws.close();
          resolve(finalText);
        }
        if (msg.type === "error") {
          clearTimeout(timer);
          reject(new Error(msg.message));
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("close", () => {
        if (!ready && !finalText) {
          clearTimeout(timer);
          reject(new Error("STT websocket closed before ready"));
        }
      });
    });
  });
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err.message);
  process.exit(1);
});
