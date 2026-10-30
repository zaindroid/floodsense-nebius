import { apiBaseUrl } from "./config";
import { buildRunRequest, mapRunResponse, type AskInput } from "./ask";
import { adoptRunBody, type RecordedRun } from "./replay";
import { retryAfterSeconds, type LiveEvent } from "../lib/liveRun";
import { errorDetail } from "../lib/hitl";

export type StartResult =
  | { kind: "started"; runId: string; threadId: string | null }
  | { kind: "run"; run: RecordedRun }
  | { kind: "reply"; answer: string; suggestions: string[] }
  | { kind: "rate_limited"; retryAfterS: number | null; message: string }
  | { kind: "error"; message: string }
  | { kind: "aborted" };

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function suggestionsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 4) : [];
}

/** Pure: classify a POST /runs?wait=false answer. 202 starts a live run; 200 is a cache hit, a replay, or an intent reply. */
export function classifyStart(status: number, body: unknown, retryAfter: string | null): StartResult {
  const r = rec(body);
  if (status === 429) {
    const secs = retryAfterSeconds(retryAfter);
    return { kind: "rate_limited", retryAfterS: secs, message: "Too many questions right now." };
  }
  if (status >= 200 && status < 300 && r && r.kind === "reply" && typeof r.answer === "string" && !r.run_id) {
    return { kind: "reply", answer: r.answer, suggestions: suggestionsOf(r.suggestions) };
  }
  if (status === 202) {
    const runId = r && typeof r.run_id === "string" ? r.run_id : null;
    if (!runId) return { kind: "error", message: "The run started without a run id." };
    return { kind: "started", runId, threadId: typeof r?.thread_id === "string" ? r.thread_id : null };
  }
  const mapped = mapRunResponse(status, body, retryAfter);
  // feat/chat-front-door maps a reply to {ok:false, kind:"reply", reply:{answer, suggestions}}. Not an error.
  const loose = mapped as unknown as { kind?: unknown; message?: unknown; reply?: { answer?: unknown; suggestions?: unknown } };
  if (loose.kind === "reply") {
    const answer = typeof loose.reply?.answer === "string" ? loose.reply.answer : typeof loose.message === "string" ? loose.message : "";
    if (answer) return { kind: "reply", answer, suggestions: suggestionsOf(loose.reply?.suggestions) };
  }
  return mapped.ok ? { kind: "run", run: mapped.run } : { kind: "error", message: mapped.message };
}

export async function startLiveRun(input: AskInput, signal?: AbortSignal, base = apiBaseUrl()): Promise<StartResult> {
  let response: Response;
  try {
    response = await fetch(`${base}/runs?wait=false`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRunRequest(input)),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) return { kind: "aborted" };
    return { kind: "error", message: `Could not reach the API (${(error as Error)?.message ?? "network error"}).` };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return classifyStart(response.status, body, response.headers.get("Retry-After"));
}

/** GET /runs/{id}: the raw body and the adopted run (null while it has no summary yet). */
export async function fetchRunSnapshot(
  runId: string,
  signal?: AbortSignal,
  base = apiBaseUrl(),
): Promise<{ status: number; body: Record<string, unknown> | null; run: RecordedRun | null }> {
  const response = await fetch(`${base}/runs/${encodeURIComponent(runId)}`, { credentials: "omit", signal });
  let body: Record<string, unknown> | null = null;
  try {
    body = rec(await response.json());
  } catch {
    body = null;
  }
  return { status: response.status, body, run: body ? adoptRunBody(body, runId) : null };
}

export type Snapshot = Awaited<ReturnType<typeof fetchRunSnapshot>>;

export interface SubscribeOptions {
  signal?: AbortSignal;
  base?: string;
  /** Injected in tests. */
  eventSource?: (url: string) => EventSource;
  fetchSnapshot?: (runId: string, signal?: AbortSignal) => Promise<Snapshot>;
  pollMs?: number;
  /** Stop polling after this long of consecutive errors. */
  maxErrorMs?: number;
  now?: () => number;
}

/**
 * Subscribe to GET /runs/{id}/events. If the stream breaks, poll GET /runs/{id} every 3 s instead,
 * feeding its trace through the same reducer (duplicates are dropped by seq). An SSE `event: error`
 * carrying status 404 is not_found. Polling gives up after 60 s of consecutive errors. Returns a stop function;
 * aborting the signal also stops it.
 */
