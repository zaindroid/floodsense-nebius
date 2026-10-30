import { useEffect, useMemo, useState } from "react";
import "../styles/controlTower.css";
import { useConsole } from "../context/ConsoleContext";
import { useControlTower } from "../hooks/useControlTower";
import { useLiveWatch } from "../hooks/useLiveWatch";
import {
  AGENTS,
  AGENT_ROLE,
  AUTO_ASSESS_LABEL,
  HONEST_LABEL,
  askQuestionFor,
  canOpenApprovals,
  collapseRepeats,
  capsText,
  elapsedText,
  eventNumber,
  eventTime,
  evidenceForEvent,
  filterEvents,
  hasSource,
  hhmm,
  loopState,
  placeOptions,
  repeatNote,
  tiles,
  unreachableText,
  DEMO_LIVE_DOWN_HINT,
  type FeedFilter,
  type WatchAgent,
  type WatchEvent,
} from "../lib/controlTower";
import { headlineCounts } from "../lib/places";
import { setAwaitingRunId } from "../lib/lastRun";
import { EuWatchLegend, EuWatchMap } from "./EuWatch";
import { LiveSourceBadge } from "./LiveSources";
import { SwitchToLive } from "./ModeSwitch";

const ICONS: Record<WatchAgent, string> = {
  Watch: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  Forecast: "M7 18a4 4 0 0 1-.4-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9H7Zm1 3 1-2m4 2 1-2m4 2 1-2",
  Exposure: "M4 21V8l8-5 8 5v13M9 21v-6h6v6M8 10h.01M12 10h.01M16 10h.01",
  Playbook: "M8 4h8l2 2v14H6V6l2-2Zm1 6h6m-6 4h6m-6 4h4",
  Judge: "M12 3v18M5 7h14M5 7l-2 6a3 3 0 0 0 4 0L5 7Zm14 0-2 6a3 3 0 0 0 4 0l-2-6ZM8 21h8",
  Human: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0",
};

