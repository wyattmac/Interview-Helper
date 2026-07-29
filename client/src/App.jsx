import { useEffect, useRef, useState } from "react";
import BriefCard from "./BriefCard.jsx";
import LiveListen from "./LiveListen.jsx";
import { useLiveCoach } from "./useLiveCoach.js";

const SAMPLE_RATE = 16000;

export default function App() {
  const [tab, setTab] = useState("live");
  const [health, setHealth] = useState(null);
  const [prep, setPrep] = useState(null);
  const [candidate, setCandidate] = useState(null);
  const coach = useLiveCoach({ sampleRate: SAMPLE_RATE });

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false, hasApiKey: false }));

    fetch("/api/job-prep")
      .then((r) => r.json())
      .then(setPrep)
      .catch(() => setPrep(null));

    fetch("/api/candidate")
      .then((r) => r.json())
      .then(setCandidate)
      .catch(() => setCandidate(null));
  }, []);

  return (
    <div className="app">
      <div className="atmosphere" aria-hidden="true" />
      <header className="top">
        <div>
          <p className="brand">Interview Helper</p>
          <h1>Optum Equipment Services Technician</h1>
          <p className="sub">
            Live xAI listening coach for req <span>2372180</span> · Charlotte
            2nd shift
          </p>
        </div>
        <div className={`key-pill ${health?.hasApiKey ? "ok" : "warn"}`}>
          {health?.hasApiKey ? "xAI key ready" : "Add XAI_API_KEY"}
        </div>
      </header>

      <nav className="tabs" aria-label="Modes">
        <button
          className={tab === "live" ? "active" : ""}
          onClick={() => setTab("live")}
        >
          Live listen
        </button>
        <button
          className={tab === "mock" ? "active" : ""}
          onClick={() => setTab("mock")}
        >
          Mock interview
        </button>
        <button
          className={tab === "prep" ? "active" : ""}
          onClick={() => setTab("prep")}
        >
          Interview prep
        </button>
      </nav>

      {tab === "live" ? <LiveListen coach={coach} /> : null}

      {tab === "mock" ? <MockInterviewView /> : null}

      {tab === "prep" ? <PrepView prep={prep} candidate={candidate} /> : null}
    </div>
  );
}

