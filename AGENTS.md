# AGENTS.md

## Cursor Cloud specific instructions

Single Node.js product: a React/Vite frontend (`client/`, port 5173) plus an Express backend (`server/`, port 8787) that proxies to the xAI API. Dependencies are plain `npm`; see `package.json` scripts.

### Running

- Dev: `npm run dev` starts both the backend (`node --watch server/index.js` on 8787) and the Vite dev client on 5173 concurrently. Develop against the Vite UI at http://localhost:5173 — it proxies `/api` and `/ws` to 8787.
- Production-style local run: `npm run build` then `npm start`. The build emits to `dist/`; the server serves `dist/` statically on 8787 only when that folder exists.
- There is no lint script.

### XAI_API_KEY is required for core features

The flagship features — Live listen (STT via `/ws/stt`), Mock interview TTS + answer grading, Quick quiz, and `/api/brief` — all call the real xAI API and return HTTP 503 without a key. Provide it by copying `.env.example` to `.env` and setting `XAI_API_KEY` (get one at https://console.x.ai/). When missing, the server logs a warning, the UI key-pill shows "Add XAI_API_KEY", but the Interview prep tab and static endpoints (`/api/health`, `/api/job-prep`, `/api/candidate`, `/api/mock-interview`) still work fully.

### Tests (both require XAI_API_KEY and hit the live xAI API)

- `npm run smoke` — needs a running server + `ffmpeg` (preinstalled) + `XAI_API_KEY`.
- `npm run e2e` — Playwright browser test. `playwright` is NOT in `package.json`; install it separately (`npm install -D playwright`) before running. It launches Chrome from `/usr/local/bin/google-chrome` (override with `CHROME_PATH`) and expects the dev server at http://localhost:5173.
