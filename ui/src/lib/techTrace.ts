import type { LanePricing } from "../api/platform";
import type { RecordedRun } from "../api/replay";
import type { MemoryUsed } from "./hitl";
import { NEBIUS_NAME, providerLabel, regionBadge } from "./lanes";
import { formatLatency, parseBoard } from "./pipeline";

/**
 * "How this answer was made": four sponsor tiles derived only from fields the run snapshot already carries
 * (trace, claims[].citations, memory_used, judge_summary, lane, router_reason, model_ids, served_from). Nothing is
 * invented: a tile with no evidence says so, Nightshift is never claimed for a run without a Nightshift model call,
 * and a cached or recorded answer says it was not run just now.
 */

export type TileId = "zetaris" | "nightshift" | "tokenfactory" | "hmem" | "world" | "tavily";

export const GLOSSARY: Record<TileId | "model", string> = {
  model: "Language model: the NVIDIA Nemotron models the agents think with (fast and deep lanes). The serving backend is named once it is known.",
  zetaris: "Zetaris: the only SQL path to the data.",
  tokenfactory:
    "Nebius Token Factory: the hosted inference service that serves the agents' model calls (fast and deep lanes) with NVIDIA Nemotron models.",
  nightshift:
    "Meterless Nightshift: the gateway that routes the agents' model calls (meterless/fast and meterless/deep) to NVIDIA Nemotron models.",
  hmem: "Meterless H-MEM: remembers approved findings (and clearly labelled demo seeds).",
  world: "Meterless World Model: tracks which hypotheses the evidence still supports.",
  tavily: "Tavily: optional web search. Its snippets are cited web context, not an official warning.",
};

export interface TileDetail {
  label: string;
  value: string;
}

export interface Tile {
  id: TileId;
  name: string;
  /** False when the lane did not use this sponsor tool (the tile is dimmed, never hidden). */
  used: boolean;
  headline: string;
  glossary: string;
  details: TileDetail[];
}

export interface TechTraceModel {
  /** "Router → quick lane (live level question about KÖLN)", or null when the run states no lane or reason. */
  routerLine: string | null;
  /** "Checked 1.00", or null without a judge score. */
  judgeLine: string | null;
  tiles: Tile[];
}

/* ---------- Zetaris ---------- */

export interface ZetarisUse {
  queryIds: string[];
  views: string[];
  /** Distinct document passages (layer c) hydrated through the Zetaris JDBC connection. */
  ragChunks: number;
  upstream: { title: string; publisher: string | null; url: string | null }[];
}

/** Pure: distinct query ids over layer a and c citations, the view names of layer a, the upstream sources of layer b. */
export function zetarisUse(run: Pick<RecordedRun, "claims">): ZetarisUse {
  const queryIds: string[] = [];
  const views: string[] = [];
  const upstream: ZetarisUse["upstream"] = [];
  const seenUp = new Set<string>();
  let ragChunks = 0;
  const seenChunks = new Set<string>();
  for (const claim of run.claims) {
    for (const c of claim.citations) {
      if ((c.layer === "a" || c.layer === "c") && c.queryId && !queryIds.includes(c.queryId)) queryIds.push(c.queryId);
      if (c.layer === "a" && /^floodsense/i.test(c.title) && !views.includes(c.title)) views.push(c.title);
      if (c.layer === "c") {
        const key = c.chunkId ?? `${c.title}|${c.page ?? ""}|${c.paragraph ?? ""}`;
        if (!seenChunks.has(key)) {
          seenChunks.add(key);
          ragChunks += 1;
        }
      }
      if (c.layer === "b" && !seenUp.has(c.title)) {
        seenUp.add(c.title);
        upstream.push({ title: c.title, publisher: c.publisher, url: c.sourceUrl ?? null });
      }
    }
  }
  return { queryIds, views, ragChunks, upstream };
}

