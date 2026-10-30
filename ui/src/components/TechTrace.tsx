import { useEffect, useId, useMemo, useState } from "react";
import { fetchPastRuns } from "../api/pastRuns";
import { fetchRunSnapshot } from "../api/liveRun";
import { fetchWatchStatus } from "../api/watch";
import type { RecordedRun } from "../api/replay";
import { DOT_TEXT, type BoxId, type DotState } from "../lib/howItWorks";
import { getAwaitingRunId } from "../lib/lastRun";
import { buildTechTrace, GLOSSARY, pickRunRow, watchTile, type Tile, type TileId } from "../lib/techTrace";
import "../styles/techTrace.css";

function TileDetails({ tile }: { tile: Tile }) {
  return (
    <>
      <p className="tt-gloss">{tile.glossary}</p>
      {tile.details.length > 0 && (
        <dl className="tt-details">
          {tile.details.map((d, i) => (
            <div key={`${d.label}-${i}`}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

function useOpenSet() {
  const [open, setOpen] = useState<ReadonlySet<TileId>>(new Set());
  const toggle = (id: TileId) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return [open, toggle] as const;
}

/**
 * "How this answer was made": the Router line, the Judge result and four sponsor tiles, each opening its detail.
 * `embedded` drops the outer margin when it sits inside another disclosure (the calm answer's "Why").
 */
export function TechTrace({ run, caption, embedded }: { run: RecordedRun; caption?: string; embedded?: boolean }) {
  const model = useMemo(() => buildTechTrace(run), [run]);
  const uid = useId();
  const [open, toggle] = useOpenSet();
  return (
    <section className={embedded ? "tt tt-embedded" : "tt"} aria-label="How this answer was made">
      <p className="tt-title">How this answer was made{caption ? ` · ${caption}` : ""}</p>
      {(model.routerLine || model.judgeLine) && (
        <p className="tt-line">
          {model.routerLine}
          {model.routerLine && model.judgeLine ? " · " : ""}
          {model.judgeLine}
        </p>
      )}
      <ul className={model.tiles.length > 4 ? "tt-tiles tt-tiles-5" : "tt-tiles"}>
        {model.tiles.map((tile) => {
          const expanded = open.has(tile.id);
          return (
            <li key={tile.id} className={`tt-tile${tile.used ? "" : " tt-tile-idle"}${expanded ? " tt-tile-open" : ""}`} data-tile={tile.id}>
              <button
                type="button"
                className="tt-btn"
                aria-expanded={expanded}
                aria-controls={`${uid}-${tile.id}`}
                title={tile.glossary}
                onClick={() => toggle(tile.id)}
              >
                <span className="tt-name">{tile.name}</span>
                <span className="tt-head">{tile.headline}</span>
              </button>
              <div id={`${uid}-${tile.id}`} className="tt-panel" hidden={!expanded}>
                <TileDetails tile={tile} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The run the insurer Review page describes, in a collapsed disclosure. It is not the recording shown below it, and says so.
 * Live: the run awaiting review, else the newest finished run. Past: the newest run for the chosen event, or a note.
 */
export function LatestRunTechTrace({ mode = "live", eventId = null }: { mode?: "live" | "past"; eventId?: string | null }) {
  const [state, setState] = useState<{ run: RecordedRun | null; none: boolean }>({ run: null, none: false });
  useEffect(() => {
    const controller = new AbortController();
    setState({ run: null, none: false });
    void (async () => {
      let id = mode === "live" ? getAwaitingRunId() : null;
      if (!id) {
        const past = await fetchPastRuns(30, controller.signal);
        id = past.ok ? (pickRunRow(past.rows, mode, eventId)?.runId ?? null) : null;
      }
      if (controller.signal.aborted) return;
      if (!id) return setState({ run: null, none: mode === "past" });
      try {
        const snap = await fetchRunSnapshot(id, controller.signal);
        if (!controller.signal.aborted && snap.run) setState({ run: snap.run, none: false });
      } catch {
        /* no run to show: the panel stays hidden */
      }
    })();
    return () => controller.abort();
  }, [mode, eventId]);
  if (state.run) {
    return (
      <details className="disclosure tt-latest">
        <summary>How the latest run was made</summary>
        <TechTrace run={state.run} caption={`Latest run ${state.run.runId} (not the recording below)`} embedded />
      </details>
    );
  }
  return state.none ? <p className="note tt-note">No finished run for this past flood yet, so there is no run trace to show.</p> : null;
}

const OVERVIEW: { id: TileId; box: BoxId; name: string; line: string }[] = [
  { id: "zetaris", box: "zetaris", name: "Zetaris", line: "Every number is a SQL query with an id." },
  { id: "nightshift", box: "nightshift", name: "Meterless Nightshift", line: "Fast and deep lanes run Nemotron models." },
  { id: "hmem", box: "memory", name: "Meterless H-MEM", line: "Recalls approved findings and labelled demo seeds." },
  { id: "world", box: "memory", name: "Meterless World Model", line: "Tracks which hypotheses still hold." },
];

/** The same four tiles for the How it works page, each with the live status of its component and a glossary button. */
export function TechTraceOverview({ status }: { status: Record<BoxId, DotState> | null }) {
  const [watch, setWatch] = useState<ReturnType<typeof watchTile>>(() => watchTile(null));
  useEffect(() => {
    const controller = new AbortController();
    void fetchWatchStatus(controller.signal).then((r) => {
      if (!controller.signal.aborted) setWatch(watchTile(r.ok ? r.value : null));
    });
    return () => controller.abort();
  }, []);
  const uid = useId();
  const [open, toggle] = useOpenSet();
  return (
    <section className="tt" aria-label="Sponsor technology in every answer">
      <ul className="tt-tiles tt-tiles-5">
        {OVERVIEW.map((t) => {
          const state: DotState = status ? status[t.box] : "unknown";
          const expanded = open.has(t.id);
          return (
            <li key={t.id} className={`tt-tile${expanded ? " tt-tile-open" : ""}`} data-tile={t.id}>
              <button type="button" className="tt-btn" aria-expanded={expanded} aria-controls={`${uid}-${t.id}`} onClick={() => toggle(t.id)}>
                <span className="tt-name">
                  <span className={`hiw-dot hiw-dot-${state}`} aria-hidden="true" /> {t.name}
                </span>
                <span className="tt-head">{t.line}</span>
                <span className="tt-status">{DOT_TEXT[state]}</span>
              </button>
              <div id={`${uid}-${t.id}`} className="tt-panel" hidden={!expanded}>
                <p className="tt-gloss">{GLOSSARY[t.id]}</p>
              </div>
            </li>
          );
        })}
        <li className="tt-tile" data-tile="watch">
          <div className="tt-btn tt-plain">
            <span className="tt-name">
              <span className={`hiw-dot hiw-dot-${watch.state}`} aria-hidden="true" /> Control tower
            </span>
            <span className="tt-head">{watch.line}</span>
            <span className="tt-status">{DOT_TEXT[watch.state]}</span>
          </div>
        </li>
      </ul>
    </section>
  );
}
