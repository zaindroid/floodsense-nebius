import { useConsole } from "../context/ConsoleContext";
import type { LiveEvidence } from "../lib/liveEvidence";
import { SafeLink } from "./SafeLink";

/** One numbered source badge, [n], that opens the right-side Evidence drawer on that data point. */
export function LiveSourceBadge({ n, evidence }: { n: number; evidence: LiveEvidence }) {
  const { openLiveEvidence } = useConsole();
  return (
    <button
      type="button"
      className="citation-marker src-badge src-badge-zetaris"
      aria-label={`Source ${n}: ${evidence.kind}, ${evidence.title}. Opens the evidence panel`}
      title={`${evidence.kind} · ${evidence.view}`}
      onClick={() => openLiveEvidence(evidence)}
    >
      {n}
    </button>
  );
}

function when(iso: string | null): string {
  if (!iso) return "not given by the view";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return iso.length === 10
    ? `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} (model day)`
    : `${d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

/** The drawer body for one live data point: pipeline, query id, times, licence, upstream link, notes. */
export function LiveEvidenceView({ evidence }: { evidence: LiveEvidence }) {
  return (
    <section aria-label={`Evidence for ${evidence.title}`}>
      <h3>{evidence.title}</h3>
      <p className="muted">
        {evidence.kind} · {evidence.freshness}
      </p>
      <h4 className="section-title">How we got it</h4>
      <ol className="live-pipeline">
        {evidence.pipeline.map((step, i) => (
          <li key={step}>
            {step}
            {i < evidence.pipeline.length - 1 && <span aria-hidden="true"> →</span>}
          </li>
        ))}
      </ol>
      <dl className="kv">
        <div>
          <dt>View</dt>
          <dd>{evidence.view}</dd>
        </div>
        <div>
          <dt>Zetaris query id</dt>
          <dd>{evidence.queryId ?? "not sent by the API for this read"}</dd>
        </div>
        {evidence.measuredAt && (
          <div>
            <dt>{evidence.timeLabel}</dt>
            <dd>{when(evidence.measuredAt)}</dd>
          </div>
        )}
        {evidence.freshness !== "Replay" && evidence.freshness !== "Run" && (
          <div>
            <dt>Fetched</dt>
            <dd>{when(evidence.fetchedAt)}</dd>
          </div>
        )}
        <div>
          <dt>Licence</dt>
          <dd>{evidence.licence}</dd>
        </div>
        {evidence.link && (
          <div>
            <dt>Upstream</dt>
            <dd>
              <SafeLink href={evidence.link.href}>{evidence.link.label}</SafeLink>
            </dd>
          </div>
        )}
      </dl>
      {evidence.notes.map((note) => (
        <p key={note} className="note">
          {note}
        </p>
      ))}
      {evidence.memories.length > 0 && (
        <>
          <h4 className="section-title">Memories used</h4>
          <ul className="mem-list">
            {evidence.memories.map((m, i) => (
              <li key={i}>
                <span className="src-chip src-chip-memory">{m.label}</span> {m.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