const shortView = (v: string): string => v.replace(/^floodsense(_seed)?\./i, "");

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function zetarisTile(run: RecordedRun): Tile {
  const z = zetarisUse(run);
  const viewNames = z.views.map(shortView);
  if (z.ragChunks > 0) viewNames.push("document chunks");
  const details: TileDetail[] = [];
  if (z.queryIds.length) details.push({ label: "Query ids", value: z.queryIds.join(", ") });
  if (z.views.length) details.push({ label: "Views", value: z.views.join(", ") });
  if (z.ragChunks > 0) details.push({ label: "Documents", value: `${plural(z.ragChunks, "passage")} hydrated through Zetaris JDBC` });
  if (z.upstream.length) {
    details.push({ label: "Upstream sources", value: z.upstream.map((u) => (u.publisher ? `${u.title} (${u.publisher})` : u.title)).join("; ") });
  }
  const headline = z.queryIds.length
    ? `${plural(z.queryIds.length, "cited query", "cited queries")} across ${viewNames.length ? viewNames.join(", ") : "Zetaris views"}`
    : "No cited Zetaris query";
  return { id: "zetaris", name: "Zetaris", used: z.queryIds.length > 0, headline, glossary: GLOSSARY.zetaris, details };
}

/* ---------- Meterless Nightshift ---------- */

export interface ModelUse {
  id: string;
  name: string;
  /** "Nightshift" or another stated provider; null when the id does not say. */
  provider: string | null;
  /** True only for a Nemotron id served through the Nightshift gateway. */
  nightshift: boolean;
  /** fast / deep, when a trace step that ran this model states it. */
  lanes: string[];
  /** Trace steps that carried this model id (model-assisted steps, not counted calls). */
  steps: number;
  latencyMs: number;
}

/** Display name for a Nemotron id; the three Nightshift models by size, anything else as stored. */
export function modelDisplay(id: string): string {
  const m = /nemotron-([\d.]+)-(super-vl|lightning|ultra)-(\d+)b/i.exec(id);
  if (!m) return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const kind = m[2].toLowerCase() === "super-vl" ? "Super VL" : m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
  return `Nemotron ${m[1]} ${kind} ${m[3]}B`;
}

const llmIds = (modelId: string | null | undefined): string[] =>
  (modelId ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && m !== "deterministic");

/**
 * Pure: the models that answered, from the trace's model_id, lane and latency_ms (run.modelIds when the trace names none).
 * `steps` counts model-assisted steps only (a step with a non-deterministic model_id). `latencyMs` is the summed
 * latency of those steps, which includes the data queries the step ran, so it is not model time.
 */
export function modelUse(run: Pick<RecordedRun, "trace" | "modelIds" | "provider">): { models: ModelUse[]; steps: number; latencyMs: number } {
  const byId = new Map<string, ModelUse>();
  const make = (id: string, explicit: string | null | undefined): ModelUse => {
    // Explicit provider only: a recorded run without one is not assumed to be the current backend.
    const provider = providerLabel(id, explicit ?? run.provider ?? null);
    return { id, name: modelDisplay(id), provider, nightshift: (provider === null && /nemotron/i.test(id)) || provider === "Nightshift" || provider === NEBIUS_NAME, lanes: [], steps: 0, latencyMs: 0 };
  };
  let steps = 0;
  let latencyMs = 0;
  for (const step of run.trace) {
    const ids = llmIds(step.modelId);
    if (!ids.length) continue;
    steps += 1;
    latencyMs += step.latencyMs ?? 0;
    for (const id of ids) {
      const use = byId.get(id) ?? make(id, step.provider);
      use.steps += 1;
      use.latencyMs += step.latencyMs ?? 0;
      const lane = (step.lane ?? "").toLowerCase();
      if ((lane === "fast" || lane === "deep") && !use.lanes.includes(lane)) use.lanes.push(lane);
      byId.set(id, use);
    }
  }
  if (!byId.size) {
    for (const id of run.modelIds.flatMap((m) => llmIds(m))) if (!byId.has(id)) byId.set(id, make(id, null));
  }
  return { models: [...byId.values()], steps, latencyMs };
}

function totalLatency(run: Pick<RecordedRun, "trace">): number {
  return run.trace.reduce((n, s) => n + (s.latencyMs ?? 0), 0);
}

/** An answer served from the cache or a recording carries the original run's trace; it was not run just now. */
export const RECORDED_NOTE = "Recorded run: replayed from cache, not run just now";

const isRecorded = (run: Pick<RecordedRun, "servedFrom">): boolean => run.servedFrom !== "live";

