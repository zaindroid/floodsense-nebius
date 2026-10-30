import { useMemo, useState } from "react";
import type { LiveWatch } from "../hooks/useLiveWatch";
import type { WatchSource } from "../lib/euWatch";
import { evidenceForSource, type LiveEvidence, type ViewMeta } from "../lib/liveEvidence";
import { basisLabel, calmSentence, plainOf, timeWord, worstFirst, type StatusView } from "../lib/places";
import { LiveSourceBadge } from "./LiveSources";

/** Query id and fetch time of the view behind one source kind. */
export function metaFor(live: Pick<LiveWatch, "gauges" | "euWatch" | "hazard">, kind: WatchSource["kind"]): ViewMeta {
  if (kind === "gauge") {
    const g = live.gauges as { queryId?: string | null; executedAt?: string | null; fetchedAt?: number };
    return { queryId: g.queryId ?? null, executedAt: g.executedAt ?? null, fetchedAt: g.fetchedAt ?? null };
  }
  if (kind === "model") return { queryId: live.euWatch.queryId, executedAt: live.euWatch.executedAt, fetchedAt: live.euWatch.fetchedAt };
  return live.hazard.state === "ready"
    ? { queryId: live.hazard.data.queryId, executedAt: live.hazard.data.executedAt, fetchedAt: live.hazard.fetchedAt }
    : { queryId: null };
}

export function evidenceFor(live: Pick<LiveWatch, "gauges" | "euWatch" | "hazard">, s: WatchSource): LiveEvidence {
  return evidenceForSource(s, metaFor(live, s.kind));
}

export function StatusChip({ view, large }: { view: StatusView; large?: boolean }) {
  return <span className={`plain-chip plain-chip--${view.tone}${large ? " plain-chip--lg" : ""}`}>{view.word}</span>;
}

/** "Measured 27 Oct, 10:15 UTC" for a gauge; "Modelled …" for a model hour; "Modelled for 27 Oct" for a model day. */
export function timeText(kind: WatchSource["kind"], iso: string | null): string {
  const word = timeWord(kind);
  if (!iso) return `${word}: time not given by the view`;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return `${word} ${iso}`;
  return iso.length === 10
    ? `${word} for ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`
    : `${word} ${d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

/** "Rhine · Köln", or just the name when the source has no river (Valencia points). */
export function sourceTitle(s: WatchSource): string {
  return s.river ? `${s.river} · ${s.name}` : s.name;
}

/** One row: plain status, one calm line, a numbered source; the number itself only under Details. */
export function PlaceRow({ s, n, live, onAsk }: { s: WatchSource; n: number; live: LiveWatch; onAsk?: (s: WatchSource) => void }) {
  const view = plainOf(s);
  return (
    <li className={`ptw-row ptw-row--${view.tone}`}>
      <div className="ptw-row__head">
        <StatusChip view={view} />
        <strong className="ptw-row__name">{sourceTitle(s)}</strong>
        <span className="muted small">{s.country}</span>
      </div>
      <p className="ptw-row__line">
        {calmSentence(s.kind, s.status, s.river, s.name)} <LiveSourceBadge n={n} evidence={evidenceFor(live, s)} />
      </p>
      <details className="disclosure ptw-row__details">
        <summary>Details</summary>
        <p className="note">
          {s.value} · {basisLabel(s.kind)} · {timeText(s.kind, s.measuredAt)} · {s.live ? "live" : "not live (stale or seed)"}
        </p>
        {onAsk && (
          <button type="button" className="link-button" onClick={() => onAsk(s)}>
            Ask FloodSense about {s.name}
          </button>
        )}
      </details>
    </li>
  );
}

const SHORT = 8;

/** "Places to watch": worst first, short by default, all on request. */
export function PlacesToWatch({
  live,
  onAsk,
  limit = SHORT,
  title = "Places to watch",
  start = 1,
  exclude,
}: {
  live: LiveWatch;
  onAsk?: (s: WatchSource) => void;
  limit?: number;
  title?: string;
  /** First source number, so badges stay unique on a page that already shows [1]. */
  start?: number;
  /** Source id already shown above (the chosen place). */
  exclude?: string | null;
}) {
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => worstFirst(live.sources.filter((s) => s.id !== exclude)), [live.sources, exclude]);
  const shown = all ? sorted : sorted.slice(0, limit);
  if (sorted.length === 0) return <p className="note">No live readings yet.</p>;
  return (
    <section className="ptw" aria-label={title}>
      <h3 className="section-title">{title}</h3>
      <ol className="ptw-list">
        {shown.map((s, i) => (
          <PlaceRow key={s.id} s={s} n={start + i} live={live} onAsk={onAsk} />
        ))}
      </ol>
      {sorted.length > limit && (
        <button type="button" className="button ghost" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${sorted.length} places`}
        </button>
      )}
    </section>
  );
}
