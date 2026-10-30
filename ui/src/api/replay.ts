import { apiBaseUrl, apiTimeoutMs } from "./config";
import { adoptMemoryUsed, adoptPlaybook, type MemoryUsed, type PlaybookItem } from "../lib/hitl";
import { adoptPlain, type PlainAnswer } from "../lib/calmAnswer";

/** One citation from a recorded run. Layer (c) carries a document passage. */
export interface ReplayCitation {
  id: string;
  layer: string;
  title: string;
  publisher: string | null;
  licence: string | null;
  attribution: string | null;
  quote: string | null;
  page: number | null;
  queryId: string | null;
  /** Source URL of the passage or feed, when the citation carries one. */
  sourceUrl?: string | null;
  paragraph?: number | null;
  chunkId?: string | null;
}

export interface ReplayClaim {
  id: string;
  text: string;
  citations: ReplayCitation[];
}

export interface ReplayStep {
  seq: number;
  node: string;
  summary: string;
  /** Trace extras for the pipeline view. Absent on old bodies. */
  lane?: string | null;
  modelId?: string | null;
  latencyMs?: number | null;
  evidenceIds?: string[];
  /** Provider that served this step, when the trace says (e.g. "nightshift"). */
  provider?: string | null;
}

/** Judge verdict for one claim (body.judge[]). */
export interface ReplayJudgeClaim {
  claimId: string;
  grounding: string | null;
  score: number | null;
  rationale: string | null;
  modelId: string | null;
}