/** Usage rows from run.usage. Absent usage is only reported when the run made model calls; a deterministic run adds nothing. */
function usageDetails(run: RecordedRun, hadModelCalls: boolean, pricing?: Record<string, LanePricing> | null): { before: TileDetail[]; after: TileDetail[] } {
  const u = run.usage;
  if (!u) return { before: hadModelCalls ? [{ label: "Usage", value: "Not recorded for this answer (cached, replayed or older run)" }] : [], after: [] };
  if (u.calls === 0) return { before: [], after: [{ label: "Usage", value: "No model call in this answer" }] };
  return {
    before: [],
    after: [
      ...u.models.map((m) => {
        const region = regionBadge(pricing?.[m.lane]);
        return { label: `${m.lane} lane · ${m.modelId}`, value: `${plural(m.calls, "call")} · ${m.totalTokens} tokens${region ? ` · region ${region}` : ""}` };
      }),
      { label: "This run", value: `${plural(u.calls, "model call")} · ${u.totalTokens} tokens${u.avgLatencyMs != null ? ` · avg ${formatLatency(u.avgLatencyMs)}` : ""}` },
      { label: "Cost", value: u.costUsd == null ? "price not configured" : `$${u.costUsd.toFixed(4)} (${u.priceNote})` },
    ],
  };
}

function nightshiftTile(run: RecordedRun, backend?: string | null, pricing?: Record<string, LanePricing> | null): Tile {
  const t = nightshiftBase(run);
  const u = usageDetails(run, modelUse(run).models.length > 0, pricing);
  // Keep the "Time in model-assisted steps" row last among the trace rows; unrecorded-usage note goes before it.
  const i = t.details.findIndex((d) => d.label.startsWith("Time in model"));
  const details = [...t.details];
  details.splice(i < 0 ? details.length : i, 0, ...u.before);
  details.push(...u.after);
  // Named after the current backend; neutral until /platform/status is known.
  if (backend === "nebius") return { ...t, name: NEBIUS_NAME, glossary: GLOSSARY.tokenfactory, details };
  if (backend === "nightshift") return { ...t, details };
  return { ...t, name: "Language model", glossary: GLOSSARY.model, details };
}

function nightshiftBase(run: RecordedRun): Tile {
  const use = modelUse(run);
  const recorded: TileDetail[] = isRecorded(run) ? [{ label: "Served from", value: RECORDED_NOTE }] : [];
  const name = "Meterless Nightshift";
  if (!use.models.length) {
    const total = totalLatency(run);
    const took = total > 0 ? ` in ${formatLatency(total)}` : "";
    return {
      id: "nightshift",
      name,
      used: false,
      headline: "No model call",
      glossary: GLOSSARY.nightshift,
      details: [
        ...recorded,
        { label: "Why", value: `No model call: answered deterministically from Zetaris data — the router chose the cheapest safe path${took}.` },
      ],
    };
  }
  const nightshift = use.models.filter((m) => m.nightshift);
  const other = use.models.filter((m) => !m.nightshift);
  const stepText = (n: number) => plural(n, "model-assisted step");
  const details: TileDetail[] = [
    ...recorded,
    ...use.models.map((m) => ({
      label: m.nightshift ? m.name : `${m.name} (test provider)`,
      value:
        [m.lanes.length ? `${m.lanes.join("/")} lane` : null, m.steps > 0 ? stepText(m.steps) : null, m.latencyMs > 0 ? formatLatency(m.latencyMs) : null]
          .filter(Boolean)
          .join(" · ") || "answered",
    })),
  ];
  if (use.steps > 0) {
    details.push({ label: "Time in model-assisted steps (includes data queries)", value: `${formatLatency(use.latencyMs)} over ${plural(use.steps, "step")}` });
  }
  if (!nightshift.length) {
    details.push({ label: "Provider", value: "These model calls went to the test provider, not to Nightshift." });
    return { id: "nightshift", name, used: false, headline: `Test provider · ${other.map((m) => m.name).join(" + ")}`, glossary: GLOSSARY.nightshift, details };
  }
  const names = nightshift.map((m) => m.name.replace(/^Nemotron [\d.]+ /, "")).join(" + ");
  const extra = other.length ? ` + test provider ${other.map((m) => m.name).join(", ")}` : "";
  const headline = `${names}${extra}${use.steps > 0 ? ` · ${stepText(use.steps)}` : ""}`;
  return { id: "nightshift", name, used: true, headline, glossary: GLOSSARY.nightshift, details };
}

