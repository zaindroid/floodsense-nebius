import type { WatchAgent, WatchEvent, WatchKind, WatchStatus, WatchTone } from "../../../contracts/typescript/index";
import {
  GAUGE_PIPELINE,
  GLOFAS_LINK,
  GLOFAS_PIPELINE,
  HAZARD_NOW_PIPELINE,
  NOT_OFFICIAL,
  PEGELONLINE_LINK,
  type LiveEvidence,
} from "./liveEvidence";

/**
 * Control tower: the pure parts. The watch loop runs in the agents service (rule-based, no model calls);
 * this file validates what the API sends, merges and filters the feed, and words the tiles. Nothing here
 * invents a number: every figure shown comes from an event or the status the service returned.
 */
export type { WatchAgent, WatchEvent, WatchKind, WatchStatus, WatchTone };

export const HONEST_LABEL =
  "Rule-based watchers: no model calls. Model-written work only appears when a full investigation is started.";
export const AUTO_ASSESS_LABEL = "Auto-assess the worst new source (uses model calls, capped)";
export const FEED_CAP = 500;

export const AGENTS: readonly WatchAgent[] = ["Watch", "Forecast", "Exposure", "Playbook", "Judge", "Human"];
const KINDS: readonly WatchKind[] = ["detected", "checked", "exposure", "drafted", "awaiting_approval", "approved", "info"];
const TONES: readonly WatchTone[] = ["normal", "watch", "elevated", "neutral", "unknown"];

/** What each agent does, for the filter and the row's tooltip. */
export const AGENT_ROLE: Record<WatchAgent, string> = {
  Watch: "reads the gauges and models every scan",
  Forecast: "checks the forecast for anything raised",
  Exposure: "counts insured sites near it",
  Playbook: "drafts the notice for a person",
  Judge: "checks the claims, then waits for a person",
  Human: "approves or rejects",
};

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A feed event from the wire, or null when it is not one (a bad row is dropped, never guessed at). */
export function asWatchEvent(value: unknown): WatchEvent | null {
  const r = rec(value);
  if (!r) return null;
  const id = str(r.id);
  const ts = str(r.ts);
  const text = str(r.text);
  const kind = r.kind as WatchKind;
  const agent = r.agent as WatchAgent;
  const tone = r.tone as WatchTone;
  const source = rec(r.source);
  if (!id || !/^w\d{8}$/.test(id) || !ts || !text || !KINDS.includes(kind) || !AGENTS.includes(agent) || !TONES.includes(tone) || !source) return null;
  const view = str(source.view);
  if (!view) return null;
  return {
    id,
    ts,
    kind,
    agent,
    place_id: str(r.place_id),
    place: str(r.place) ?? "",
    river: str(r.river) ?? "",
    country: str(r.country) ?? "",
    status: str(r.status) ?? "",
    tone,
    text,
    run_id: str(r.run_id),
    source: { view, query_id: str(source.query_id) },
    detail: str(r.detail),
    data: rec(r.data) ?? {},
  };
}

export function parseEvents(body: unknown): WatchEvent[] {
  const list = rec(body)?.events;
  if (!Array.isArray(list)) return [];
  return list.map(asWatchEvent).filter((e): e is WatchEvent => e !== null);
}

/** The status object, checked for the fields the page reads; null when the body is not a status. */
export function asWatchStatus(value: unknown): WatchStatus | null {
  const r = rec(value);
  const loop = rec(r?.loop);
  const counts = rec(r?.counts);
  const auto = rec(r?.auto_assess);
  if (!r || !loop || !counts || !auto) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    note: str(r.note) ?? HONEST_LABEL,
    loop: {
      enabled: loop.enabled === true,
      alive: loop.alive === true,
      interval_s: n(loop.interval_s),
      next_cycle_at: str(loop.next_cycle_at),
    },
    scanning: r.scanning === true,
    started_at: str(r.started_at) ?? "",
    last_cycle: rec(r.last_cycle),
    counts: { sources: n(counts.sources), elevated: n(counts.elevated), events: n(counts.events), awaiting_approval: n(counts.awaiting_approval) },
    latest_event_id: str(r.latest_event_id),
    awaiting_run_ids: Array.isArray(r.awaiting_run_ids) ? r.awaiting_run_ids.filter((x): x is string => typeof x === "string") : [],
    auto_assess: {
      enabled: auto.enabled === true,
      per_hour: n(auto.per_hour),
      per_day: n(auto.per_day),
      used_hour: n(auto.used_hour),
      used_day: n(auto.used_day),
      next_allowed_at: str(auto.next_allowed_at),
      uses_model_calls: true,
      blocked: str(auto.blocked),
    },
    persisted: r.persisted === true,
    persisted_reason: str(r.persisted_reason),
    served_from: r.served_from === "live" || r.served_from === "cache" ? r.served_from : "replay",
    cached_at: str(r.cached_at),
  };
}

