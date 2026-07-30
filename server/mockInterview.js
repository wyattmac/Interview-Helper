import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "../data/mock-interview.json");

const audioCache = new Map(); // cacheKey -> { buffer, contentType }
const inflight = new Map(); // cacheKey -> Promise

export function getMockInterview() {
  return JSON.parse(readFileSync(scriptPath, "utf8"));
}

export function clearMockAudioCache() {
  audioCache.clear();
  inflight.clear();
}

export async function synthesizeSpeech({
  text,
  apiKey,
  voiceId,
  cacheKey,
  timeoutMs = 15000,
  language = "en",
}) {
  const script = getMockInterview();
  voiceId = voiceId || script.voiceId || "rex";

  if (cacheKey && audioCache.has(cacheKey)) {
    return audioCache.get(cacheKey);
  }
  if (cacheKey && inflight.has(cacheKey)) {
    return inflight.get(cacheKey);
  }

  const work = (async () => {
    const response = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_id: voiceId,
        language,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`TTS error ${response.status}: ${body.slice(0, 400)}`);
    }

    const audio = {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "audio/mpeg",
    };

    if (cacheKey) audioCache.set(cacheKey, audio);
    return audio;
  })().finally(() => {
    if (cacheKey) inflight.delete(cacheKey);
  });

  if (cacheKey) inflight.set(cacheKey, work);
  return work;
}
