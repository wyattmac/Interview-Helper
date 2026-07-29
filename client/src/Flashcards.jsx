import { useState } from "react";

export default function Flashcards({ cards }) {
  const [flipped, setFlipped] = useState(() => new Set());
  const [marks, setMarks] = useState({}); // term -> "know" | "unsure"

  const known = Object.values(marks).filter((v) => v === "know").length;
  const unsure = Object.values(marks).filter((v) => v === "unsure").length;

  function flip(term) {
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(term)) next.delete(term);
      else next.add(term);
      return next;
    });
  }

  function mark(term, value) {
    setMarks((prev) => ({ ...prev, [term]: value }));
    setFlipped((prev) => {
      const next = new Set(prev);
      next.delete(term);
      return next;
    });
  }

  return (
    <article className="panel">
      <div className="panel-head">
        <h3>Technical flashcards</h3>
        <span className="flash-progress">
          {known} know · {unsure} unsure · {cards.length - known - unsure} left
        </span>
      </div>
      <div className="cards-stack">
        {cards.map((card) => {
          const isFlipped = flipped.has(card.term);
          const markValue = marks[card.term];
          return (
            <div
              key={card.term}
              className={`flash flash-quiz ${markValue ? `marked-${markValue}` : ""}`}
            >
              <button className="flash-face" onClick={() => flip(card.term)}>
                <strong>{card.term}</strong>
                <p>{isFlipped ? card.talkTrack : "Tap to reveal the talk track…"}</p>
              </button>
              {isFlipped ? (
                <div className="flash-marks">
                  <button
                    className="ghost tiny know"
                    onClick={() => mark(card.term, "know")}
                  >
                    I know this
                  </button>
                  <button
                    className="ghost tiny unsure"
                    onClick={() => mark(card.term, "unsure")}
                  >
                    Still shaky
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </article>
  );
}
