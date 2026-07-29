import { useEffect, useRef, useState } from "react";
import BriefCard from "./BriefCard.jsx";
import Flashcards from "./Flashcards.jsx";
import QuickQuiz from "./QuickQuiz.jsx";
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
  const [recordState, setRecordState] = useState("idle"); // idle|recording|transcribing|grading|done
  const [answerTranscript, setAnswerTranscript] = useState("");
  const [grade, setGrade] = useState(null);
  const [scores, setScores] = useState([]); // { stepId, score }
  const audioRef = useRef(null);
  const coachAbortRef = useRef(null);
  const recordCaptureRef = useRef(null);
  const recordFramesRef = useRef([]);

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
      recordCaptureRef.current?.stop().catch(() => {});
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

  async function startRecording() {
    setError("");
    setGrade(null);
    setAnswerTranscript("");
    recordFramesRef.current = [];
    try {
      const { startPcmCapture } = await import("./audio.js");
      recordCaptureRef.current = await startPcmCapture({
        sampleRate: SAMPLE_RATE,
        onFrame: (buffer) => recordFramesRef.current.push(new Int16Array(buffer)),
        onError: (err) => setError(err.message),
      });
      setRecordState("recording");
    } catch (err) {
      setError(err.message || "Microphone access denied.");
    }
  }

  async function stopRecordingAndGrade() {
    setRecordState("transcribing");
    const capture = recordCaptureRef.current;
    recordCaptureRef.current = null;
    if (capture) await capture.stop();

    const frames = recordFramesRef.current;
    const total = frames.reduce((n, f) => n + f.length, 0);
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const frame of frames) {
      pcm.set(frame, offset);
      offset += frame.length;
    }
    recordFramesRef.current = [];

    if (pcm.length < SAMPLE_RATE * 1.5) {
      setRecordState("idle");
      setError("Answer too short — hold Record, answer for at least a few seconds, then Grade my answer.");
      return;
    }

    try {
      const wav = encodeWavForUpload(pcm, SAMPLE_RATE);
      const form = new FormData();
      form.append("format", "true");
      form.append("language", "en");
      form.append("file", new Blob([wav], { type: "audio/wav" }), "answer.wav");
      const sttRes = await fetch("/api/stt-file", { method: "POST", body: form });
      const stt = await sttRes.json();
      if (!sttRes.ok) throw new Error(stt.error || "Transcription failed");
      const text = (stt.text || "").trim();
      setAnswerTranscript(text);

      if (text.split(/\s+/).filter(Boolean).length < 4) {
        setRecordState("idle");
        setError("Couldn't make out an answer — check mic/speaker setup and try again.");
        return;
      }

      setRecordState("grading");
      const gradeRes = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: step.text, answer: text }),
      });
      const gradeData = await gradeRes.json();
      if (!gradeRes.ok) throw new Error(gradeData.error || "Grading failed");
      setGrade(gradeData);
      setScores((prev) => {
        const next = prev.filter((s) => s.stepId !== step.id);
        next.push({ stepId: step.id, score: gradeData.score });
        return next;
      });
      setRecordState("done");
    } catch (err) {
      setRecordState("idle");
      setError(err.message || "Could not grade answer");
    }
  }

  const average = scores.length
    ? (scores.reduce((n, s) => n + s.score, 0) / scores.length).toFixed(1)
    : null;

  return (
    <section className="mock">
      <div className="control-bar">
        <div>
          <p className="label">{script.title}</p>
          <p className="hint">
            Grok voice interviewer (<strong>{script.voiceId}</strong> /{" "}
            {script.interviewerName}). Answer out loud, then get graded.
          </p>
        </div>
        <div className="actions">
          <button
            className="primary"
            disabled={playing || recordState === "recording"}
            onClick={() => playStep(index)}
          >
            {playing ? "Speaking…" : "Ask this question"}
          </button>
          {recordState !== "recording" ? (
            <button
              className="ghost"
              disabled={playing || recordState === "transcribing" || recordState === "grading"}
              onClick={startRecording}
            >
              {recordState === "transcribing"
                ? "Transcribing…"
                : recordState === "grading"
                  ? "Grading…"
                  : "Record my answer"}
            </button>
          ) : (
            <button className="danger" onClick={stopRecordingAndGrade}>
              Grade my answer
            </button>
          )}
          <button
            className="ghost"
            disabled={playing || index === 0 || recordState === "recording"}
            onClick={() => {
              setCoach(null);
              setGrade(null);
              setAnswerTranscript("");
              setIndex((i) => Math.max(0, i - 1));
            }}
          >
            Previous
          </button>
          <button
            className="ghost"
            disabled={playing || atEnd || recordState === "recording"}
            onClick={() => {
              setCoach(null);
              setGrade(null);
              setAnswerTranscript("");
              setIndex((i) => Math.min(script.steps.length - 1, i + 1));
            }}
          >
            Next
          </button>
        </div>
      </div>

      {average ? (
        <p className="mock-score-line">
          Practice average: <strong>{average} / 5</strong> across{" "}
          {scores.length} graded answer{scores.length === 1 ? "" : "s"}
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      <div className="live-grid">
        <div className="panel">
          <div className="panel-head">
            <h2>
              Question {index + 1} / {script.steps.length}
            </h2>
            <span className="pulse">
              {playing
                ? "Grok speaking"
                : recordState === "recording"
                  ? "Recording your answer…"
                  : "Ready"}
            </span>
          </div>
          <p className="mock-question">“{step.text}”</p>
          <ol className="mock-steps">
            {script.steps.map((s, i) => {
              const graded = scores.find((x) => x.stepId === s.id);
              return (
                <li key={s.id}>
                  <button
                    className={`q-item ${i === index ? "open" : ""}`}
                    disabled={playing || recordState === "recording"}
                    onClick={() => {
                      setCoach(null);
                      setGrade(null);
                      setAnswerTranscript("");
                      setIndex(i);
                    }}
                  >
                    <strong>
                      {i + 1}. {s.id}
                      {graded ? (
                        <span className={`score-chip score-${graded.score}`}>
                          {graded.score}/5
                        </span>
                      ) : null}
                    </strong>
                    <span>{s.text}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>{grade ? "Your grade" : "Coach for this question"}</h2>
            {coachLoading ? <span className="pulse">Briefing…</span> : null}
          </div>
          {!coach && !coachLoading && !grade ? (
            <p className="empty">
              Hit <strong>Ask this question</strong>, then{" "}
              <strong>Record my answer</strong> and <strong>Grade my answer</strong>{" "}
              to see how it lands.
            </p>
          ) : null}
          {grade ? (
            <article className="brief brief-hero">
              <div className="brief-top">
                <h3>Score: {grade.score} / 5</h3>
                <span className={`conf conf-${grade.score >= 4 ? "high" : grade.score === 3 ? "medium" : "low"}`}>
                  {grade.score >= 4 ? "strong" : grade.score === 3 ? "ok" : "work on it"}
                </span>
              </div>
              <p className="why">{grade.verdict}</p>
              {grade.missed?.length ? (
                <>
                  <p className="story-cue">What you missed:</p>
                  <ul>
                    {grade.missed.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {grade.betterAnswer ? (
                <blockquote className="say-this">Try: “{grade.betterAnswer}”</blockquote>
              ) : null}
              {grade.coachingTip ? (
                <p className="watch">Tip: {grade.coachingTip}</p>
              ) : null}
              {answerTranscript ? (
                <details className="answer-review">
                  <summary>What Grok heard you say</summary>
                  <p>{answerTranscript}</p>
                </details>
              ) : null}
            </article>
          ) : (
            <BriefCard brief={coach} hero />
          )}
        </div>
      </div>
    </section>
  );
}

function encodeWavForUpload(pcm, sampleRate) {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer));
  return buffer;
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

        <Flashcards cards={technicalFlashcards} />

        <QuickQuiz cards={technicalFlashcards} />

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