/** The sequence number in an event id: "w00000012" -> 12. The badge shows it, so a source number never shifts. */
export function eventNumber(id: string): number {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/**
 * Identical consecutive failures of one feed share `data.dedupe_key`; the newest of each key is the one row
 * the feed shows (its `data.repeats` and `data.since` give "x N since HH:MM").
 */
export function collapseRepeats(events: readonly WatchEvent[]): WatchEvent[] {
  const last = new Map<string, string>();
  for (const e of events) {
    const k = e.data.dedupe_key;
    if (typeof k === "string") last.set(k, e.id);
  }
  return events.filter((e) => {
    const k = e.data.dedupe_key;
    return typeof k !== "string" || last.get(k) === e.id;
  });
}

/** "x 3 since 14:05" for a failure that repeated; null for a single occurrence. */
export function repeatNote(e: WatchEvent): string | null {
  const n = e.data.repeats;
  if (typeof n !== "number" || n < 2) return null;
  const since = typeof e.data.since === "string" && /^\d{2}:\d{2}$/.test(e.data.since) ? ` since ${e.data.since}` : "";
  return `\u00d7${n}${since}`;
}

/** Add `incoming` to `prev` by id, oldest first, at most `cap` kept (the newest). */
export function mergeEvents(prev: readonly WatchEvent[], incoming: readonly WatchEvent[], cap = FEED_CAP): WatchEvent[] {
  const byId = new Map<string, WatchEvent>();
  for (const e of prev) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  const all = [...byId.values()].sort((a, b) => eventNumber(a.id) - eventNumber(b.id));
  return all.length > cap ? all.slice(all.length - cap) : all;
}

export interface FeedFilter {
  agent: WatchAgent | "all";
  place: string;
}

/** Newest first. `place` is a place_id, or "all". An event about the loop itself has no place and shows only under "all". */
export function filterEvents(events: readonly WatchEvent[], f: FeedFilter): WatchEvent[] {
  return [...events]
    .filter((e) => (f.agent === "all" || e.agent === f.agent) && (f.place === "all" || f.place === "" || e.place_id === f.place))
    .sort((a, b) => eventNumber(b.id) - eventNumber(a.id));
}

/** Places that appear in the feed, for the filter: id and a label ("Rhine · Köln"), sorted by label. */
export function placeOptions(events: readonly WatchEvent[]): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const e of events) {
    if (e.place_id && !seen.has(e.place_id)) seen.set(e.place_id, e.river ? `${e.river} · ${e.place}` : e.place);
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/** "14:52" in UTC, from an ISO instant; "" when it does not parse. */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** The time on a feed row: "14:52 UTC". */
export function eventTime(iso: string): string {
  const t = hhmm(iso);
  return t ? `${t} UTC` : iso;
}

/** "00:07" elapsed since `fromIso`, for "First scan running…". */
export function elapsedText(fromIso: string | null | undefined, nowMs: number): string {
  const from = fromIso ? new Date(fromIso).getTime() : NaN;
  if (Number.isNaN(from)) return "00:00";
  const s = Math.max(0, Math.floor((nowMs - from) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export interface Tiles {
  watched: number;
  elevated: number;
  lastScan: string;
  awaiting: number;
  autoAssess: "ON" | "OFF";
}

/**
 * The numbers of the top row. The scan's own counts win; before the first scan the live views' counts stand in
 * (`fallback`), so the tiles are never zeros that look like "all clear".
 */
export function tiles(status: WatchStatus | null, fallback: { watched: number; elevated: number }): Tiles {
  const scanned = !!status?.last_cycle;
  const last = status?.last_cycle ? hhmm(String(status.last_cycle.finished_at ?? "")) : "";
  return {
    watched: scanned ? status!.counts.sources : fallback.watched,
    elevated: scanned ? status!.counts.elevated : fallback.elevated,
    lastScan: last || "not yet",
    awaiting: status?.counts.awaiting_approval ?? 0,
    autoAssess: status?.auto_assess.enabled ? "ON" : "OFF",
  };
}

/** "45 sources watched · 5 elevated · last scan 14:52 · 1 run awaiting approval · auto-assess OFF" */
export function kpiLine(t: Tiles): string {
  const runs = `${t.awaiting} ${t.awaiting === 1 ? "run" : "runs"} awaiting approval`;
  const last = t.lastScan === "not yet" ? "no scan yet" : `last scan ${t.lastScan}`;
  return `${t.watched} ${t.watched === 1 ? "source" : "sources"} watched · ${t.elevated} elevated · ${last} · ${runs} · auto-assess ${t.autoAssess}`;
}

/** The caps under the switch, from the service's own numbers. A blocked switch says why instead. */
export function capsText(a: WatchStatus["auto_assess"] | null): string {
  if (!a) return "At most 1 per hour and 3 per day.";
  if (a.blocked) return `Off, and it cannot be switched on here: ${a.blocked}`;
  const when = a.next_allowed_at ? ` Next allowed after ${hhmm(a.next_allowed_at)} UTC.` : "";
  return `At most ${a.per_hour} per hour and ${a.per_day} per day · used ${a.used_hour} this hour, ${a.used_day} in 24 h.${when} It never approves anything: a person decides in Approvals.`;
}

/** Why the page cannot show a live feed: loop off, not yet scanned, or running the first scan. */
export type LoopState = "down" | "loading" | "off" | "first" | "running";

export function loopState(opts: { reachable: boolean | null; status: WatchStatus | null; demo?: boolean }): LoopState {
  // Demo data: the recorded feed is the page, so an unreachable live service is never the main state.
  if (opts.demo) return opts.status?.last_cycle ? "running" : "loading";
  if (opts.reachable === false) return "down";
  if (!opts.status) return "loading";
  if (opts.status.last_cycle) return "running";
  if (!opts.status.loop.enabled) return "off";
  return "first";
}

/** "demo" when the page was opened with ?mode=demo (also in the hash query); else "live". */
export function appMode(search: string, hash: string): "demo" | "live" {
  const q = (s: string) => new URLSearchParams(s.startsWith("?") ? s : `?${s}`).get("mode");
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  return q(search) === "demo" || q(hashQuery) === "demo" ? "demo" : "live";
}

/** Demo mode: a small hint (never the main message) when the live agents service does not answer either. */
export const DEMO_LIVE_DOWN_HINT = "The live agents service is not reachable right now; the recorded feed below does not need it.";

export function unreachableText(mode: "demo" | "live"): string {
  return mode === "demo"
    ? "The agents service is not reachable, so the watch loop cannot be read. You can look at recorded demo data instead; it is labelled and not live."
    : "The agents service is not reachable, so the watch loop cannot be read and nothing on this page is live. Try again in a minute.";
}

/** Announce rarely: at most one summary per `gapMs`, and only for events worth interrupting for. */
export function announcement(fresh: readonly WatchEvent[], lastAt: number, now: number, gapMs = 30_000): string | null {
  if (now - lastAt < gapMs) return null;
  const notable = fresh.filter((e) => e.kind === "detected" || e.kind === "awaiting_approval" || e.kind === "approved");
  if (!notable.length) return null;
  const last = notable[notable.length - 1];
  const more = notable.length > 1 ? ` and ${notable.length - 1} more` : "";
  return `${last.agent}: ${last.text}${more}`;
}

/** A row that links to Approvals: a run is waiting for a person. */
export function canOpenApprovals(e: WatchEvent, awaiting: readonly string[]): boolean {
  return e.kind === "awaiting_approval" && !!e.run_id && awaiting.includes(e.run_id);
}

/** The Ask question prefilled for a place in the feed. Plain words, no number. */
export function askQuestionFor(e: Pick<WatchEvent, "place" | "river">): string {
  const where = e.river ? `the ${e.river} at ${e.place}` : e.place;
  return `Is ${where} at risk right now, and what should we do?`;
}

const SOURCE_VIEWS = new Set(["gauge_levels", "eu_watch", "hazard_now", "weather_forecast", "exposure_join"]);

/** An event whose numbers came from a Zetaris view gets a [n] source badge; events about runs or the loop do not. */
export function hasSource(e: WatchEvent): boolean {
  return SOURCE_VIEWS.has(e.source.view);
}

const WEATHER_LINK = { href: "https://open-meteo.com/en/docs/dwd-api", label: "Open-Meteo forecast API (DWD ICON)" };
const OSM_LINK = { href: "https://www.openstreetmap.org/copyright", label: "OpenStreetMap contributors (ODbL)" };

/** What the Evidence drawer says about one feed event: the view and query id the service recorded, and the fixed pipeline. */
export function evidenceForEvent(e: WatchEvent): LiveEvidence {
  const where = e.river ? `${e.river} at ${e.place}` : e.place || "Watch loop";
  const base = {
    title: where,
    queryId: e.source.query_id,
    measuredAt: e.ts,
    fetchedAt: e.ts,
    freshness: "Recorded by the watch loop",
    memories: [],
  };
  switch (e.source.view) {
    case "gauge_levels":
      return {
        ...base,
        kind: "Measured water level (PEGELONLINE gauge)",
        pipeline: GAUGE_PIPELINE,
        view: "floodsense.gauge_levels",
        timeLabel: "Measured",
        licence: "Data licence Germany – Zero – 2.0 (DL-DE-Zero-2.0) · Quelle: WSV, PEGELONLINE",
        link: PEGELONLINE_LINK,
        notes: ["Status compares the level with the station's long-term mean high water (not a warning level).", NOT_OFFICIAL],
      };
    case "eu_watch":
      return {
        ...base,
        kind: "Model forecast (GloFAS)",
        pipeline: GLOFAS_PIPELINE,
        view: "floodsense.eu_watch",
        timeLabel: "Modelled",
        licence: "CC BY 4.0 · Weather data by Open-Meteo.com (Copernicus GloFAS)",
        link: GLOFAS_LINK,
        notes: ["Model band: 7-day forecast max against the point's past-30-day median. Model, not measured.", NOT_OFFICIAL],
      };
    case "hazard_now":
      return {
        ...base,
        kind: "Model forecast (GloFAS, Valencia point)",
        pipeline: HAZARD_NOW_PIPELINE,
        view: "floodsense.hazard_now",
        timeLabel: "Modelled",
        licence: "CC BY 4.0 · Weather data by Open-Meteo.com (Copernicus GloFAS)",
        link: GLOFAS_LINK,
        notes: ["Status compares each point with its own past rows (above twice and far above four times their median), not an official threshold.", NOT_OFFICIAL],
      };
    case "weather_forecast":
      return {
        ...base,
        kind: "Rain forecast (DWD ICON via Open-Meteo)",
        pipeline: ["Open-Meteo forecast API (DWD ICON)", "Zetaris REST table", "view floodsense.weather_forecast"],
        view: "floodsense.weather_forecast",
        timeLabel: "Modelled",
        licence: "CC BY 4.0 · Weather data by Open-Meteo.com, model DWD ICON",
        link: WEATHER_LINK,
        notes: ["FloodSense's own screening cuts: 25 / 50 mm in 48 h, 20 / 30 mm in an hour. Rule-based, not an official warning.", NOT_OFFICIAL],
      };
    default:
      return {
        ...base,
        kind: "Insured sites of the demo book",
        pipeline: ["Synthetic insurer portfolio + OSM sites", "Zetaris", "view floodsense.exposure_join"],
        view: "floodsense.exposure_join",
        timeLabel: "Modelled",
        licence: "Synthetic portfolio (demo data) · © OpenStreetMap contributors (ODbL)",
        link: OSM_LINK,
        notes: ["Counts insured sites within about 25 km of the source. The portfolio is synthetic and covers Valencia only."],
      };
  }
}
