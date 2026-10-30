/** GET /system, read-only status of memory, cache, rate limits and models. See api/app/system.py. */

export const SYSTEM_POLL_MS = 5000;

export interface SystemMemoryItem {
  id: string;
  runId: string | null;
  approvedAt: string | null;
  text: string;
  seeded: boolean;
}

export interface SystemStatus {
  since: string | null;
  memory: { ok: boolean; count: number | null; seeded: number; latest: SystemMemoryItem[]; error: string | null };
  cache: {
    backend: string;
    on: boolean;
    hits: number;
    misses: number;
    replays: number;
    keys: { cache: number | null; replay: number | null; demo: number | null };
    seededRuns: string[];
  };
  rateLimit: { perMin: number; maxConcurrent: number; inFlight: number; recent429: number; total429: number };
  engines: { configured: boolean; ok: boolean; error: string | null; wmEvents: number | null };
  world: { runId: string | null; hypotheses: number; byStatus: Record<string, number> };
  models: { ok: boolean; lanes: Record<string, string>; modelIds: string[] };
  rag: { enabled: boolean | null; documents: number | null; passages: number | null };
  /** GET /system views_cache.views: per view reads and its last upstream error. null when the API does not report it. */
  viewsCache: Record<string, ViewReads> | null;
}

export interface ViewReads {
  hits: number;
  misses: number;
  staleServes: number;
  lastError: { at: string; detail: string } | null;
  /** Last successful upstream read (ISO); null when none yet. */
  lastOkAt: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Normalise the body. Missing or wrong-typed fields become empty, never a throw. */
export function parseSystem(body: unknown): SystemStatus | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = obj(body);
  const mem = obj(b.memory);
  const cache = obj(b.cache);
  const keys = obj(cache.keys);
  const rl = obj(b.rate_limit);
  const eng = obj(b.engines);
  const wm = obj(b.world_model);
  const models = obj(b.models);
  const rag = obj(b.rag);
  const viewStats = b.views_cache === undefined ? null : obj(obj(b.views_cache).views);
  const latest = (Array.isArray(mem.latest) ? mem.latest : []).map(obj).map((m) => ({
    id: str(m.id) ?? "",
    runId: str(m.run_id),
    approvedAt: str(m.approved_at),
    text: str(m.text) ?? "",
    seeded: m.seeded === true,
  }));
  const lanes: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(models.lanes))) if (typeof v === "string") lanes[k] = v;
  const byStatus: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(wm.by_status))) if (typeof v === "number") byStatus[k] = v;
  return {
    since: str(b.counters_since_utc),
    memory: {
      ok: mem.ok === true,
      count: num(mem.count),
      seeded: num(mem.seeded) ?? latest.filter((m) => m.seeded).length,
      latest,
      error: str(mem.error),
    },
    cache: {
      backend: str(cache.backend) ?? "unknown",
      on: cache.semantic_cache === true,
      hits: num(cache.hits) ?? 0,
      misses: num(cache.misses) ?? 0,
      replays: num(cache.replays_served) ?? 0,
      keys: { cache: num(keys.cache), replay: num(keys.replay), demo: num(keys.demo) },
      seededRuns: strs(cache.seeded_runs),
    },
    rateLimit: {
      perMin: num(rl.runs_per_min_per_client) ?? 0,
      maxConcurrent: num(rl.max_concurrent_runs) ?? 0,
      inFlight: num(rl.in_flight) ?? 0,
      recent429: num(rl.rejected_429_recent) ?? 0,
      total429: num(rl.rejected_429_total) ?? 0,
    },
    engines: {
      configured: eng.configured === true,
      ok: eng.ok === true,
      error: str(eng.error),
      wmEvents: num(eng.wm_events),
    },
    world: { runId: str(wm.run_id), hypotheses: num(wm.hypotheses) ?? 0, byStatus },
    models: {
      ok: models.ok === true,
      lanes,
      modelIds: strs(models.latest_model_ids),
    },
    rag: {
      enabled: typeof rag.enabled === "boolean" ? rag.enabled : null,
      documents: num(rag.documents),
      passages: num(rag.passages),
    },
    viewsCache: viewStats
      ? Object.fromEntries(
          Object.entries(viewStats).map(([name, raw]) => {
            const v = obj(raw);
            const e = obj(v.last_upstream_error);
            return [
              name,
              {
                hits: num(v.hits) ?? 0,
                misses: num(v.misses) ?? 0,
                staleServes: num(v.stale_serves) ?? 0,
                lastError: str(e.at) ? { at: str(e.at) as string, detail: str(e.detail) ?? "" } : null,
                lastOkAt: str(v.last_ok_at),
              },
            ];
          }),
        )
      : null,
  };
}

/** "3 of 4 (75%)", or "no lookups yet". */
export function hitRate(hits: number, misses: number): string {
  const total = hits + misses;
  if (total === 0) return "no lookups yet";
  return `${hits} of ${total} (${Math.round((hits / total) * 100)}%)`;
}

/** Nightshift lane names in plain words. The model behind a lane is in the latest run's model ids. */
export function laneLabel(lane: string, id: string): string {
  const name = lane === "fast" ? "Fast lane" : lane === "deep" ? "Deep lane" : `${lane} lane`;
  return `${name}: ${id}`;
}

/** "nvidia/nemotron-3.5-lightning-30b-a3b" -> "Nemotron 3.5 Lightning 30B A3B". Unknown ids pass through. */
export function modelName(id: string): string {
  const tail = id.split("/").pop() ?? id;
  if (!/nemotron/i.test(tail)) return id;
  return tail
    .split("-")
    .map((part) => (/^\d+b$/i.test(part) || /^a\d+b$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/**
 * The text of the page's live region. It changes only when something a listener cares about
 * changes (memory count, in-flight runs, recent 429s, engines up or down, an error), never with
 * the clock, so a screen reader is not interrupted every 5 seconds.
 */
export function liveSummary(status: SystemStatus | null, error: string | null): string {
  if (!status) return error ? `System status unavailable: ${error}` : "";
  const parts = [
    `${countText(status.memory.count)} remembered findings`,
    `${status.rateLimit.inFlight} of ${status.rateLimit.maxConcurrent} live runs in flight`,
    `${status.rateLimit.recent429} refused in the last 5 minutes`,
    `engines ${status.engines.ok ? "up" : "down"}`,
  ];
  if (error) parts.push(`last refresh failed: ${error}`);
  return parts.join(", ") + ".";
}

/** Count or a dash while unknown. */
export function countText(n: number | null): string {
  return n === null ? "–" : String(n);
}

/** 2026-10-27T09:12:00.000Z -> 27 Oct 09:12 UTC. */
export function shortUtc(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${month} ${hh}:${mm} UTC`;
}
