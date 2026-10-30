import type { SystemStatus, ViewReads } from "./system";

/** Status dot on a How it works box. */
export type DotState = "ok" | "partial" | "off" | "down" | "unknown";

export const DOT_TEXT: Record<DotState, string> = {
  ok: "running",
  partial: "partly unavailable",
  off: "switched off",
  down: "not reachable",
  unknown: "status unknown",
};

export type BoxId = "router" | "agents" | "zetaris" | "feeds" | "nightshift" | "memory" | "rag" | "redis" | "human";

/** GET /config result: the body, or "down" when the API could not be read. */
export type ConfigProbe = { kind: "ok"; body: unknown } | { kind: "down" };

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The agents' /config body (the API passes it through, possibly in a `data` envelope). */
function configBody(p: ConfigProbe): Record<string, unknown> | null {
  if (p.kind !== "ok") return null;
  const body = rec(p.body);
  return rec(body?.data) ?? body;
}

function flag(config: Record<string, unknown> | null, name: string): DotState {
  const v = rec(config?.flags)?.[name];
  if (v === true) return "ok";
  if (v === false) return "off";
  return "unknown";
}

export const VIEW_WINDOW_MS = 15 * 60_000;

/**
 * Pure: the Zetaris dot from the API's view-read stats (GET /system views_cache) and this page's own gauge_levels read.
 * A view fails when its last upstream error is under 15 minutes old. running: reads work and none fail; partly
 * unavailable (amber): some fail, or only the gauge read worked; not reachable: every read fails. A 429 is a rate
 * limit, never red: it is worded as "feed rate-limited by Open-Meteo". No stats and no gauge read: unknown.
 */
export function zetarisHealth(
  views: Readonly<Record<string, ViewReads>> | null | undefined,
  gauge: "rows" | "empty" | "unavailable" | null = null,
  now: number = Date.now(),
): { state: DotState; note: string | null } {
  const entries = Object.entries(views ?? {});
  // Failing: an error inside the window and newer than the last success. A bad timestamp counts as old.
  const failing = entries.filter(([, v]) => {
    if (v.lastError === null) return false;
    const err = Date.parse(v.lastError.at);
    if (!(now - err < VIEW_WINDOW_MS)) return false;
    const ok = v.lastOkAt ? Date.parse(v.lastOkAt) : NaN;
    return !(ok >= err);
  });
  const working = entries.filter(([name, v]) => v.hits + v.misses - v.staleServes > 0 && !failing.some(([n]) => n === name));
  const limited = failing.some(([, v]) => /\b429\b/.test(v.lastError?.detail ?? ""));
  const limitedNote = "feed rate-limited by Open-Meteo";
  const names = failing.map(([n]) => n).join(", ");
  if (failing.length === 0) {
    if (working.length > 0) return { state: "ok", note: null };
    if (gauge === "rows" || gauge === "empty") return { state: "ok", note: null };
    return { state: gauge === "unavailable" ? "down" : "unknown", note: null };
  }
  if (working.length > 0 || gauge === "rows") return { state: "partial", note: limited ? limitedNote : `some views are failing: ${names}` };
  if (limited) return { state: "partial", note: limitedNote };
  return { state: "down", note: `every view read is failing: ${names}` };
}

/**
 * Pure: every box's dot from GET /config and GET /system (api/app/system.py, parsed by `parseSystem`).
 * `system` is null when /system could not be read (404 on an older API, or down): those boxes fall back
 * to /config or stay unknown, never red.
 */
export function boxStatuses(config: ConfigProbe, system: SystemStatus | null, gauge: "rows" | "empty" | "unavailable" | null = null, now: number = Date.now()): Record<BoxId, DotState> {
  const cfg = configBody(config);
  const agentsUp: DotState = cfg ? "ok" : "down";
  const lanes = system ? system.models.lanes : (rec(cfg?.lanes) as Record<string, unknown> | null);
  const hasLanes = Boolean(lanes && Object.values(lanes).some((v) => typeof v === "string" && v));
  return {
    router: agentsUp,
    agents: system ? (system.models.ok ? "ok" : "down") : agentsUp,
    // No Zetaris health route: judged by whether the API's view reads work (see zetarisHealth).
    zetaris: zetarisHealth(system?.viewsCache, gauge, now).state,
    feeds: cfg ? (rec(cfg.flags)?.FF_LIVE_DATA === true ? "ok" : "off") : "unknown",
    nightshift: hasLanes ? "ok" : system && !system.models.ok ? "down" : "unknown",
    memory: system
      ? system.memory.ok && (!system.engines.configured || system.engines.ok)
        ? "ok"
        : "down"
      : flag(cfg, "FF_HMEM"),
    rag: system && system.rag.enabled !== null ? (system.rag.enabled ? "ok" : "off") : flag(cfg, "FF_RAG_DOCS"),
    redis: system ? (system.cache.backend === "redis" ? "ok" : system.cache.backend === "unknown" ? "unknown" : "off") : "unknown",
    human: flag(cfg, "FF_HITL"),
  };
}

/** The approval box, by desk: insurers approve outbound alerts; a citizen's answers are not held back. */
export function humanBox(role: "citizen" | "insurer" | "operator"): { title: string; line: string } {
  return role === "citizen"
    ? {
        title: "A person checks insurer alerts",
        line: "Insurer alerts are checked by a person before they're sent. Your answers aren't held back.",
      }
    : role === "operator"
      ? { title: "Your approval", line: "A person at your authority approves, edits or rejects each proposed action. Nothing is sent before that." }
      : { title: "Human approval", line: "A person approves, edits or rejects the advice. Nothing is sent before that." };
}

/** "live feeds" or "seed data" for the data box, from FF_LIVE_DATA. */
export function feedsMode(config: ConfigProbe): "live feeds" | "seed data" | null {
  const cfg = configBody(config);
  if (!cfg) return null;
  return rec(cfg.flags)?.FF_LIVE_DATA === true ? "live feeds" : "seed data";
}