function AgentIcon({ agent }: { agent: WatchAgent }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="ct-icon">
      <path d={ICONS[agent]} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Seconds since a moment, ticking once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

/**
 * Control tower: the watch loop made visible. A rule-based loop in the agents service (no model calls) scans
 * every source, checks the forecast and the exposure of anything raised, and waits for a person. This page shows
 * what it found as it happens. Insurers can scan now, switch auto-assess and open Approvals; citizens get the
 * same page read-only ("How we watch").
 */
export function ControlTower() {
  const { mode } = useConsole();
  if (mode === "past")
    return (
      <SwitchToLive title="The Control tower watches live data">
        The watch loop scans the live sources and has no past form. Switch to Live to see it, or open Replay for the past flood.
      </SwitchToLive>
    );
  return <ControlTowerBody />;
}

function ControlTowerBody() {
  const { route, openAsk, setDemo } = useConsole();
  const readOnly = route === "citizen";
  const live = useLiveWatch();
  const ct = useControlTower();
  const [filter, setFilter] = useState<FeedFilter>({ agent: "all", place: "all" });
  const state = loopState({ reachable: ct.reachable, status: ct.status, demo: ct.mode === "demo" });
  const clock = useNow(state === "first");

  const counts = useMemo(() => headlineCounts(live.sources), [live.sources]);
  const t = tiles(ct.status, {
    watched: live.sources.length,
    elevated: counts.gaugesAbove + counts.gaugesNear + counts.modelElevated + counts.modelWatch,
  });
  const visible = useMemo(() => filterEvents(collapseRepeats(ct.events), filter), [ct.events, filter]);
  const places = useMemo(() => placeOptions(ct.events), [ct.events]);
  const awaiting = ct.status?.awaiting_run_ids ?? [];
  const auto = ct.status?.auto_assess ?? null;
  const showingDemo = ct.mode === "demo" && ct.demo !== null;

  const openApprovals = (runId: string) => {
    setAwaitingRunId(runId);
    window.location.hash = "#/insurer/approvals";
  };

  return (
    <div className="ct page-stack">
      <header className="now-head">
        <div>
          <h2 className="now-title">{readOnly ? "How we watch" : "Control tower"}</h2>
          <p className="ct-honest">{HONEST_LABEL}</p>
        </div>
        {!readOnly && (
          <div className="button-row">
            <button type="button" className="now-refresh" onClick={ct.scanNow} disabled={ct.scanning || state === "down" || ct.mode === "demo"}>
              {ct.scanning ? "Scanning…" : "Scan now"}
            </button>
          </div>
        )}
      </header>
      {ct.scanNote && (
        <p className="note" role="status">
          {ct.scanNote}
        </p>
      )}

      {ct.status && !ct.status.persisted && (
        <p className="note" role="status">
          Not saved between restarts on this server.{ct.status.persisted_reason ? ` ${ct.status.persisted_reason}` : ""}
        </p>
      )}

      <section aria-label="Watch summary" className="ct-tiles-wrap">
        <dl className="kpis ct-tiles">
          <div>
            <dt>Sources watched</dt>
            <dd>{t.watched}</dd>
          </div>
          <div>
            <dt>Elevated</dt>
            <dd>{t.elevated}</dd>
          </div>
          <div>
            <dt>Last scan</dt>
            <dd>{t.lastScan === "not yet" ? "not yet" : `${t.lastScan} UTC`}</dd>
          </div>
          <div>
            <dt>Runs awaiting approval</dt>
            <dd>{t.awaiting}</dd>
          </div>
          <div>
            <dt>Auto-assess</dt>
            <dd>{t.autoAssess}</dd>
          </div>
        </dl>
      </section>

      {state === "down" && (
        <section className="card ct-state ct-state--down" role="alert">
          <p>{unreachableText(ct.mode)}</p>
          <div className="button-row">
            <button type="button" className="now-refresh" onClick={ct.reload}>
              Try again
            </button>
            {!showingDemo && (
              <button type="button" className="now-refresh" onClick={() => setDemo(true)}>
                Show demo data
              </button>
            )}
          </div>
        </section>
      )}
      {showingDemo && ct.demo && (
        <p className="ct-state ct-state--demo" role="status">
          Demo data, not live: recorded from a real scan at {hhmm(ct.demo.recordedAt)} UTC on {ct.demo.recordedAt.slice(0, 10)}. {ct.demo.note}
        </p>
      )}
      {showingDemo && ct.liveDown && <p className="note">{DEMO_LIVE_DOWN_HINT}</p>}
      {state === "loading" && ct.reachable === null && (
        <p className="ct-state" role="status">
          Connecting to the watch loop…
        </p>
      )}
      {state === "first" && (
        <p className="ct-state" role="status">
          First scan running… {elapsedText(ct.status?.started_at, clock)} elapsed. The loop reads the gauges and models, then checks the forecast
          and the exposure of anything raised.
        </p>
      )}
      {state === "off" && (
        <p className="ct-state" role="status">
          The watch loop is switched off on this server (FF_WATCH_LOOP=false).
          {readOnly ? "" : " Press Scan now to run one scan by hand."}
        </p>
      )}

      <div className="ct-grid">
        <section className="card ct-map" aria-labelledby="ct-map-title">
          <h3 className="now-subtitle" id="ct-map-title">
            Europe · {live.sources.length || 45} sources
          </h3>
          <EuWatchMap sources={live.sources} />
          <details className="disclosure">
            <summary>How we colour the map</summary>
            <p className="note">
              Circles are river gauges against their long-term mean high water (not a warning level). Diamonds and squares are model points: a model,
              not an official warning. Nothing is red.
            </p>
            <EuWatchLegend />
          </details>
        </section>

        <section className="card ct-feed" aria-labelledby="ct-feed-title">
          <div className="ct-feed__head">
            <h3 className="now-subtitle" id="ct-feed-title">
              Activity
            </h3>
            <span className={`ct-pill ${ct.streaming ? "ct-pill--on" : ""}`}>{ct.streaming ? "Live feed" : showingDemo ? "Recorded" : "Polling"}</span>
          </div>

          <div className="ct-filters">
            <label>
              <span className="sr-only">Filter by agent</span>
              <select value={filter.agent} onChange={(e) => setFilter({ ...filter, agent: e.target.value as FeedFilter["agent"] })} aria-label="Filter by agent">
                <option value="all">All agents</option>
                {AGENTS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Filter by place</span>
              <select value={filter.place} onChange={(e) => setFilter({ ...filter, place: e.target.value })} aria-label="Filter by place">
                <option value="all">All places</option>
                {places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!readOnly && (
            <div className="ct-auto">
              <label className="ct-switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={!!auto?.enabled}
                  disabled={ct.switching || !auto || !!auto.blocked || state === "down" || ct.mode === "demo"}
                  onChange={(e) => ct.setAutoAssess(e.target.checked)}
                />
                <span>{AUTO_ASSESS_LABEL}</span>
              </label>
              <p className="note">{capsText(auto)}</p>
            </div>
          )}

          <p className="sr-only" role="status" aria-live="polite">
            {ct.announce}
          </p>

          {visible.length === 0 ? (
            <p className="note ct-empty">
              {ct.events.length === 0 ? "No activity yet. The first scan writes here." : "Nothing matches this filter."}
            </p>
          ) : (
            <ol className="ct-list" aria-label="Activity feed, newest first">
              {visible.map((e) => (
                <FeedRow
                  key={e.id}
                  e={e}
                  isNew={ct.fresh.has(e.id)}
                  approvals={!readOnly && canOpenApprovals(e, awaiting)}
                  onApprovals={() => e.run_id && openApprovals(e.run_id)}
                  onAsk={() => openAsk(askQuestionFor(e), { page: "control-tower", place: e.place })}
                />
              ))}
            </ol>
          )}
        </section>
      </div>
      <p className="note ct-foot">
        Gauges: Quelle WSV, PEGELONLINE (DL-DE-Zero-2.0). Models: Weather data by Open-Meteo.com (GloFAS, DWD ICON; CC BY 4.0). Sites: synthetic demo portfolio.
        Nothing here is an official warning, and nothing is sent without a person.
      </p>
    </div>
  );
}

function FeedRow({
  e,
  isNew,
  approvals,
  onApprovals,
  onAsk,
}: {
  e: WatchEvent;
  isNew: boolean;
  approvals: boolean;
  onApprovals: () => void;
  onAsk: () => void;
}) {
  const n = eventNumber(e.id);
  return (
    <li className={`ct-event ct-event--${e.tone}${isNew ? " ct-event--new" : ""}`} data-kind={e.kind} data-agent={e.agent}>
      <div className="ct-event__who" title={`${e.agent} ${AGENT_ROLE[e.agent]}`}>
        <AgentIcon agent={e.agent} />
        <strong>{e.agent}</strong>
        <time className="muted small" dateTime={e.ts}>
          {eventTime(e.ts)}
        </time>
      </div>
      <p className="ct-event__text">
        {e.text}{" "}
        {repeatNote(e) && <span className="muted small ct-event__repeat">{repeatNote(e)}</span>}{" "}
        {hasSource(e) && (
          <LiveSourceBadge n={n} evidence={evidenceForEvent(e)} />
        )}
      </p>
      {e.detail && (
        <details className="ct-event__detail small">
          <summary className="muted">Technical detail</summary>
          <pre>{e.detail}</pre>
        </details>
      )}
      <p className="ct-event__meta small">
        {e.place && (
          <span className="ct-event__place">
            {e.river ? `${e.river} · ` : ""}
            {e.place}
            {e.country ? ` (${e.country})` : ""}
          </span>
        )}
        {e.status && <span className={`plain-chip plain-chip--${e.tone}`}>{e.status}</span>}
        {approvals && (
          <button type="button" className="link-button" onClick={onApprovals}>
            Open in Approvals
          </button>
        )}
        {e.place && (
          <button type="button" className="link-button" onClick={onAsk}>
            Ask the agents
          </button>
        )}
      </p>
    </li>
  );
}