function MockInterviewView() {
  const [script, setScript] = useState(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [coach, setCoach] = useState(null);
  const [coachLoading, setCoachLoading] = useState(false);
  const audioRef = useRef(null);
  const coachAbortRef = useRef(null);

  useEffect(() => {
    fetch("/api/mock-interview")
      .then((r) => r.json())
      .then(setScript)
      .catch(() => setError("Could not load mock interview script."));
  }, []);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      coachAbortRef.current?.abort();
    };
  }, []);

  if (!script) {
    return <p className="empty">{error || "Loading mock interview…"}</p>;
  }

  const step = script.steps[index];
  const atEnd = index >= script.steps.length - 1;

  async function coachForText(text) {
    coachAbortRef.current?.abort();
    const controller = new AbortController();
    coachAbortRef.current = controller;
    setCoachLoading(true);
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: `Interviewer asked: ${text}` }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Brief failed");
      setCoach(data);
    } catch (err) {
      if (err?.name !== "AbortError") {
        setError(err.message || "Coaching failed");
      }
    } finally {
      if (coachAbortRef.current === controller) setCoachLoading(false);
    }
  }

  async function playStep(stepIndex = index) {
    const current = script.steps[stepIndex];
    if (!current) return;
    setError("");
    setPlaying(true);
    setIndex(stepIndex);

    try {
      const res = await fetch("/api/mock-interview/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId: current.id }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `TTS failed (${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }
      const audio = new Audio(url);
      audioRef.current = audio;

      // Kick off coaching while the question is spoken.
      coachForText(current.text);

      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = () => reject(new Error("Audio playback failed"));
        audio.play().catch(reject);
      });

      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || "Could not play mock question");
    } finally {
      setPlaying(false);
    }
  }

  return (
    <section className="mock">
      <div className="control-bar">
        <div>
          <p className="label">{script.title}</p>
          <p className="hint">
            Grok voice interviewer (<strong>{script.voiceId}</strong> /{" "}
            {script.interviewerName}). {script.instructions}
          </p>
        </div>
        <div className="actions">
          <button
            className="primary"
            disabled={playing}
            onClick={() => playStep(index)}
          >
            {playing ? "Speaking…" : "Ask this question"}
          </button>
          <button
            className="ghost"
            disabled={playing || index === 0}
            onClick={() => {
              setCoach(null);
              setIndex((i) => Math.max(0, i - 1));
            }}
          >
            Previous
          </button>
          <button
            className="ghost"
            disabled={playing || atEnd}
            onClick={() => {
              setCoach(null);
              setIndex((i) => Math.min(script.steps.length - 1, i + 1));
            }}
          >
            Next
          </button>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="live-grid">
        <div className="panel">
          <div className="panel-head">
            <h2>
              Question {index + 1} / {script.steps.length}
            </h2>
            <span className="pulse">{playing ? "Grok speaking" : "Ready"}</span>
          </div>
          <p className="mock-question">“{step.text}”</p>
          <ol className="mock-steps">
            {script.steps.map((s, i) => (
              <li key={s.id}>
                <button
                  className={`q-item ${i === index ? "open" : ""}`}
                  disabled={playing}
                  onClick={() => {
                    setCoach(null);
                    setIndex(i);
                  }}
                >
                  <strong>
                    {i + 1}. {s.id}
                  </strong>
                  <span>{s.text}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Coach for this question</h2>
            {coachLoading ? <span className="pulse">Briefing…</span> : null}
          </div>
          {!coach && !coachLoading ? (
            <p className="empty">
              Hit <strong>Ask this question</strong> to hear Grok voice and get
              a live brief (SKED, Navy supervisor stories, honest PLC pivot).
            </p>
          ) : null}
          <BriefCard brief={coach} hero />
        </div>
      </div>
    </section>
  );
}

function PrepView({ prep, candidate }) {
  const [openQ, setOpenQ] = useState(0);
  const [openStory, setOpenStory] = useState(0);
  if (!prep) return <p className="empty">Loading prep…</p>;
  const {
    role,
    mustSell,
    preferred,
    likelyQuestions,
    technicalFlashcards,
    answerFormulas,
    questionsToAskThem,
    dayInLife,
  } = prep;
  const answersByQ = new Map(
    (candidate?.personalizedAnswers || []).map((a) => [a.q, a.yourAnswer]),
  );

  return (
    <section className="prep">
      <div className="prep-hero">
        <p className="eyebrow">{role.company}</p>
        <h2>{role.title}</h2>
        <p>
          {role.location} · {role.schedule}
        </p>
        <p className="pay">
          {role.pay} · travel {role.travel}
        </p>
        {candidate ? (
          <p className="candidate-line">
            Coaching for <strong>{candidate.name}</strong> — lead with Navy
            Communications Electronics Supervisor + SKED CMMS + BAE electronics;
            be honest on AB/Studio 5000 depth.
          </p>
        ) : null}
      </div>

      <div className="prep-grid">
        {candidate ? (
          <article className="panel wide">
            <h3>Your proof points</h3>
            <div className="proof-grid">
              <div>
                <h4>Lead with these</h4>
                <ul>
                  {candidate.bridgeLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h4>Stay honest</h4>
                <ul className="muted-list">
                  {candidate.honestGaps.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              </div>
            </div>
          </article>
        ) : null}

        {candidate?.starStories ? (
          <article className="panel wide">
            <h3>Your STAR stories</h3>
            <div className="q-list">
              {candidate.starStories.map((story, idx) => (
                <button
                  key={story.id}
                  className={`q-item ${openStory === idx ? "open" : ""}`}
                  onClick={() => setOpenStory(idx)}
                >
                  <strong>{story.title}</strong>
                  <span className="tags">
                    Best for: {story.useFor.join(" · ")}
                  </span>
                  {openStory === idx ? (
                    <span>
                      <em>S:</em> {story.star.situation}
                      <br />
                      <em>T:</em> {story.star.task}
                      <br />
                      <em>A:</em> {story.star.action}
                      <br />
                      <em>R:</em> {story.star.result}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </article>
        ) : null}

        <article className="panel">
          <h3>Sell these hard</h3>
          <ul>
            {mustSell.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <h4>Preferred edge</h4>
          <ul className="muted-list">
            {preferred.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h3>Day-in-the-life language</h3>
          <ul>
            {dayInLife.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>

        <article className="panel wide">
          <h3>Likely questions</h3>
          <div className="q-list">
            {likelyQuestions.map((item, idx) => (
              <button
                key={item.q}
                className={`q-item ${openQ === idx ? "open" : ""}`}
                onClick={() => setOpenQ(idx)}
              >
                <strong>{item.q}</strong>
                {openQ === idx ? (
                  <span>
                    <em>What they want:</em> {item.intent}
                    <br />
                    <em>Answer shape:</em> {item.starHint}
                    {answersByQ.get(item.q) ? (
                      <>
                        <br />
                        <em>Your version:</em> {answersByQ.get(item.q)}
                      </>
                    ) : null}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </article>

        <article className="panel">
          <h3>Technical flashcards</h3>
          <div className="cards-stack">
            {technicalFlashcards.map((card) => (
              <div key={card.term} className="flash">
                <strong>{card.term}</strong>
                <p>{card.talkTrack}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <h3>Formulas & closer questions</h3>
          {answerFormulas.map((f) => (
            <div key={f.name} className="formula">
              <strong>{f.name}</strong>
              <ol>
                {f.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
          <h4>Ask them</h4>
          <ul>
            {questionsToAskThem.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  );
}
