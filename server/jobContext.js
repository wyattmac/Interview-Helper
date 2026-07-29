import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prep = JSON.parse(
  readFileSync(join(__dirname, "../data/job-prep.json"), "utf8"),
);
const candidate = JSON.parse(
  readFileSync(join(__dirname, "../data/candidate-profile.json"), "utf8"),
);

export function getJobPrep() {
  return prep;
}

export function getCandidateProfile() {
  return candidate;
}

export function buildGradingPrompt() {
  const { role, mustSell, preferred } = prep;
  const stories = candidate.starStories
    .map((s) => `- ${s.title}: ${s.star.result}`)
    .join("\n");

  return `You are grading a practice interview answer for ${candidate.name}, who is interviewing for ${role.title} at ${role.company}.

The interviewer will value: ${mustSell.slice(0, 4).join("; ")}.
Preferred extras: ${preferred.join("; ")}.

Wyatt's real stories he can draw on (never require others):
${stories}

Grade the candidate's spoken answer (it was transcribed, so ignore filler words and small STT errors).

Rules:
1. Judge against THIS role: safety-first troubleshooting, structured method (symptom → utilities → controls → isolate → restore → document), real stories/metrics, honest handling of gaps, clear schedule/availability answers.
2. Do NOT penalize for missing PLC/Studio 5000 depth if the answer pivots honestly — that's the correct play for Wyatt.
3. Be direct and specific. One coaching tip max. No generic praise.
4. Scores: 1 = poor/missing substance, 2 = vague, 3 = solid but generic, 4 = good with specifics, 5 = interview-winning (structured + real story + role-fit).

Return ONLY valid JSON:
{
  "score": 1 | 2 | 3 | 4 | 5,
  "verdict": string,
  "missed": string[],
  "betterAnswer": string,
  "coachingTip": string
}`;
}

export function getSttKeyterms() {
  const vocab = [
    "Optum",
    "UnitedHealth",
    "Charlotte",
    "SKED",
    "CMMS",
    "SAP",
    "PLC",
    "HMI",
    "Allen-Bradley",
    "Rockwell",
    "RSLogix",
    "Studio 5000",
    "Beckhoff",
    "pneumatic",
    "480 volt",
    "three phase",
    "motor control",
    "pill dispenser",
    "mail order pharmacy",
    "communications electronics supervisor",
    "BAE Systems",
    "USS James E. Williams",
  ];
  const seen = new Set();
  return vocab
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && t.length <= 50)
    .filter((t) => {
      const key = t.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function buildSystemPrompt() {
  const { role, mustSell, preferred, dayInLife } = prep;
  const primaryJobs = candidate.timeline
    .filter((j) => j.relevance === "primary")
    .map(
      (j) =>
        `- ${j.title} @ ${j.org} (${j.dates}): ${j.bullets.slice(0, 3).join("; ")}`,
    )
    .join("\n");

  const stories = candidate.starStories
    .map(
      (s) =>
        `- ${s.title} [${s.useFor.join(", ")}]: S=${s.star.situation} T=${s.star.task} A=${s.star.action} R=${s.star.result}`,
    )
    .join("\n");

  return `You are a live interview coach for ${candidate.name} interviewing for:

${role.title} at ${role.company}
Requisition ${role.requisition}
Location: ${role.location}
Schedule: ${role.schedule}
Pay range: ${role.pay}

Role realities:
- Onsite mail-order pharmacy automation / equipment services
- Hands-on electrical, mechanical, pneumatic, PLC troubleshooting
- Radio service calls, sensor checks, pill dispensers, CMMS/SAP work orders
- Travel up to 10%

Must-demonstrate qualifications:
${mustSell.map((s) => `- ${s}`).join("\n")}

Preferred:
${preferred.map((s) => `- ${s}`).join("\n")}

Typical day:
${dayInLife.map((s) => `- ${s}`).join("\n")}

CANDIDATE PROFILE (use ONLY this real history — never invent jobs, OEMs, PLC brands, or hours):
Headline: ${candidate.headline}
Primary technical jobs:
${primaryJobs}
Technical strengths: ${candidate.technicalStrengths.join("; ")}
Honest gaps / rules: ${candidate.honestGaps.join(" | ")}
Bridge lines he can use: ${candidate.bridgeLines.join(" | ")}

STAR stories available:
${stories}

Your job during the live interview feed:
1. Detect the topic the interviewer is probing (or the candidate is answering).
2. Give SHORT coaching tied to Wyatt's real Navy ET / BAE / leadership stories when possible.
3. Prefer industrial maintenance language (LOTO, 480V, motor controls, pneumatics, sensors, PLC faults, CMMS) when relevant. For CMMS/SAP questions, lead with his real Navy SKED experience as Communications Electronics Supervisor, then map to their system.
4. If the transcript is small talk or unclear, say so briefly and wait — do not invent a technical topic.
5. NEVER invent personal work history. If he lacks a specific skill (e.g. Studio 5000 depth, pill dispenser OEM), coach an honest pivot + learning plan.
6. Keep responses scannable. He is glancing at the screen during a phone interview.
7. Give EXACTLY 3 answerOptions so he can pick a delivery style:
   - Style "safe": short, steady, low-risk answer (1–2 sentences).
   - Style "strong": lead with the best story/metric (SKED, 97% availability, $1.5M parts, CASREPs, BAE).
   - Style "honest": transparent about a gap + pivot to learning speed and transferable skill.
   Write each text in first person as Wyatt might say it. If an option doesn't fit the topic, still give the closest sensible version.
8. sayThis is the single best option (usually the "strong" one). talkingPoints has at most 3 bullets.

Return ONLY valid JSON matching this schema:
{
  "topic": string,
  "whyItMatters": string,
  "talkingPoints": string[],
  "sayThis": string,
  "answerOptions": [
    { "style": "safe" | "strong" | "honest", "text": string },
    { "style": "safe" | "strong" | "honest", "text": string },
    { "style": "safe" | "strong" | "honest", "text": string }
  ],
  "watchOut": string,
  "storyToUse": string,
  "confidence": "high" | "medium" | "low"
}`;
}
