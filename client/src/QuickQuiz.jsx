import { useRef, useState } from "react";

export default function QuickQuiz({ cards }) {
  const [quiz, setQuiz] = useState(null); // { questions: [{q, term}] }
  const [current, setCurrent] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState(null);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  async function startQuiz() {
    setError("");
    setResult(null);
    setResults([]);
    setCurrent(0);
    setLoading(true);
    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms: cards.map((c) => c.term), count: 4 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Quiz failed");
      setQuiz(data);
      setAnswer("");
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch (err) {
      setError(err.message || "Could not start quiz");
    } finally {
      setLoading(false);
    }
  }

  async function submitAnswer() {
    const q = quiz.questions[current];
    setLoading(true);
    try {
      const res = await fetch("/api/quiz/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q.q,
          answer,
          term: q.term,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Grading failed");
      setResult(data);
      setResults((prev) => [...prev, { q: q.q, answer, ...data }]);
    } catch (err) {
      setError(err.message || "Could not grade");
    } finally {
      setLoading(false);
    }
  }

  function nextQuestion() {
    setResult(null);
    setAnswer("");
    setCurrent((c) => c + 1);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  if (!quiz) {
    return (
      <article className="panel quiz-panel">
        <div className="panel-head">
          <h3>Quick quiz</h3>
        </div>
        <p className="empty">
          Grok generates {4} rapid-fire questions from your flashcards (480V,
          PLC, pneumatics, CMMS…) and scores your answers. No prep needed —
          type like you'd talk.
        </p>
        {error ? <p className="error">{error}</p> : null}
        <button className="primary" disabled={loading} onClick={startQuiz}>
          {loading ? "Building quiz…" : "Start quick quiz"}
        </button>
      </article>
    );
  }

  const done = current >= quiz.questions.length;
  const score = results.length
    ? (results.reduce((n, r) => n + r.score, 0) / results.length).toFixed(1)
    : null;

  if (done) {
    return (
      <article className="panel quiz-panel">
        <div className="panel-head">
          <h3>Quiz results</h3>
          <span className={`conf ${Number(score) >= 4 ? "conf-high" : "conf-medium"}`}>
            avg {score} / 5
          </span>
        </div>
        <div className="q-list">
          {results.map((r, i) => (
            <div key={r.q} className="quiz-result">
              <strong>
                {i + 1}. {r.q}
              </strong>
              <span className={`score-chip score-${r.score}`}>{r.score}/5</span>
              <p className="muted">{r.feedback}</p>
            </div>
          ))}
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="primary" onClick={startQuiz}>
            New quiz
          </button>
        </div>
      </article>
    );
  }

  const question = quiz.questions[current];

  return (
    <article className="panel quiz-panel">
      <div className="panel-head">
        <h3>
          Quick quiz · {current + 1} / {quiz.questions.length}
        </h3>
        <span className="pulse">{loading ? "Working…" : ""}</span>
      </div>
      <p className="mock-question">{question.q}</p>

      {!result ? (
        <>
          <textarea
            ref={inputRef}
            className="quiz-input"
            rows={4}
            placeholder="Type your answer like you'd say it…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            disabled={loading}
          />
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              className="primary"
              disabled={loading || answer.trim().length < 5}
              onClick={submitAnswer}
            >
              {loading ? "Scoring…" : "Score it"}
            </button>
          </div>
        </>
      ) : (
        <div className="quiz-result">
          <span className={`score-chip score-${result.score}`}>
            {result.score}/5
          </span>
          <p>{result.feedback}</p>
          {result.keyPoints?.length ? (
            <ul>
              {result.keyPoints.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          ) : null}
          <button className="primary" onClick={nextQuestion}>
            {current + 1 >= quiz.questions.length ? "See results" : "Next question"}
          </button>
        </div>
      )}
      {error ? <p className="error">{error}</p> : null}
    </article>
  );
}
