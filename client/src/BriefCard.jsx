export default function BriefCard({ brief, hero = false }) {
  if (!brief) return null;
  return (
    <article className={`brief ${hero ? "brief-hero" : ""}`}>
      <div className="brief-top">
        <h3>{brief.topic}</h3>
        <span className={`conf conf-${brief.confidence}`}>
          {brief.confidence}
        </span>
      </div>
      {brief.sayThis ? (
        <blockquote className="say-this">“{brief.sayThis}”</blockquote>
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
