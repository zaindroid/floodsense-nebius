import { apiBaseUrl, apiTimeoutMs } from "./config";

/** GET /platform/status (api/app/platform_status.py). Read-only, no secrets. */
export interface LaneLatency {
  n: number;
  p50Ms: number;
  p95Ms: number;
}

/** Official Token Factory price (USD per 1M tokens), limits and region of one lane's model. */
export interface LanePricing {
  modelId: string | null;
  pricePerMInput: number | null;
  pricePerMOutput: number | null;
  pricePerMCacheRead: number | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  region: string | null;
  country: string | null;
}

export interface PlatformStatus {
  agentsOk: boolean;
  llmBackend: "nightshift" | "nebius" | string | null;
  lanes: Record<string, string>;
  dataBackend: "zetaris" | "local" | string;
  tavily: boolean;
  /** Tavily web-evidence counters (agents process); null if the agents are older. Never the key. */
  tavilyStatus: {
    enabled: boolean;
    keyConfigured: boolean;
    calls: number;
    cacheHits: number;
    avgLatencyMs: number | null;
    lastStatus: "ok" | "empty" | "unavailable" | null;
    lastError: string | null;
  } | null;
  latency: Record<string, LaneLatency>;
  cache: { backend: string | null; hits: number; misses: number; hitRate: number | null };
  rateLimit: { inFlight: number; maxConcurrent: number; runsPerMin: number; recent429: number; total429: number };
  liveSources: number | null;
  /** Last live lane check (POST agents /llm/check); null until run. */
  llmCheck: { ok: boolean; lanes: Record<string, { ok: boolean; modelId: string | null; latencyMs: number }> } | null;
  /** Agents-process token usage per lane; costUsd null = price not configured. */
  llmUsage: { lanes: Record<string, { calls: number; totalTokens: number; avgLatencyMs: number | null }>; costUsd: number | null; costPerAnswerUsd: number | null; answers: number; priceNote: string; pricing: Record<string, LanePricing> } | null;
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

function parseTavily(v: unknown): PlatformStatus["tavilyStatus"] {
  const t = obj(v);
  if (!Object.keys(t).length) return null;
  const ls = t.last_status;
  return {
    enabled: t.enabled === true,
    keyConfigured: t.key_configured === true,
    calls: n0(t.calls),
    cacheHits: n0(t.cache_hits),
    avgLatencyMs: num(t.avg_latency_ms),
    lastStatus: ls === "ok" || ls === "empty" || ls === "unavailable" ? ls : null,
    lastError: str(t.last_error),
  };
}

function parseUsage(v: unknown): PlatformStatus["llmUsage"] {
  const u = obj(v);
  if (!Object.keys(u).length) return null;
  const lanes: NonNullable<PlatformStatus["llmUsage"]>["lanes"] = {};
  for (const [k, l] of Object.entries(obj(u.lanes))) {
    const o = obj(l);
    lanes[k] = { calls: n0(o.calls), totalTokens: n0(o.total_tokens), avgLatencyMs: num(o.avg_latency_ms) };
  }
  const pricing: Record<string, LanePricing> = {};
  for (const [k, l] of Object.entries(obj(u.pricing))) {
    const o = obj(l);
    pricing[k] = {
      modelId: str(o.model_id),
      pricePerMInput: num(o.price_per_m_input),
      pricePerMOutput: num(o.price_per_m_output),
      pricePerMCacheRead: num(o.price_per_m_cache_read),
      rpmLimit: num(o.rpm_limit),
      tpmLimit: num(o.tpm_limit),
      region: str(o.region),
      country: str(o.country),
    };
  }
  return {
    lanes,
    costUsd: num(u.cost_usd),
    costPerAnswerUsd: num(u.cost_per_answer_usd),
    answers: n0(u.answers),
    priceNote: str(u.price_note) ?? "price not configured",
    pricing,
  };
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
    tavilyStatus: parseTavily(b.tavily_status),
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
  signal?: AbortSignal,
): Promise<{ status: PlatformStatus | null; error: string | null }> {
  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const timer = setTimeout(() => controller.abort(), apiTimeoutMs());
  try {
    const r = await fetch(`${base}/platform/status`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    if (!r.ok) return { status: null, error: `GET /platform/status returned ${r.status}` };
    const status = parsePlatformStatus(await r.json());
    return status ? { status, error: null } : { status: null, error: "GET /platform/status did not return an object" };
  } catch {
    return { status: null, error: `API not reached at ${base}/platform/status` };
  } finally {
    clearTimeout(timer);
  }
}