/* ---------- H-MEM ---------- */

export const NO_MEMORY_MATCH = "No approved memory matched this question yet";
export const RECALL_NOT_ACTIVE = "H-MEM recall was not active in this run";
export const RECALL_FAILED = "H-MEM recall failed in this run";

export type RecallState = "ran" | "failed" | "not_active";

/**
 * Pure: did H-MEM recall run? Evidence is a trace event: the memory step ("recalled N ...", or "recall failed"),
 * a forecast history step that reports H-MEM, or memory_used itself. No such event means recall was not active
 * (quick lane, FF_HMEM off, engines off), which is different from "ran and nothing matched".
 */
export function recallState(run: Pick<RecordedRun, "trace" | "memoryUsed">): RecallState {
  if ((run.memoryUsed ?? []).length > 0) return "ran";
  for (const s of run.trace) {
    if (s.node === "memory") {
      if (/recall failed/i.test(s.summary)) return "failed";
      if (/recalled\s+\d+/i.test(s.summary)) return "ran";
    }
    if (s.node === "history" && /h-mem/i.test(s.summary) && !/h-mem[^;]*\b(off|unavailable|disabled|failed)\b/i.test(s.summary)) return "ran";
  }
  return "not_active";
}

function memoryDetail(m: MemoryUsed): TileDetail {
  const origin = m.seeded ? "demo seed" : m.runId ? `approved run ${m.runId}` : "approved";
  const tail = m.seeded && m.runId ? ` · ${m.runId}` : "";
  return { label: m.memoryId, value: `${origin}${tail}` };
}

function hmemTile(run: RecordedRun): Tile {
  const memories = run.memoryUsed ?? [];
  const recall = recallState(run);
  // The write on approval exists only when H-MEM is on; recall having run is the trace's evidence of that.
  const writes = run.status === "awaiting_approval" && recall === "ran";
  const details: TileDetail[] = memories.map(memoryDetail);
  if (writes) details.push({ label: "On approval", value: "this finding is written to H-MEM" });
  if (!memories.length) {
    const base = recall === "not_active" ? RECALL_NOT_ACTIVE : recall === "failed" ? RECALL_FAILED : NO_MEMORY_MATCH;
    return {
      id: "hmem",
      name: "Meterless H-MEM",
      used: false,
      headline: writes ? `${base} · + writes on approval` : base,
      glossary: GLOSSARY.hmem,
      details,
    };
  }
  const seeded = memories.filter((m) => m.seeded).length;
  const parts = [`${memories.length} recalled`];
  if (seeded) parts.push(seeded === memories.length ? "demo seed" : `${seeded} demo seed`);
  if (writes) parts.push("+ writes on approval");
  return { id: "hmem", name: "Meterless H-MEM", used: true, headline: parts.join(" · "), glossary: GLOSSARY.hmem, details };
}

/* ---------- World Model ---------- */

/** "not_supported" -> "not supported". */
export const verdictWord = (state: string): string => state.replace(/_/g, " ");

function worldTile(run: RecordedRun): Tile {
  let board = null as ReturnType<typeof parseBoard>;
  for (const step of run.trace) {
    if (step.node !== "world_model") continue;
    board = parseBoard(step.summary) ?? board;
  }
  if (!board) {
    return { id: "world", name: "Meterless World Model", used: false, headline: "Not used by this lane", glossary: GLOSSARY.world, details: [] };
  }
  const states = board.states;
  return {
    id: "world",
    name: "Meterless World Model",
    used: true,
    headline: states.map((s) => `${s.id} ${verdictWord(s.state)}`).join(", "),
    glossary: GLOSSARY.world,
    details: [
      ...states.map((s) => ({ label: s.id, value: verdictWord(s.state) })),
      { label: "Board", value: `after ${board.after}` },
    ],
  };
}

/* ---------- Tavily ---------- */

