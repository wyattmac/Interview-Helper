import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "../data/mock-interview.json");

export function getMockInterview() {
  return JSON.parse(readFileSync(scriptPath, "utf8"));
}

export async function synthesizeSpeech({
  text,
  apiKey,
  voiceId,
  language = "en",
}) {
  const script = getMockInterview();
  voiceId = voiceId || script.voiceId || "rex";
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
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TTS error ${response.status}: ${body.slice(0, 400)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    contentType: response.headers.get("content-type") || "audio/mpeg",
  };
}
