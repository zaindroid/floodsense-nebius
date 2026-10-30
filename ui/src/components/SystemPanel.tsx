import { useEffect, useState } from "react";
import { fetchSystem } from "../api/system";
import { SEEDED_MEMORY_CHIP, seededMemoryNote } from "../lib/hitl";
import {
  SYSTEM_POLL_MS,
  countText,
  hitRate,
  laneLabel,
  liveSummary,
  modelName,
  shortUtc,
  type SystemStatus,
} from "../lib/system";

/** Insurer System page: polls GET /system every 5 s. Read-only. */
export function SystemPanel() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    // One request at a time: the next poll is scheduled only after this one settles,
    // and unmounting aborts the request in flight and the pending timer.
    const controller = new AbortController();
    let timer: number | undefined;
    const tick = async () => {
      const got = await fetchSystem(undefined, controller.signal);
      if (controller.signal.aborted || got.aborted) return;
      if (got.status) setStatus(got.status);
      setError(got.error);
      setCheckedAt(new Date());
      timer = window.setTimeout(() => void tick(), SYSTEM_POLL_MS);
    };
    void tick();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  return <SystemCards status={status} error={error} checkedAt={checkedAt} />;
}

/** The four cards. Pure, so tests render it without a network. */
export function SystemCards({
  status,
  error,
  checkedAt,
}: {
  status: SystemStatus | null;
  error: string | null;
  checkedAt: Date | null;
}) {
  return (
    <div className="page-stack system-page">
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {liveSummary(status, error)}
      </p>
      <p className="note system-intro">
        What the agents remember, what the cache and the rate limits are doing, and which models answer. Refreshes every 5
        seconds.
        {checkedAt ? ` Last checked ${checkedAt.toLocaleTimeString("en-GB")}.` : " Checking…"}
        {status?.since ? ` Counters since ${shortUtc(status.since)} (API start).` : ""}
      </p>
      {error && (
        <p className="status-note">
          {error}
          {status ? ". Showing the last answer." : ""}
        </p>
      )}
      <div className="system-grid">
        <MemoryCard status={status} />
        <CacheCard status={status} />
        <RateCard status={status} />
        <ModelsCard status={status} />
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MemoryCard({ status }: { status: SystemStatus | null }) {
  const m = status?.memory;
  return (
    <section className="card system-card" aria-label="Memory">
      <p className="section-label">Memory · H-MEM</p>
      <h2>{m?.count == null ? "Memory" : `${m.count} remembered finding${m.count === 1 ? "" : "s"}`}</h2>
      <p className="note">Approved findings the agents can recall next time a question is about the same flood.</p>
      {m && !m.ok && <p className="note">{m.error ?? "Engines not reachable."}</p>}
      {m && m.seeded > 0 && (
        <p className="note">
          {m.seeded} of the latest {m.latest.length} are <span className="chip chip--sample">seeded</span>: added by
          demo-seed before recording, not by an analyst.
        </p>
      )}
      {m && m.latest.length > 0 ? (
        <ul className="system-list">
          {m.latest.map((item) => (
            <li key={item.id || item.text}>
              <p className="system-text">
                {item.text}
                {seededMemoryNote(item) && <span className="note"> {seededMemoryNote(item)}</span>}
              </p>
              <p className="system-meta">
                {item.seeded && <span className="chip chip--sample">{seededMemoryNote(item) ? SEEDED_MEMORY_CHIP : "seeded"}</span>} run {item.runId ?? "–"} · approved{" "}
                {shortUtc(item.approvedAt)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        m?.ok && <p className="note">Nothing remembered yet. Approve a run and its findings land here.</p>
      )}
    </section>
  );
}

function CacheCard({ status }: { status: SystemStatus | null }) {
  const c = status?.cache;
  return (
    <section className="card system-card" aria-label="Cache">
      <p className="section-label">Cache · {c ? (c.backend === "redis" ? "Redis" : "in memory") : "–"}</p>
      <h2>{c ? `Hits ${hitRate(c.hits, c.misses)}` : "Cache"}</h2>
      <p className="note">
        A repeat of an approved question is answered from the cache and labelled “Cached answer · not live”.
        {c && !c.on ? " The semantic cache is off (FF_SEMANTIC_CACHE)." : ""}
      </p>
      <dl className="kpis">
        <Kpi label="Hits" value={String(c?.hits ?? "–")} />
        <Kpi label="Misses" value={String(c?.misses ?? "–")} />
        <Kpi label="Replays served" value={String(c?.replays ?? "–")} />
        <Kpi label="Cached answers" value={countText(c?.keys.cache ?? null)} />
        <Kpi label="Recordings (30 days)" value={countText(c?.keys.replay ?? null)} />
      </dl>
      {c && c.seededRuns.length > 0 && (
        <p className="system-meta">
          <span className="chip chip--sample">seeded</span> warmed for the demo: run {c.seededRuns.join(", ")}
        </p>
      )}
    </section>
  );
}

function RateCard({ status }: { status: SystemStatus | null }) {
  const r = status?.rateLimit;
  return (
    <section className="card system-card" aria-label="Rate limits">
      <p className="section-label">Rate limits</p>
      <h2>{r ? `${r.inFlight} of ${r.maxConcurrent} live runs in flight` : "Rate limits"}</h2>
      <p className="note">
        {r
          ? `Each client may start ${r.perMin} runs a minute, and at most ${r.maxConcurrent} run at once. Extra requests get “429, try again in N s”.`
          : "Keeps one client from crowding out the others."}
      </p>
      <dl className="kpis">
        <Kpi label="In flight" value={String(r?.inFlight ?? "–")} />
        <Kpi label="429s, last 5 min" value={String(r?.recent429 ?? "–")} />
        <Kpi label="429s since start" value={String(r?.total429 ?? "–")} />
      </dl>
    </section>
  );
}

function ModelsCard({ status }: { status: SystemStatus | null }) {
  const mo = status?.models;
  const e = status?.engines;
  const w = status?.world;
  const rag = status?.rag;
  const wmText = w?.runId
    ? `${w.hypotheses} hypotheses on run ${w.runId}: ${Object.entries(w.byStatus)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ") || "none yet"}`
    : "No board yet.";
  return (
    <section className="card system-card" aria-label="Models and engines">
      <p className="section-label">Models &amp; engines</p>
      <h2>{mo?.ok ? "Nightshift" : "Models"}</h2>
      <p className="note">Which language models answer, and whether the memory and World Model engines are up.</p>
      {mo?.ok ? (
        <ul className="system-list">
          {Object.entries(mo.lanes).map(([lane, id]) => (
            <li key={lane}>
              <p className="system-text">{laneLabel(lane, id)}</p>
            </li>
          ))}
          {mo.modelIds.length > 0 && (
            <li>
              <p className="system-text">Latest run answered by {mo.modelIds.map(modelName).join(", ")}</p>
            </li>
          )}
        </ul>
      ) : (
        status && <p className="note">Agents /config not reachable.</p>
      )}
      <p className="system-meta">
        <span className={`chip ${e?.ok ? "chip--live" : "chip--stale"}`}>
          engines {e ? (e.ok ? "up" : e.configured ? "down" : "not configured") : "–"}
        </span>{" "}
        World Model: {wmText}
      </p>
      <p className="system-meta">
        Document search (RAG): {rag?.enabled == null ? "–" : rag.enabled ? "on" : "off"}
        {rag && rag.documents !== null ? ` · ${rag.documents} documents, ${countText(rag.passages)} passages` : " · counts not exposed"}
      </p>
    </section>
  );
}
