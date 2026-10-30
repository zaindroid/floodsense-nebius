import { apiBaseUrl } from "./config";
import { adoptRunBody, type RecordedRun } from "./replay";
import { withAskContext, type AskContext } from "../lib/askContext";
import { modelChip } from "../lib/modelChip";

export const DEFAULT_EVENT_ID = "EMSR773";

export interface AskInput {
  question: string;
  eventId?: string;
  threadId?: string | null;
  /** "live" reads hazard_now (past days and the next 48 h). Unset lets the agents classify the question. */
  mode?: AskMode;
  /** Screen context (role, page, point, replay moment). Sent as `context` only through withAskContext. */
  context?: AskContext | null;
  /** The replay "now" (ISO, e.g. 2021-07-14T00:00:00Z) for a rehearsal of a past event. Sent as replay_ts. */
  replayTs?: string | null;
}

export type AskMode = "live" | "event";

/** Pure: the mode a question asked from this page carries. A Now page asks about now; elsewhere the agents decide. */
export function modeForPage(page: string | null | undefined): AskMode | undefined {
  return page === "now" ? "live" : undefined;
}

/** The question the Now page pre-fills. Not sent until the reader presses Send. */
export const NEXT_48H_QUESTION = "Do the next 48 hours look safe across our watch?";

/** The one-click "Is the next 48 h safe here?" question for a named place (or the whole watch). Never sent on its own. */
export function next48hQuestion(place?: string | null): string {
  return place && place.trim() ? `Do the next 48 hours look safe at ${place.trim()}?` : NEXT_48H_QUESTION;
}

/** Pure: the answer header line for the run's effective mode. Null when the body does not say. */
export function modeLabel(run: Pick<RecordedRun, "mode" | "eventId">): string | null {
  if (run.mode === "live") return "Live data · next 48 h";
  if (run.mode === "event") return `Event · ${run.eventId ?? DEFAULT_EVENT_ID} replay`;
  return null;
}

const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Pure: the thread a follow-up continues. Only a live run's own, well-formed thread_id; never a replay's or cache hit's. */
export function followUpThreadId(previous: Pick<RecordedRun, "servedFrom" | "threadId"> | null): string | null {
  if (!previous || previous.servedFrom !== "live" || !previous.threadId) return null;
  return THREAD_ID.test(previous.threadId) ? previous.threadId : null;
}

export const MAX_TURNS = 20;

/** Pure: the conversation capped to the newest MAX_TURNS. */
export function capTurns<T>(turns: T[], max = MAX_TURNS): T[] {
  return turns.length > max ? turns.slice(turns.length - max) : turns;
}

/** Pure: the POST /runs body. */
export function buildRunRequest(input: AskInput): Record<string, unknown> {
  const question = input.question.trim();
  const body: Record<string, string> = {
    question,
    doc_query: question,
  };
  // No event_id unless the page has one: the agents route an unset event by the
  // question (Rhine, Köln, Ahr -> EMSR517) and default to EMSR773 otherwise.
  if (input.eventId) body.event_id = input.eventId;
  if (input.threadId) body.thread_id = input.threadId;
  if (input.mode) body.mode = input.mode;
  if (input.replayTs) body.replay_ts = input.replayTs;
  return withAskContext(body, input.context);
}

/** Front-door reply to POST /runs (contracts ReplyResponse): small talk answered without a run. Never a flood fact. */
export interface ReplyResponse {
  kind: "reply";
  intent: "greeting" | "help" | "thanks" | "off_topic";
  answer: string;
  suggestions: string[];
  model_id: string;
  latency_ms: number;
  /** Router lane: always "reply" for a front-door reply. */
  lane?: "reply";
}

const REPLY_INTENTS = new Set(["greeting", "help", "thanks", "off_topic"]);

/** Type guard: a POST /runs body that is a front-door reply, not a run snapshot. */
export function isReply(body: unknown): body is ReplyResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return (
    b.kind === "reply" &&
    typeof b.intent === "string" &&
    REPLY_INTENTS.has(b.intent) &&
    typeof b.answer === "string" &&
    b.answer.length > 0 &&
    Array.isArray(b.suggestions) &&
    b.suggestions.every((s) => typeof s === "string") &&
    typeof b.model_id === "string" &&
    typeof b.latency_ms === "number"
  );
}

export type AskResult =
  | { ok: true; run: RecordedRun }
  /**
   * A front-door reply (greeting, help, thanks, off-topic): no run exists. `message` is the
   * reply text, so a caller that only knows the error branch still shows it; render `reply`.
   */
  | { ok: false; kind: "reply"; message: string; reply: ReplyResponse }
  | { ok: false; kind: "rate_limited" | "provider" | "server" | "bad_response" | "network" | "aborted"; message: string };

const detailOf = (body: unknown): string | null => {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => (x as { msg?: unknown })?.msg).filter((m) => typeof m === "string").join("; ") || null;
  return null;
};

/** Pure: map an HTTP answer to a result the popup shows. */
export function mapRunResponse(status: number, body: unknown, retryAfter: string | null): AskResult {
  if (status === 429) {
    const secs = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
    return {
      ok: false,
      kind: "rate_limited",
      message: secs !== null ? `Too many questions. Try again in ${secs} s.` : "Too many questions. Try again shortly.",
    };
  }
  if (status === 422) {
    return { ok: false, kind: "provider", message: `Request refused: ${detailOf(body) ?? "the service did not accept it."}` };
  }
  if (status >= 500) {
    return { ok: false, kind: "server", message: `The service failed (${status})${detailOf(body) ? `: ${detailOf(body)}` : ""}.` };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, kind: "server", message: `Request failed (${status})${detailOf(body) ? `: ${detailOf(body)}` : ""}.` };
  }
  if (isReply(body)) return { ok: false, kind: "reply", message: body.answer, reply: body };
  const rec = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const runId = rec && typeof rec.run_id === "string" ? rec.run_id : "";
  const run = rec ? adoptRunBody(rec, runId) : null;
  if (!run) return { ok: false, kind: "bad_response", message: "The answer came back without a usable summary or label." };
  return { ok: true, run };
}

/** Badge text for an adopted run. A replay or cache hit is never called live. */
export function runBadge(run: RecordedRun): string {
  if (run.servedFrom === "live") {
    const model = run.modelIds[run.modelIds.length - 1];
    if (!model) return "Live";
    // The lane of the last step that used this model: "Live · Nemotron 3.5 Lightning 30B · Nightshift deep lane".
    const step = [...run.trace].reverse().find((s) => (s.modelId ?? "").includes(model) && s.lane);
    return `Live · ${modelChip(model, step?.lane ?? null, step?.provider ?? run.provider ?? null)}`;
  }
  if (run.servedFrom === "cache") return run.label || "Cached answer · not live";
  return run.label || `Replay · recorded run ${run.runId} · not live`;
}

/** POST /runs. Synchronous on the API side: it returns when the run reaches the approval interrupt. */
export async function askFloodSense(input: AskInput, signal?: AbortSignal, base = apiBaseUrl()): Promise<AskResult> {
  let response: Response;
  try {
    response = await fetch(`${base}/runs`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRunRequest(input)),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) return { ok: false, kind: "aborted", message: "Cancelled." };
    return { ok: false, kind: "network", message: `Could not reach the API (${(error as Error)?.message ?? "network error"}). The run may still have started; check the Approvals page.` };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return mapRunResponse(response.status, body, response.headers.get("Retry-After"));
}