/** Pure: Tavily state from the trace. No "tavily" step means the flag was off (or no place to search). */
function tavilyTile(run: RecordedRun): Tile {
  const calls = run.trace.filter((s) => s.node === "tavily");
  const base = { id: "tavily" as const, name: "Tavily web context", glossary: GLOSSARY.tavily };
  const web = run.web ?? null;
  if (!calls.length && !web) return { ...base, used: false, headline: "Off · no web call in this run", details: [] };
  const last = calls[calls.length - 1];
  const details: TileDetail[] = calls.length ? [{ label: "Calls", value: String(calls.length) }, { label: "Call", value: last.summary }] : [];
  if (web) {
    details.push(
      { label: "Status", value: web.status },
      { label: "Results", value: String(web.n_results) },
      { label: "Latency", value: web.latency_ms > 0 ? `${web.latency_ms} ms` : "n/a" },
      { label: "Cached", value: web.cached ? "yes" : "no" },
    );
  }
  const check = run.trace.map((s) => /web_check (supports|contradicts|neutral) (\S+) (\S+)/.exec(s.summary)).find(Boolean);
  if (check) details.push({ label: "Skeptic web check", value: `${check[1]} ${check[2]}, ${check[3]}` });
  const down = web ? web.status === "unavailable" : /unavailable/i.test(last.summary);
  return { ...base, used: !down, headline: down ? "Unavailable" : `On · ${plural(Math.max(calls.length, 1), "call")}`, details };
}

/* ---------- Router + Judge ---------- */

/** "chose quick: live level question about X" -> "live level question about X". */
function reasonText(reason: string | null | undefined): string | null {
  const t = (reason ?? "").trim();
  if (!t) return null;
  return t.replace(/^chose\s+\w+:\s*/i, "").replace(/\s*·?\s*escalated:.*$/i, "").trim() || null;
}

export function routerLine(run: Pick<RecordedRun, "lane" | "routerReason" | "servedFrom">): string | null {
  const reason = reasonText(run.routerReason);
  let line: string | null = null;
  if (run.lane && reason) line = `Router → ${run.lane} lane (${reason})`;
  else if (run.lane) line = `Router → ${run.lane} lane`;
  else if (reason) line = `Router → ${reason}`;
  if (isRecorded(run)) return line ? `${line} · ${RECORDED_NOTE}` : RECORDED_NOTE;
  return line;
}

export function judgeLine(run: Pick<RecordedRun, "judgeOverall">): string | null {
  if (run.judgeOverall === null || run.judgeOverall === undefined) return null;
  return `Checked ${run.judgeOverall.toFixed(2)}`;
}

/** Pure: the Control tower tile's dot and line from GET /watch/status; unknown when the status could not be read. */
export function watchTile(status: { loop: { enabled: boolean; alive: boolean; interval_s: number }; counts: { sources: number; awaiting_approval: number } } | null): {
  state: "ok" | "off" | "down" | "unknown";
  line: string;
} {
  if (!status) return { state: "unknown", line: "Watch loop status unavailable" };
  const { loop, counts } = status;
  if (!loop.enabled) return { state: "off", line: "Watch loop switched off" };
  if (!loop.alive) return { state: "down", line: "Watch loop not running" };
  return { state: "ok", line: `Watch loop every ${loop.interval_s} s · ${counts.sources} sources · ${counts.awaiting_approval} awaiting approval` };
}

/** Pure: which past-run row the insurer Review page describes. Live: the newest finished run. Past: the newest one for the chosen event. */
export function pickRunRow<T extends { runId: string; status: string; eventId: string | null }>(
  rows: readonly T[],
  mode: "live" | "past",
  eventId: string | null,
): T | null {
  const finished = rows.filter((r) => r.status !== "running");
  if (mode === "past") return finished.find((r) => r.eventId === eventId) ?? null;
  return finished[0] ?? null;
}

/** Pure: everything the TechTrace panel draws. */
export function buildTechTrace(run: RecordedRun, backend?: string | null, pricing?: Record<string, LanePricing> | null): TechTraceModel {
  return {
    routerLine: routerLine(run),
    judgeLine: judgeLine(run),
    tiles: [zetarisTile(run), nightshiftTile(run, backend, pricing), hmemTile(run), worldTile(run), tavilyTile(run)],
  };
}
