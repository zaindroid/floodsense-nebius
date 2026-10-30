import { asWatchStatus, asWatchEvent, parseEvents, type WatchEvent, type WatchStatus } from "../lib/controlTower";
import { apiBaseUrl, apiTimeoutMs } from "./config";

/** The control tower's routes on the API (passed through to the agents). Nothing here throws. */
export type Fetched<T> = { ok: true; value: T } | { ok: false; error: string; status: number | null; retryAfterS: number | null };

function fail(error: string, status: number | null = null, retryAfterS: number | null = null): Fetched<never> {
  return { ok: false, error, status, retryAfterS };
}

async function call(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Fetched<unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), apiTimeoutMs() * 2);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const r = await fetch(`${apiBaseUrl()}${path}`, { ...init, credentials: "omit", cache: "no-store", signal: ctrl.signal });
    const retry = Number(r.headers.get("Retry-After"));
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      /* no body */
    }
    if (!r.ok) return fail(`${init.method ?? "GET"} ${path} returned ${r.status}`, r.status, Number.isFinite(retry) && retry > 0 ? retry : null);
    return { ok: true, value: body };
  } catch {
    return fail(signal?.aborted ? "aborted" : `${path} did not answer`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function fetchWatchStatus(signal?: AbortSignal): Promise<Fetched<WatchStatus>> {
  const r = await call("/watch/status", {}, signal);
  if (!r.ok) return r;
  const status = asWatchStatus(r.value);
  return status ? { ok: true, value: status } : fail("GET /watch/status did not return a status");
}

export async function fetchWatchEvents(since: string | null, limit = 200, signal?: AbortSignal): Promise<Fetched<WatchEvent[]>> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (since) q.set("since", since);
  const r = await call(`/watch/events?${q}`, {}, signal);
  return r.ok ? { ok: true, value: parseEvents(r.value) } : r;
}

/** "Scan now": the agents answer 202 at once and scan on a thread; watch the status for `scanning`. A 429 carries Retry-After. */
export async function postScan(): Promise<Fetched<WatchStatus>> {
  const r = await call("/watch/cycle", { method: "POST" });
  if (!r.ok) return r;
  const status = asWatchStatus((r.value as { status?: unknown } | null)?.status);
  return status ? { ok: true, value: status } : fail("POST /watch/cycle did not return a status");
}

/** The auto-assess switch. Model calls, capped by the service. */
export async function postAutoAssess(enabled: boolean): Promise<Fetched<WatchStatus>> {
  const token = import.meta.env.VITE_WATCH_ADMIN_TOKEN?.trim();
  const r = await call("/watch/auto-assess", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-watch-admin-token": token } : {}) },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) return r;
  const status = asWatchStatus(r.value);
  return status ? { ok: true, value: status } : fail("POST /watch/auto-assess did not return a status");
}

/**
 * New feed events as they happen (SSE). The browser reconnects by itself and resends Last-Event-ID, which the API
 * forwards. `onClosed` runs when the stream cannot be kept (no EventSource, or the browser gave up), so the caller can poll.
 */
export function subscribeWatch(
  since: string | null,
  onEvent: (e: WatchEvent) => void,
  onState: (open: boolean) => void,
): () => void {
  if (typeof EventSource === "undefined") {
    onState(false);
    return () => undefined;
  }
  const q = since ? `?since=${encodeURIComponent(since)}` : "";
  const source = new EventSource(`${apiBaseUrl()}/watch/stream${q}`);
  source.onopen = () => onState(true);
  source.onerror = () => onState(source.readyState === EventSource.OPEN);
  source.addEventListener("watch", (m) => {
    try {
      const ev = asWatchEvent(JSON.parse((m as MessageEvent<string>).data));
      if (ev) onEvent(ev);
    } catch {
      /* a malformed frame is skipped */
    }
  });
  return () => source.close();
}
