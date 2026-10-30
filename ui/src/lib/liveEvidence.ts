import type { WatchSource } from "./euWatch";
import type { MemoryUsed } from "./hitl";
import { memoryLabel, type SourceLink } from "./sources";

/**
 * What the right-side Evidence drawer says about one live data point (or a replay moment, or an agent
 * answer's memories): how the number was fetched, the Zetaris query id and times, licence and upstream link.
 * Pure; every field comes from the view response or the fixed pipeline of that view.
 */
export interface LiveEvidence {
  title: string;
  /** "Measured water level", "Model forecast", ... */
  kind: string;
  /** Pipeline from the upstream feed to the view, as steps. */
  pipeline: string[];
  view: string;
  queryId: string | null;
  measuredAt: string | null;
  /** "Measured" for a gauge reading; "Modelled" for a model hour or day (and replay rows). */
  timeLabel: "Measured" | "Modelled";
  fetchedAt: string | null;
  licence: string;
  link: SourceLink | null;
  /** "Not an official warning" and similar notes. */
  notes: string[];
  /** Live, Stale, Seed, Replay. */
  freshness: string;
  memories: { label: string; text: string }[];
}

export const GAUGE_PIPELINE = [
  "PEGELONLINE REST (WSV)",
  "FloodSense poller every 10 min",
  "Zetaris file store",
  "view floodsense.gauge_levels",
];
export const GLOFAS_PIPELINE = ["Open-Meteo Flood API", "Zetaris REST table", "view floodsense.eu_watch"];
export const HAZARD_NOW_PIPELINE = ["Open-Meteo Flood + Weather API", "Zetaris REST table", "view floodsense.hazard_now"];

export const PEGELONLINE_LINK: SourceLink = { href: "https://www.pegelonline.wsv.de/", label: "WSV PEGELONLINE" };
export const GLOFAS_LINK: SourceLink = { href: "https://open-meteo.com/en/docs/flood-api", label: "Open-Meteo Flood API (GloFAS)" };
export const RAIN_LINK: SourceLink = {
  href: "https://open-meteo.com/en/docs/historical-weather-api",
  label: "Open-Meteo historical weather API",
};

export const NOT_OFFICIAL = "Not an official warning. Follow your national warning service.";

export interface ViewMeta {
  queryId: string | null;
  executedAt?: string | null;
  fetchedAt?: number | null;
}

function fetched(meta: ViewMeta): string | null {
  if (meta.executedAt) return meta.executedAt;
  return typeof meta.fetchedAt === "number" ? new Date(meta.fetchedAt).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

/** Evidence for one live-watch source. */
export function evidenceForSource(s: WatchSource, meta: ViewMeta): LiveEvidence {
  const where = s.river ? `${s.river} at ${s.name}` : s.name;
  const freshness = s.live ? "Live" : s.kind === "gauge" ? "Stale or seed (not a fresh live reading)" : "Seed or no model reading";
  if (s.kind === "gauge") {
    return {
      title: where,
      kind: "Measured water level (PEGELONLINE gauge)",
      pipeline: GAUGE_PIPELINE,
      view: "floodsense.gauge_levels",
      queryId: meta.queryId,
      measuredAt: s.measuredAt,
      timeLabel: "Measured",
      fetchedAt: fetched(meta),
      licence: "Data licence Germany – Zero – 2.0 (DL-DE-Zero-2.0) · Quelle: WSV, PEGELONLINE",
      link: PEGELONLINE_LINK,
      notes: [
        "Status compares the level with the station's MHW, the long-term mean high water published by PEGELONLINE (not a warning level). Watch means the level is within 25 % of the MW..MHW span below MHW (level ≥ MHW − 0.25 × (MHW − MW)), FloodSense's own cut.",
        NOT_OFFICIAL,
      ],
      freshness,
      memories: [],
    };
  }
  if (s.kind === "model") {
    return {
      title: where,
      kind: "Model forecast (GloFAS)",
      pipeline: GLOFAS_PIPELINE,
      view: "floodsense.eu_watch",
      queryId: meta.queryId,
      measuredAt: s.measuredAt,
      timeLabel: "Modelled",
      fetchedAt: fetched(meta),
      licence: "CC BY 4.0 · Weather data by Open-Meteo.com (Copernicus GloFAS)",
      link: GLOFAS_LINK,
      notes: ["Model band: 7-day forecast max against the point's past-30-day median. Model, not measured.", NOT_OFFICIAL],
      freshness,
      memories: [],
    };
  }
  return {
    title: where,
    kind: "Model forecast (GloFAS, Valencia point)",
    pipeline: HAZARD_NOW_PIPELINE,
    view: "floodsense.hazard_now",
    queryId: meta.queryId,
    measuredAt: s.measuredAt,
    timeLabel: "Modelled",
    fetchedAt: fetched(meta),
    licence: "CC BY 4.0 · Weather data by Open-Meteo.com (Copernicus GloFAS)",
    link: GLOFAS_LINK,
    notes: ["Status compares the point with its own past three days (2x and 4x its median), not an official threshold.", NOT_OFFICIAL],
    freshness,
    memories: [],
  };
}

/** Evidence for one replay story moment: the replay rows' own source. */
export function evidenceForReplay(
  title: string,
  at: string,
  source: { fromZetaris: boolean; badge: string },
  topic: "rain" | "discharge",
  thresholdM3s: number,
): LiveEvidence {
  return {
    title,
    kind: topic === "rain" ? "Hourly rain (ERA5 reanalysis)" : "River flow (GloFAS daily, modelled)",
    timeLabel: "Modelled",
    pipeline: source.fromZetaris
      ? ["Open-Meteo archive (prep CSV)", "Zetaris seed tables", "view floodsense_seed.hazard_timeline"]
      : ["Open-Meteo archive (prep CSV)", "bundled UI fixture (not from Zetaris)"],
    view: source.fromZetaris ? "floodsense_seed.hazard_timeline" : "bundled fixture",
    queryId: null,
    measuredAt: at,
    fetchedAt: null,
    licence: "CC BY 4.0 · Weather data by Open-Meteo.com",
    link: topic === "rain" ? RAIN_LINK : GLOFAS_LINK,
    notes: [
      source.badge,
      `Replay of a past event, not live. The ${thresholdM3s} m³/s line is the FloodSense Watchers line, not an official threshold.`,
    ],
    freshness: "Replay",
    memories: [],
  };
}

/** Evidence for an agent answer: the H-MEM memories the run recalled (run level, never per sentence). */
export function evidenceForMemories(memories: readonly MemoryUsed[]): LiveEvidence {
  return {
    title: "Memories used",
    kind: "Approved findings recalled by H-MEM",
    pipeline: ["Person approves a finding", "Meterless H-MEM", "Memory agent recall for this run"],
    view: "H-MEM",
    queryId: null,
    measuredAt: null,
    timeLabel: "Modelled",
    fetchedAt: null,
    licence: "FloodSense approved findings",
    link: null,
    notes: ["Context for the whole run; not linked to any one sentence."],
    freshness: "Run",
    memories: memories.map((m) => ({ label: memoryLabel(m), text: m.text })),
  };
}