export function subscribeRunEvents(runId: string, onEvent: (event: LiveEvent) => void, options: SubscribeOptions = {}): () => void {
  const base = options.base ?? apiBaseUrl();
  const fetchSnap = options.fetchSnapshot ?? ((id: string, signal?: AbortSignal) => fetchRunSnapshot(id, signal, base));
  const pollMs = options.pollMs ?? 3000;
  const maxErrorMs = options.maxErrorMs ?? 60_000;
  const now = options.now ?? Date.now;
  const signal = options.signal;
  let stopped = false;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstErrorAt: number | null = null;
  const parse = (data: unknown): unknown => {
    if (typeof data !== "string") return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };
  const finish = () => {
    stopped = true;
    source?.close();
    source = null;
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
  };
  if (signal?.aborted) return finish;
  signal?.addEventListener("abort", finish);
  const emit = (event: LiveEvent) => {
    if (!stopped) onEvent(event);
  };
  const poll = async () => {
    if (stopped) return;
    try {
      const snap = await fetchSnap(runId, signal);
      if (stopped) return;
      if (snap.status === 404) {
        emit({ type: "status", data: { run_id: runId, status: "not_found" } });
        return finish();
      }
      if (snap.status >= 400) throw new Error(`GET /runs/${runId} answered ${snap.status}`);
      firstErrorAt = null;
      const trace = Array.isArray(snap.body?.trace) ? snap.body.trace : [];
      for (const step of trace) emit({ type: "trace", data: step });
      const status = typeof snap.body?.status === "string" ? snap.body.status : "running";
      if (status !== "running") {
        emit({ type: "status", data: { run_id: runId, status, served_from: snap.body?.served_from, cached_at: snap.body?.cached_at } });
        return finish();
      }
    } catch (error) {
      if (stopped) return;
      firstErrorAt ??= now();
      if (now() - firstErrorAt >= maxErrorMs) {
        emit({ type: "error", message: `Lost contact with run ${runId} for over ${Math.round(maxErrorMs / 1000)} s (${(error as Error)?.message ?? "error"}).` });
        return finish();
      }
    }
    if (!stopped) timer = setTimeout(() => void poll(), pollMs);
  };
  const make = options.eventSource ?? (typeof EventSource === "undefined" ? null : (url: string) => new EventSource(url));
  if (!make) {
    void poll();
    return finish;
  }
  source = make(`${base}/runs/${encodeURIComponent(runId)}/events`);
  source.addEventListener("started", (e) => emit({ type: "started", data: parse((e as MessageEvent).data) }));
  source.addEventListener("trace", (e) => emit({ type: "trace", data: parse((e as MessageEvent).data) }));
  source.addEventListener("status", (e) => {
    emit({ type: "status", data: parse((e as MessageEvent).data) });
    finish();
  });
  source.addEventListener("error", (e) => {
    if (stopped) return;
    // The API's own `event: error` carries data; a dropped connection does not.
    const data = rec(parse((e as MessageEvent).data));
    if (data?.status === 404) {
      emit({ type: "status", data: { run_id: runId, status: "not_found" } });
      return finish();
    }
    source?.close();
    source = null;
    void poll();
  });
  return finish;
}

/**
 * The final run after the stream ended. GET /runs/{id} can lag the SSE `status` by a checkpoint,
 * so a body still `running` (or without a summary) is re-read a few times. The badge keeps the
 * stream's served_from: a run streamed live is labelled live, whatever the GET says.
 */
export async function resolveFinalRun(
  runId: string,
  streamServedFrom: string | null,
  options: { signal?: AbortSignal; fetchSnapshot?: (runId: string, signal?: AbortSignal) => Promise<Snapshot>; tries?: number; delayMs?: number } = {},
): Promise<RecordedRun | null> {
  const fetchSnap = options.fetchSnapshot ?? ((id: string, signal?: AbortSignal) => fetchRunSnapshot(id, signal));
  const tries = options.tries ?? 5;
  for (let i = 0; i < tries; i += 1) {
    if (options.signal?.aborted) return null;
    const snap = await fetchSnap(runId, options.signal);
    if (snap.run && snap.run.status !== "running") {
      const served = streamServedFrom;
      return served === "live" || served === "cache" || served === "replay" ? { ...snap.run, servedFrom: served } : snap.run;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, options.delayMs ?? 1000));
  }
  return null;
}


/** GET /runs/{id}/approval. 409 when the run is no longer waiting. */
export async function fetchApproval(runId: string, base = apiBaseUrl()): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(`${base}/runs/${encodeURIComponent(runId)}/approval`, { credentials: "omit" });
  let body: Record<string, unknown> | null = null;
  try {
    body = rec(await response.json());
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export async function postApproval(
  runId: string,
  body: unknown,
  base = apiBaseUrl(),
): Promise<{ ok: true; body: Record<string, unknown> | null } | { ok: false; status: number; message: string }> {
  let response: Response;
  try {
    response = await fetch(`${base}/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, status: 0, message: `Could not reach the API (${(error as Error)?.message ?? "network error"}).` };
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (response.ok) return { ok: true, body: rec(parsed) };
  const detail = errorDetail(parsed);
  if (response.status === 422) return { ok: false, status: 422, message: detail ?? "The decision was refused (422)." };
  if (response.status === 409) return { ok: false, status: 409, message: detail ?? "This run is no longer waiting for a decision." };
  return { ok: false, status: response.status, message: `Decision failed (${response.status})${detail ? `: ${detail}` : ""}.` };
}
