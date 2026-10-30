import { apiBaseUrl, apiTimeoutMs } from "./config";

/** GET /platform/status (api/app/platform_status.py). Read-only, no secrets. */
export interface LaneLatency {
  n: number;
  p50Ms: number;
  p95Ms: number;
}

export interface PlatformStatus {
  agentsOk: boolean;
  llmBackend: "nightshift" | "nebius" | string | null;
  lanes: Record<string, string>;
  dataBackend: "zetaris" | "local" | string;
  tavily: boolean;
  latency: Record<string, LaneLatency>;
  cache: { backend: string | null; hits: number; misses: number; hitRate: number | null };
  rateLimit: { inFlight: number; maxConcurrent: number; runsPerMin: number; recent429: number; total429: number };
  liveSources: number | null;
  /** Last live lane check (POST agents /llm/check); null until run. */
  llmCheck: { ok: boolean; lanes: Record<string, { ok: boolean; modelId: string | null; latencyMs: number }> } | null;
  /** Agents-process token usage per lane; costUsd null = price not configured. */
  llmUsage: { lanes: Record<string, { calls: number; totalTokens: number; avgLatencyMs: number | null }>; costUsd: number | null; priceNote: string } | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const n0 = (v: unknown): number => num(v) ?? 0;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function parseCheck(v: unknown): PlatformStatus["llmCheck"] {
  const c = obj(v);
  if (!Object.keys(c).length) return null;
  const lanes: NonNullable<PlatformStatus["llmCheck"]>["lanes"] = {};
  for (const [k, l] of Object.entries(obj(c.lanes))) {
    const o = obj(l);
    lanes[k] = { ok: o.ok === true, modelId: str(o.model_id), latencyMs: n0(o.latency_ms) };
  }
  return { ok: c.ok === true, lanes };
}

function parseUsage(v: unknown): PlatformStatus["llmUsage"] {
  const u = obj(v);
  if (!Object.keys(u).length) return null;
  const lanes: NonNullable<PlatformStatus["llmUsage"]>["lanes"] = {};
  for (const [k, l] of Object.entries(obj(u.lanes))) {
    const o = obj(l);
    lanes[k] = { calls: n0(o.calls), totalTokens: n0(o.total_tokens), avgLatencyMs: num(o.avg_latency_ms) };
  }
  return { lanes, costUsd: num(u.cost_usd), priceNote: str(u.price_note) ?? "price not configured" };
}

export function parsePlatformStatus(body: unknown): PlatformStatus | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = obj(body);
  const cache = obj(b.cache);
  const rl = obj(b.rate_limit);
  const lanes: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(b.lanes))) if (typeof v === "string") lanes[k] = v;
  const latency: Record<string, LaneLatency> = {};
  for (const [k, v] of Object.entries(obj(b.latency))) {
    const l = obj(v);
    latency[k] = { n: n0(l.n), p50Ms: n0(l.p50_ms), p95Ms: n0(l.p95_ms) };
  }
  return {
    agentsOk: b.agents_ok === true,
    llmBackend: str(b.llm_backend),
    lanes,
    dataBackend: str(b.data_backend) ?? "zetaris",
    tavily: b.tavily === true,
    latency,
    cache: { backend: str(cache.backend), hits: n0(cache.hits), misses: n0(cache.misses), hitRate: num(cache.hit_rate) },
    rateLimit: {
      inFlight: n0(rl.in_flight),
      maxConcurrent: n0(rl.max_concurrent),
      runsPerMin: n0(rl.runs_per_min),
      recent429: n0(rl.rejected_429_recent),
      total429: n0(rl.rejected_429_total),
    },
    liveSources: num(b.live_sources),
    llmCheck: parseCheck(b.llm_check),
    llmUsage: parseUsage(b.llm_usage),
  };
}

/** GET /platform/status once. A failure is an error string, never a throw. */
export async function fetchPlatformStatus(
  base = apiBaseUrl(),
): Promise<{ status: PlatformStatus | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), apiTimeoutMs());
  try {
    const r = await fetch(`${base}/platform/status`, { credentials: "omit", cache: "no-store", signal: controller.signal });
    if (!r.ok) return { status: null, error: `GET /platform/status returned ${r.status}` };
    const status = parsePlatformStatus(await r.json());
    return status ? { status, error: null } : { status: null, error: "GET /platform/status did not return an object" };
  } catch {
    return { status: null, error: `API not reached at ${base}/platform/status` };
  } finally {
    clearTimeout(timer);
  }
}
