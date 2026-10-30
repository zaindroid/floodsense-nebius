// The team's API, same origin under /api (the proxy in front strips the prefix).

const BASE = "/api";

async function call(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : `HTTP ${r.status}`;
    const err = new Error(detail);
    err.status = r.status;
    err.retryAfter = Number(r.headers.get("retry-after")) || null;
    throw err;
  }
  return data;
}

export const get = (path) => call("GET", path);
export const post = (path, body) => call("POST", path, body);

/** The run's own event stream: started, one trace entry per step, then status. */
export function streamRun(runId, on) {
  const es = new EventSource(`${BASE}/runs/${encodeURIComponent(runId)}/events`);
  for (const kind of ["started", "trace", "status"]) {
    es.addEventListener(kind, (ev) => {
      let data = null;
      try { data = JSON.parse(ev.data); } catch { return; }
      on(kind, data);
      if (kind === "status" && data?.status !== "running") es.close();
    });
  }
  es.onerror = () => on("error", null);
  return () => es.close();
}

// Runs started in this browser, so Decide can list them.
const MINE = "fs.myRuns";
export function rememberRun(run) {
  const list = myRuns().filter((r) => r.id !== run.id);
  list.unshift(run);
  localStorage.setItem(MINE, JSON.stringify(list.slice(0, 20)));
}
export function myRuns() {
  try { return JSON.parse(localStorage.getItem(MINE) || "[]"); } catch { return []; }
}
