import { API_TIMEOUT_MS_DEFAULT } from "../config/scenario";

/** Browser-facing API base. Vite inlines VITE_* into the bundle. Do not put secrets here. */
export function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_URL?.trim();
  const base = configured && configured.length > 0 ? configured : "http://localhost:18000";
  return base.replace(/\/+$/, "");
}

/** Probe timeout. VITE_API_TIMEOUT_MS overrides the documented default. */
export function apiTimeoutMs(): number {
  const raw = import.meta.env.VITE_API_TIMEOUT_MS?.trim();
  if (!raw) return API_TIMEOUT_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return API_TIMEOUT_MS_DEFAULT;
  return parsed;
}

/** GET /config once (agents flags and lanes, passed through by the API). Never throws. */
export async function fetchAgentsConfig(signal?: AbortSignal): Promise<{ kind: "ok"; body: unknown } | { kind: "down" }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), apiTimeoutMs());
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const r = await fetch(`${apiBaseUrl()}/config`, { signal: ctrl.signal, credentials: "omit" });
    return r.ok ? { kind: "ok", body: await r.json() } : { kind: "down" };
  } catch {
    return { kind: "down" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
