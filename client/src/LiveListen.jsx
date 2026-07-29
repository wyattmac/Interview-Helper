import BriefCard from "./BriefCard.jsx";
import { STATUS_LABELS } from "./useLiveCoach.js";

const CHEAT_STRIP = [
  "Safety / LOTO",
  "Symptom + alarms",
  "Power / air",
  "HMI · PLC · sensors",
  "Isolate",
  "Restore",
  "CMMS + radio",
];

export default function LiveListen({ coach }) {
  const {
    listening,
    status,
    error,
    partial,
    utterances,
    briefs,
    briefLoading,
    startListening,
    stopListening,
    requestBrief,
    clearTranscript,
    clearBriefs,
  } = coach;

  const hero = briefs[0];

  return (
    <section className="live">
      <div className="cheat-strip" aria-label="Troubleshooting spine">
        {CHEAT_STRIP.map((step, i) => (
          <span key={step}>
            {i > 0 ? "→ " : ""}
            {step}
          </span>
        ))}
      </div>

      <div className="control-bar">
        <div>
          <p className="label">Phone interview capture</p>
          <p className="hint">
            Put the interviewer on speaker. Grok briefs each topic as the
            answer unfolds.
          </p>
        </div>
        <div className="actions">
          {!listening ? (
            <button className="primary" onClick={startListening}>
              Start listening
            </button>
          ) : (
            <button className="danger" onClick={stopListening}>
              Stop
            </button>
          )}
          <button
            className="ghost"
            disabled={briefLoading || utterances.length === 0}
            onClick={() => requestBrief()}
          >
            {briefLoading ? "Briefing…" : "Brief now"}
          </button>
        </div>
      </div>

      <p className={`status status-${status}`}>
        {STATUS_LABELS[status] || status}
        {listening ? " · mic open" : ""}
      </p>
      {error ? <p className="error">{error}</p> : null}

      {hero ? (
        <div className="hero-coach">
          <div className="panel-head">
            <h2>Say this now</h2>
            {briefLoading ? <span className="pulse">Updating…</span> : null}
          </div>
          <BriefCard brief={hero} hero />
        </div>
      ) : null}

      <div className="live-grid">
        <div className="panel transcript-panel">
          <div className="panel-head">
            <h2>Transcript</h2>
            <button className="ghost tiny" onClick={clearTranscript}>
              Clear
            </button>
          </div>
          <div className="transcript">
            {utterances.length === 0 && !partial ? (
              <p className="empty">Waiting for speech…</p>
            ) : null}
            {utterances.map((u) => (
              <p key={u.id} className={u.speechFinal ? "final" : "chunk"}>
                <span className="time">{u.at}</span>
                {u.text}
              </p>
            ))}
            {partial ? <p className="partial">{partial}</p> : null}
          </div>
        </div>

        <div className="panel briefs-panel">
          <div className="panel-head">
            <h2>Coach history</h2>
            <button className="ghost tiny" onClick={clearBriefs}>
              Clear coach
            </button>
          </div>
          <div className="briefs">
            {briefs.length <= 1 ? (
              <p className="empty">
                Briefs will appear here as the interview unfolds.
              </p>
            ) : null}
            {briefs.slice(1).map((b, i) => (
              <BriefCard key={`${b.at}-${i}`} brief={b} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