/** A recorded agent run, read from GET /runs/{id}/replay. Always a replay, never live. */
export interface RecordedRun {
  runId: string;
  label: string;
  summary: string;
  claims: ReplayClaim[];
  judgeOverall: number | null;
  judgePasses: boolean | null;
  flaggedClaimIds: string[];
  trace: ReplayStep[];
  /** live, cache or replay, from the body's own served_from. */
  servedFrom: "live" | "cache" | "replay";
  status: string | null;
  threadId: string | null;
  modelIds: string[];
  /** The agents' effective mode (body.mode.mode): live reads hazard_now, event replays the event window. */
  mode: "live" | "event" | null;
  eventId: string | null;
  /** Pipeline extras. Zero / empty when the body does not carry them. */
  reviseRounds?: number;
  repairRounds?: number;
  judgeClaims?: ReplayJudgeClaim[];
  docQuery?: string | null;
  memoryCount?: number;
  /** Run-level LLM provider from the body or its request, when stated. */
  provider?: string | null;
  /** A declined run's scope.elsewhere: the event that does hold the question, when the gate named one. */
  elsewhere?: string | null;
  /** Router lane (contracts Lane): quick = live watcher + one fast call, full = deep run. Null on older runs. */
  lane?: "quick" | "forecast" | "full" | null;
  /** Why the router chose the lane, including any "escalated: ..." note. */
  routerReason?: string | null;
  /** H-MEM recall for this run (run level; never linked to a claim). */
  memoryUsed?: MemoryUsed[];
  playbook?: PlaybookItem[];
  /** Quick and forecast lanes: the calm, plain-language answer (see lib/calmAnswer.ts). Absent on other runs. */
  plain?: PlainAnswer | null;
  /** The question this run answered (body.request.question), when stated. */
  question?: string | null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function asCitation(value: unknown): ReplayCitation | null {
  const c = rec(value);
  const title = c && str(c.title);
  if (!c || !title) return null;
  return {
    id: str(c.citation_id) ?? title,
    layer: str(c.layer) ?? "?",
    title,
    publisher: str(c.publisher),
    licence: str(c.licence),
    attribution: str(c.attribution),
    quote: str(c.quote),
    page: num(rec(c.locator)?.page),
    queryId: str(c.query_id),
    sourceUrl: str(c.source_url),
    paragraph: num(rec(c.locator)?.paragraph),
    chunkId: str(c.chunk_id),
  };
}

/**
 * Pure adapter: the replay body, or null when it is not a usable recorded run.
 * A body the API serves as live is refused, so the popup never shows it as a replay by mistake.
 */
export function adoptReplay(body: unknown, runId: string): RecordedRun | null {
  const run = rec(body);
  if (!run || run.served_from !== "replay") return null;
  return adoptRunBody(run, runId);
}

/** Any labelled run body (live, cache or replay). Unknown served_from is refused, never guessed as live. */
export function adoptRunBody(run: Record<string, unknown>, runId: string): RecordedRun | null {
  const served = run.served_from;
  if (served !== "live" && served !== "cache" && served !== "replay") return null;
  const summary = str(run.summary);
  if (!summary || !Array.isArray(run.claims)) return null;
  const claims: ReplayClaim[] = [];
  for (const raw of run.claims) {
    const claim = rec(raw);
    const text = claim && str(claim.text);
    if (!claim || !text) continue;
    const citations = Array.isArray(claim.citations)
      ? claim.citations.map(asCitation).filter((c): c is ReplayCitation => c !== null)
      : [];
    claims.push({ id: str(claim.claim_id) ?? text, text, citations });
  }
  const judge = rec(run.judge_summary);
  const trace: ReplayStep[] = Array.isArray(run.trace)
    ? run.trace.flatMap((raw) => {
        const step = rec(raw);
        const node = step && str(step.node);
        return step && node
          ? [
              {
                seq: num(step.seq) ?? 0,
                node,
                summary: str(step.summary) ?? "",
                lane: str(step.lane),
                provider: str(step.provider) ?? str(step.llm_provider),
                modelId: str(step.model_id),
                latencyMs: num(step.latency_ms),
                evidenceIds: Array.isArray(step.evidence_ids)
                  ? step.evidence_ids.filter((e): e is string => typeof e === "string")
                  : [],
              },
            ]
          : [];
      })
    : [];
  const id = str(run.run_id) ?? runId;
  return {
    runId: id,
    label:
      str(rec(run.label)?.text) ??
      (served === "live" ? "Live run" : served === "cache" ? `Cached answer · not live · run ${id}` : `Replay of recorded run ${id} · not live`),
    summary,
    claims,
    judgeOverall: num(judge?.overall),
    judgePasses: typeof judge?.passes === "boolean" ? judge.passes : null,
    flaggedClaimIds: Array.isArray(judge?.flagged_claim_ids)
      ? judge.flagged_claim_ids.filter((id): id is string => typeof id === "string")
      : [],
    trace,
    servedFrom: served,
    status: str(run.status),
    threadId: str(run.thread_id),
    modelIds: Array.isArray(run.model_ids) ? run.model_ids.filter((m): m is string => typeof m === "string") : [],
    mode: modeOf(run.mode),
    eventId: str(run.event_id),
    elsewhere: str(rec(run.scope)?.elsewhere),
    lane: run.lane === "quick" || run.lane === "forecast" || run.lane === "full" ? run.lane : null,
    routerReason: str(run.router_reason),
    reviseRounds: num(run.revise_rounds) ?? 0,
    repairRounds: num(run.repair_rounds) ?? 0,
    judgeClaims: Array.isArray(run.judge)
      ? run.judge.flatMap((raw) => {
          const j = rec(raw);
          const claimId = j && str(j.claim_id);
          return j && claimId
            ? [{ claimId, grounding: str(j.grounding), score: num(j.score), rationale: str(j.rationale), modelId: str(j.model_id) }]
            : [];
        })
      : [],
    docQuery: str(rec(run.request)?.doc_query),
    memoryCount: Array.isArray(run.memories) ? run.memories.length : 0,
    provider: str(run.llm_provider) ?? str(run.provider) ?? str(rec(run.request)?.llm_provider),
    memoryUsed: Array.isArray(run.memory_used) ? adoptMemoryUsed(run.memory_used) : undefined,
    playbook: adoptPlaybook(run.playbook),
    plain: adoptPlain(run.plain),
    question: str(rec(run.request)?.question),
  };
}

function modeOf(value: unknown): "live" | "event" | null {
  const m = rec(value)?.mode ?? value;
  return m === "live" || m === "event" ? m : null;
}

/** VITE_REPLAY_RUN_ID, or null when unset. */
export function replayRunId(): string | null {
  return import.meta.env.VITE_REPLAY_RUN_ID?.trim() || null;
}

/** Fetch the recorded run. Any failure returns null, and the caller keeps the fixture answer. */
export async function fetchRecordedRun(
  runId: string,
  base = apiBaseUrl(),
  signal?: AbortSignal,
): Promise<RecordedRun | null> {
  try {
    const response = await fetch(`${base}/runs/${encodeURIComponent(runId)}/replay`, {
      credentials: "omit",
      signal: AbortSignal.any([AbortSignal.timeout(Math.max(apiTimeoutMs(), 5000)), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) return null;
    return adoptReplay(await response.json(), runId);
  } catch {
    return null;
  }
}
