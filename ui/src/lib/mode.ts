import type { AskContext } from "./askContext";
import { DEFAULT_EVENT_ID, EVENT_META, type EventId } from "./events";
import { staleStripText, type StaleView } from "./staleness";

/**
 * The one global mode. "live" is the live watch (all 45 sources); "past" is the replay of one chosen flood.
 * It lives in the URL query (`?mode=past&event=EMSR517&demo=1`) so a refresh keeps it; the hash stays the page.
 */
export type Mode = "live" | "past";

export interface ModeState {
  mode: Mode;
  /** The past flood. Kept when the mode is live so switching back to Past remembers it. */
  eventId: EventId;
  /** Demo data: the bundled snapshot instead of the live views. */
  demo: boolean;
}

export const DEFAULT_MODE: ModeState = { mode: "live", eventId: DEFAULT_EVENT_ID, demo: false };

export const PAST_EVENTS: readonly EventId[] = ["EMSR517", "EMSR773"];

function isEvent(value: string | null): value is EventId {
  return value !== null && (PAST_EVENTS as readonly string[]).includes(value);
}

/** Pure: the mode from a `location.search`. Anything unknown falls back to Live, Ahr 2021, no demo. */
export function parseModeSearch(search: string): ModeState {
  const params = new URLSearchParams(search);
  const event = params.get("event");
  return {
    mode: params.get("mode") === "past" ? "past" : "live",
    eventId: isEvent(event) ? event : DEFAULT_EVENT_ID,
    demo: params.get("demo") === "1",
  };
}

/** Pure: the query string for a state ("" for the defaults), without touching other parameters. */
export function modeSearch(state: ModeState, current = ""): string {
  const params = new URLSearchParams(current);
  params.delete("mode");
  params.delete("event");
  params.delete("demo");
  if (state.mode === "past") {
    params.set("mode", "past");
    params.set("event", state.eventId);
  }
  if (state.demo) params.set("demo", "1");
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Pure: the full relative URL (path + query + hash) for a state, so the hash route is never lost. */
export function modeUrl(loc: { pathname: string; search: string; hash: string }, state: ModeState): string {
  return `${loc.pathname}${modeSearch(state, loc.search)}${loc.hash}`;
}

export function writeModeToUrl(state: ModeState): void {
  const loc = window.location;
  const next = modeUrl(loc, state);
  if (next !== `${loc.pathname}${loc.search}${loc.hash}`) window.history.replaceState(null, "", next);
}

export function hhmmOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** How much of the live watch loaded. `total` is the full watch: 26 gauges + 11 GloFAS points + 8 Valencia points. */
export interface LiveHealth {
  loaded: number;
  total: number;
  /** Plain names of the views that failed ("GloFAS points (eu_watch)"). */
  failed: string[];
  loading: boolean;
  /** Views served from the API cache after the live source failed (last good copy). */
  stale?: StaleView[];
}

export const WATCH_TOTAL = 45;

/** Pages whose data demo mode does not touch (they read the live API): the strip says so instead of showing a DEMO chip. */
export function isDemoIsolated(page: string): boolean {
  return !["approvals", "review", "system", "how"].includes(page);
}

/**
 * Pure: the mode sentence of the context strip. It always ends in a final state: a time, "unavailable", or "checking…"
 * only while the live views are really loading.
 */
export function modeStripText(state: ModeState, checkedAt: number | null, health: LiveHealth | null = null, page = "", now = Date.now()): string {
  if (state.mode === "past") return `Past flood: ${EVENT_META[state.eventId].short} (replay)`;
  if (state.demo) return isDemoIsolated(page) ? "Demo data · bundled snapshot, not live" : "Live data (demo mode only affects the watch views)";
  const partial = health && health.failed.length > 0 && !health.loading ? ` · ${health.loaded} of ${health.total} sources` : "";
  const old = health && !health.loading ? staleStripText(health.stale ?? [], now) : null;
  if (old) return `Live data · ${old}`;
  if (checkedAt !== null) return `Live data · checked ${hhmmOf(checkedAt)} UTC${partial}`;
  if (!health || health.loading) return "Live data · checking…";
  return "Live data · unavailable";
}

/** Short mode name for sentences: "Live" or "Past flood: Ahr 2021". */
export function modeName(state: ModeState): string {
  return state.mode === "past" ? `Past flood: ${EVENT_META[state.eventId].short}` : "Live";
}

/** Pure: Live never carries an event or replay date, whatever a page put in its own context. */
export function contextForMode(ctx: AskContext | null, mode: Mode): AskContext | null {
  if (!ctx || mode === "past") return ctx;
  const { event_id: _event, replay_date: _date, ...rest } = ctx;
  return Object.keys(rest).length ? rest : null;
}
