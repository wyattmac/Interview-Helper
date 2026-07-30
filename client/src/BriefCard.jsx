import { useState } from "react";

const STYLE_LABELS = {
  safe: "Safe",
  strong: "Strong",
  honest: "Honest pivot",
};

export default function BriefCard({ brief, hero = false }) {
  const options = brief?.answerOptions || [];
  const [picked, setPicked] = useState(null);
  const selected = options.find((o) => o.style === picked);

  if (!brief) return null;

  return (
    <article className={`brief ${hero ? "brief-hero" : ""}`}>
      <div className="brief-top">
        <h3>{brief.topic}</h3>
        <span className={`conf conf-${brief.confidence}`}>
          {brief.confidence}
        </span>
      </div>

      {options.length ? (
        <div className="answer-options" role="group" aria-label="Answer styles">
          {options.map((option) => (
            <button
              key={option.style}
              className={`option ${picked === option.style ? "picked" : ""} option-${option.style}`}
              onClick={() => setPicked(option.style)}
            >
              <span className="option-label">{STYLE_LABELS[option.style]}</span>
              <span className="option-text">“{option.text}”</span>
            </button>
          ))}
        </div>
      ) : brief.sayThis ? (
        <blockquote className="say-this">“{brief.sayThis}”</blockquote>
      ) : null}

      {selected ? (
        <p className="picked-note">
          Go with the <strong>{STYLE_LABELS[selected.style]}</strong> one.
        </p>
      ) : null}

      {brief.talkingPoints?.length ? (
        <ul>
          {brief.talkingPoints.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      ) : null}
      {brief.storyToUse ? (
        <p className="story-cue">Use story: {brief.storyToUse}</p>
      ) : null}
      {brief.watchOut ? (
        <p className="watch">Watch out: {brief.watchOut}</p>
      ) : null}
      {brief.whyItMatters ? <p className="why">{brief.whyItMatters}</p> : null}
    </article>
  );
}
