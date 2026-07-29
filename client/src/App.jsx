import { useEffect, useRef, useState, useTransition } from "react";
import { startPcmCapture, wsUrl } from "./audio.js";

const SAMPLE_RATE = 16000;

export default function App() {
  const [tab, setTab] = useState("live");
  const [health, setHealth] = useState(null);
  const [prep, setPrep] = useState(null);
  const [candidate, setCandidate] = useState(null);
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [partial, setPartial] = useState("");
  const [utterances, setUtterances] = useState([]);
  const [briefs, setBriefs] = useState([]);
  const [briefLoading, setBriefLoading] = useState(false);
  const [, startTransition] = useTransition();

  const captureRef = useRef(null);
  const socketRef = useRef(null);
  const utterancesRef = useRef([]);
  const briefTimerRef = useRef(null);
  const lastBriefKeyRef = useRef("");

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

  useEffect(() => {
    utterancesRef.current = utterances;
  }, [utterances]);

  useEffect(() => {
    return () => {
      stopListening();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function requestBrief(forceText) {
    const windowText =
      forceText ||
      utterancesRef.current
        .slice(-6)
        .map((u) => u.text)
        .join("\n");

    const key = windowText.trim().slice(-280);
    if (key.length < 24 || key === lastBriefKeyRef.current) return;
    lastBriefKeyRef.current = key;
    setBriefLoading(true);

    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: windowText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Brief failed");
      startTransition(() => {
        setBriefs((prev) => [data, ...prev].slice(0, 12));
      });
    } catch (err) {
      setError(err.message || "Brief request failed");
    } finally {
      setBriefLoading(false);
    }
  }

  function queueBrief() {
    clearTimeout(briefTimerRef.current);
    briefTimerRef.current = setTimeout(() => {
      requestBrief();
    }, 700);
  }

  async function startListening() {
    setError("");
    setStatus("connecting");
    setPartial("");

    const socket = new WebSocket(wsUrl("/ws/stt"));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = async () => {
      setStatus("waiting-for-stt");
      try {
        captureRef.current = await startPcmCapture({
          sampleRate: SAMPLE_RATE,
          onFrame: (buffer) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(buffer);
            }
          },
          onError: (err) => setError(err.message),
        });
        setListening(true);
      } catch (err) {
        setError(
          err.message ||
            "Microphone access denied. Allow mic access, put the phone on speaker, and try again.",
        );
        setStatus("idle");
        socket.close();
      }
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "session.ready") {
        setStatus("listening");
      }
      if (msg.type === "error") {
        setError(msg.message);
        setStatus("error");
      }
      if (msg.type === "transcript") {
        if (!msg.isFinal) {
          setPartial(msg.text || "");
          return;
        }
        setPartial("");
        if (msg.text?.trim()) {
          const item = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            text: msg.text.trim(),
            speechFinal: Boolean(msg.speechFinal),
            at: new Date().toLocaleTimeString(),
          };
          setUtterances((prev) => [...prev, item].slice(-40));
          if (msg.speechFinal) queueBrief();
        }
      }
    };

    socket.onerror = () => {
      setError("WebSocket error — is the server running with XAI_API_KEY set?");
      setStatus("error");
    };

    socket.onclose = () => {
      setListening(false);
      setStatus((prev) => (prev === "error" ? prev : "idle"));
    };
  }

  async function stopListening() {
    clearTimeout(briefTimerRef.current);
    try {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "audio.done" }));
        socketRef.current.close();
      }
    } catch {
      /* ignore */
    }
    socketRef.current = null;
    if (captureRef.current) {
      await captureRef.current.stop();
      captureRef.current = null;
    }
    setListening(false);
    setPartial("");
    setStatus("idle");
  }

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
          className={tab === "prep" ? "active" : ""}
          onClick={() => setTab("prep")}
        >
          Interview prep
        </button>
      </nav>

      {tab === "live" ? (
        <section className="live">
          <div className="control-bar">
            <div>
              <p className="label">Phone interview capture</p>
              <p className="hint">
                Put the interviewer on speaker. This mic listens, xAI
                transcribes, and Grok briefs the topic as answers unfold.
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
            Status: {status.replaceAll("-", " ")}
            {listening ? " · mic open" : ""}
          </p>
          {error ? <p className="error">{error}</p> : null}

          <div className="live-grid">
            <div className="panel transcript-panel">
              <div className="panel-head">
                <h2>Transcript</h2>
                <button
                  className="ghost tiny"
                  onClick={() => {
                    setUtterances([]);
                    setBriefs([]);
                    setPartial("");
                    lastBriefKeyRef.current = "";
                  }}
                >
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
                <h2>Topic briefs</h2>
                {briefLoading ? <span className="pulse">Updating</span> : null}
              </div>
              <div className="briefs">
                {briefs.length === 0 ? (
                  <p className="empty">
                    After each complete utterance, Grok will surface what the
                    topic is really testing and how to deepen your answer.
                  </p>
                ) : null}
                {briefs.map((b, i) => (
                  <article key={`${b.at}-${i}`} className="brief">
                    <div className="brief-top">
                      <h3>{b.topic}</h3>
                      <span className={`conf conf-${b.confidence}`}>
                        {b.confidence}
                      </span>
                    </div>
                    <p className="why">{b.whyItMatters}</p>
                    <ul>
                      {b.talkingPoints.map((point) => (
                        <li key={point}>{point}</li>
                      ))}
                    </ul>
                    {b.sayThis ? (
                      <blockquote>“{b.sayThis}”</blockquote>
                    ) : null}
                    {b.storyToUse ? (
                      <p className="story-cue">Use story: {b.storyToUse}</p>
                    ) : null}
                    {b.watchOut ? (
                      <p className="watch">Watch out: {b.watchOut}</p>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : (
        <PrepView prep={prep} candidate={candidate} />
      )}
    </div>
  );
}

function PrepView({ prep, candidate }) {
  const [openQ, setOpenQ] = useState(0);
  const [openStory, setOpenStory] = useState(0);
  if (!prep) return <p className="empty">Loading prep…</p>;
  const { role, mustSell, preferred, likelyQuestions, technicalFlashcards, answerFormulas, questionsToAskThem, dayInLife } =
    prep;
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
        <p className="pay">{role.pay} · travel {role.travel}</p>
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
