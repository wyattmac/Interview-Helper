# Interview Helper · Optum Equipment Services Technician

Live phone-interview coach for **Equipment Services Technician (req 2372180)** at Optum / UnitedHealth Group in Charlotte, NC.

It listens through your laptop mic (put the phone on speaker), streams audio to **xAI Speech-to-Text**, then asks **Grok** to brief the topic as answers unfold — talking points, what the question is testing, and a short phrase you can use.

## Quick start

```bash
cp .env.example .env
# Put your key from https://console.x.ai/ into .env
npm install
npm run dev
```

- UI: [http://localhost:5173](http://localhost:5173)
- API/WS: [http://localhost:8787](http://localhost:8787)

Production-style local run:

```bash
npm run build
npm start
# open http://localhost:8787
```

## How to use during a phone screen

1. Open **Live listen** before the call.
2. Put the interviewer on **speaker** near your laptop mic (headphones on you if needed so your voice is quieter than theirs, or let it capture both).
3. Click **Start listening**.
4. Watch **Topic briefs** update after each complete utterance.
5. Use **Interview prep** beforehand for STAR shapes, flashcards, and likely questions.

Your `XAI_API_KEY` stays on the server. The browser never sees it; `/ws/stt` proxies to `wss://api.x.ai/v1/stt`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `XAI_API_KEY` | _(required)_ | xAI API key |
| `PORT` | `8787` | Server port |
| `XAI_MODEL` | `grok-4.3` | Chat model for live briefs (`reasoning_effort: none`) |
| `XAI_STT_SAMPLE_RATE` | `16000` | PCM sample rate sent to STT |

If the default model isn’t available on your account, set `XAI_MODEL` to another chat model from the [xAI console](https://console.x.ai/) (for example `grok-4.5`).

## Personalized for Wyatt Locklear

The coach is loaded with your resume history (`data/candidate-profile.json`):

- **Lead stories:** Navy Communications Electronics Supervisor on USS James E. Williams (SKED CMMS, 97% availability, CASREPs, $1.5M parts), BAE electronics tech with controlled procedures
- **Bridge:** SKED → their CMMS/SAP; watchstanding → 2nd-shift radio calls
- **Stay honest:** don’t invent Studio 5000 / pharmacy OEM hours; pivot to learning speed + real diagnostics

Prep tab shows your STAR stories and “Your version” answers for likely questions.

## Interview cheat-sheet (study this)

**Role facts to memorize**
- Onsite at **4015 Shopton Rd, Charlotte, NC 28217**
- **Sun–Thu**, **2:00 pm – 11:30 pm** (2nd shift, ~6% shift diff)
- Occasional **Saturday 6:00 am – 2:30 pm** and OT
- Pay band listed: **$29–$52/hr**
- Travel up to **10%**
- Mail-order pharmacy automation: electrical / mechanical / pneumatic / PLC

**Open every technical answer with this spine**
1. Make it safe (LOTO / PPE / e-stop awareness)
2. Name the symptom + alarms / last change
3. Check utilities (480V power, air, vacuum)
4. Read HMI / PLC faults and sensor states
5. Isolate mechanical vs electrical vs pneumatic vs controls
6. Restore, verify in manual then auto
7. Document in CMMS/SAP and radio the status

**Must-prove experience**
- 5+ years automated manufacturing / distribution maintenance
- 3-phase **480V**, conduit, motor controls
- CMMS or SAP work orders / parts / hours
- Fast radio response and sensor discipline
- Shift flexibility

**Preferred differentiator**
- Allen-Bradley / Rockwell, RSLogix / Studio 5000, HMI
- Beckhoff PLCs
- Robotics on packaging / pharmacy lines

## Project layout

```
client/          React UI (prep + live listen)
server/          Express API + xAI STT WebSocket proxy
data/job-prep.json   Role-specific prep content fed to the UI and Grok
```
