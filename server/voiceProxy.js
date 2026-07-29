import { WebSocket } from "ws";
const VOICE_KEYTERMS = [
  "Optum",
  "UnitedHealth",
  "SKED",
  "CMMS",
  "SAP",
  "PLC",
  "HMI",
  "Allen-Bradley",
  "Studio 5000",
  "RSLogix",
  "Beckhoff",
  "pneumatic",
  "480 volt",
  "pill dispenser",
  "pharmacy",
  "Charlotte",
];
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const candidate = JSON.parse(
  readFileSync(join(__dirname, "../data/candidate-profile.json"), "utf8"),
);
const prep = JSON.parse(
  readFileSync(join(__dirname, "../data/job-prep.json"), "utf8"),
);

const VOICE_MODEL = process.env.XAI_VOICE_MODEL || "grok-voice-think-fast-2.0";

console.log(`Voice proxy ready (model: ${VOICE_MODEL})`);

export function buildInterviewerInstructions() {
  const { role } = prep;
  return `You are Jordan, a technical recruiter at ${role.company} running a phone screen with ${candidate.name} for ${role.title} (req ${role.requisition}) in Charlotte, NC.

Style: professional but warm, like a real recruiter. Speak in short sentences. Ask ONE question at a time and wait for the answer. React briefly ("got it", "okay") before the next question.

Flow (cover all, ~8 questions):
1. Intro: who you are, role, confirm it's a good time
2. Schedule: onsite Sun–Thu 2pm–11:30pm, occasional Saturday OT — confirm availability
3. Troubleshooting method for a sudden machine stop on an automated line
4. A specific electrical/electronics diagnosis story under pressure
5. CMMS experience (listen for SKED — probe how they used it)
6. PLC/HMI experience (Allen-Bradley, Studio 5000, Beckhoff — gauge depth honestly)
7. Prioritizing multiple down machines + radio communication
8. Why Optum / pharmacy automation
9. Close: invite their questions

Behavior:
- If an answer is vague, probe once ("can you give me a specific example?") before moving on.
- Do not coach or correct them during the interview — you're the interviewer, stay in character.
- Keep the whole screen under ~10 minutes.
- If they ask questions at the end, answer realistically as a recruiter (team size, training, equipment) using: mail-order pharmacy automation, pill dispensers, robotics, Allen-Bradley/Beckhoff PLCs, CMMS, 2nd shift team.`;
}

export function attachVoiceProxy(client, { apiKey }) {
  {
    if (!apiKey) {
      client.send(JSON.stringify({ type: "error", message: "Server missing XAI_API_KEY" }));
      client.close(1011, "Missing API key");
      return;
    }

    const upstream = new WebSocket(
      `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(VOICE_MODEL)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );

    const pending = [];
    let open = false;

    const sendUpstream = (msg) => {
      const raw = typeof msg === "string" ? msg : JSON.stringify(msg);
      if (open && upstream.readyState === WebSocket.OPEN) upstream.send(raw);
      else pending.push(raw);
    };

    upstream.on("open", () => {
      open = true;
      sendUpstream({
        type: "session.update",
        session: {
          voice: "rex",
          instructions: buildInterviewerInstructions(),
          turn_detection: { type: "server_vad", silence_duration_ms: 900 },
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 16000 },
              transcription: { keyterms: VOICE_KEYTERMS },
            },
            output: { format: { type: "audio/pcm", rate: 24000 } },
          },
        },
      });
      for (const raw of pending) upstream.send(raw);
      pending.length = 0;
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "voice.ready", model: VOICE_MODEL }));
      }
    });

    upstream.on("message", (data, isBinary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        client.send(data, { binary: true });
        return;
      }
      // Pass through JSON events; surface upstream errors with real detail.
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") {
          console.error("xAI voice error:", JSON.stringify(msg).slice(0, 400));
        }
        // Decode base64 audio deltas to binary PCM frames so the browser can
        // feed them straight into the player without base64 work per frame.
        if (
          (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") &&
          typeof msg.delta === "string" &&
          msg.delta.length > 0
        ) {
          const buf = Buffer.from(msg.delta, "base64");
          client.send(buf, { binary: true });
          // Still forward the event (without payload) for state tracking.
          client.send(JSON.stringify({ ...msg, delta: undefined }));
          return;
        }
        client.send(JSON.stringify(msg));
      } catch {
        client.send(data.toString());
      }
    });

    upstream.on("error", (err) => {
      console.error("voice upstream error", err);
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({ type: "error", message: err.message || "Voice upstream error" }),
        );
      }
    });

    upstream.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => {
        console.error(`voice upstream ${res.statusCode}: ${body.slice(0, 400)}`);
        if (client.readyState === WebSocket.OPEN) {
          client.send(
            JSON.stringify({
              type: "error",
              message: `xAI voice ${res.statusCode}: ${body.slice(0, 200)}`,
            }),
          );
          client.close(1011, "Upstream rejected");
        }
      });
    });

    upstream.on("close", () => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "voice.closed" }));
        client.close();
      }
    });

    client.on("message", (data, isBinary) => {
      if (isBinary) {
        // Browser sends raw PCM frames; forward as base64 append events.
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        sendUpstream({
          type: "input_audio_buffer.append",
          audio: buf.toString("base64"),
        });
        return;
      }

      // JSON control events from the client.
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // interview_kickoff is our own sugar: seed the opener and request a
      // response. The realtime API rejects conversation.item.create for
      // roles other than user, so the assistant prompt goes via instructions
      // and we only create a user item + response.create.
      if (msg.type === "interview_kickoff") {
        sendUpstream({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Hi, this is Wyatt. I'm ready for the phone screen.",
              },
            ],
          },
        });
        sendUpstream({ type: "response.create" });
        return;
      }

      sendUpstream(data.toString());
    });

    client.on("close", () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });
  }
}
