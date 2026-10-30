import type { ReplayCitation } from "../api/replay";
import type { Answer, Citation } from "../types/contract";
import type { MemoryUsed } from "./hitl";

/**
 * Grounded sources per claim. One plain record per numbered badge, from either the contract Citation
 * (Overview) or an adopted run citation (Ask chat). Layer a = data via Zetaris, b = provenance row,
 * c = document passage. Memory is run-level H-MEM recall.
 */
export type SourceKind = "zetaris" | "provenance" | "document" | "memory";

export interface SourceLink {
  href: string;
  label: string;
}

export interface SourceDetail {
  kind: SourceKind;
  /** "Data via Zetaris", "Provenance", "Document", "Approved memory". */
  heading: string;
  title: string;
  /** Short facts: view, query id, publisher, page. */
  facts: string[];
  quote: string | null;
  link: SourceLink | null;
}

export const SOURCE_LEGEND = "Every sentence links to its source: data via Zetaris, documents, or approved memory.";

/** The answer's own event id (EMSR773, EMSR517 or LIVE-EU), or null when the body carries none. Never a fallback. */
export function answerEventId(answer: Answer): string | null {
  const v = (answer as unknown as { event_id?: unknown }).event_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

const GLOFAS: SourceLink = { href: "https://open-meteo.com/en/docs/flood-api", label: "Open-Meteo Flood API (GloFAS)" };

/** exposure_join rows are the synthetic insurer book joined to OSM sites, not an observed event layer. */
export const SYNTHETIC_PORTFOLIO: SourceLink = {
  href: "https://github.com/GenAI-Open-Agent-Hackathon/FloodSenseEU-Hackathon-Monorepo/blob/main/ingestion/prep/synthetic_portfolio.py",
  label: "Synthetic insurer portfolio (demo data) · OSM sites",
};

/** Copernicus EMS activation page for an EMSR event id; null for any other event (LIVE-EU has no activation). */
function cemsLink(eventId: string | null | undefined): SourceLink | null {
  return eventId && /^EMSR\d+$/.test(eventId)
    ? { href: `https://mapping.emergency.copernicus.eu/activations/${eventId}`, label: `Copernicus EMS ${eventId}` }
    : null;
}

/**
 * The upstream source of a Zetaris view (from the provenance view rows and docs/legal/sources.md).
 * `field` is the column a claim cites, when known: footprint columns (`in_footprint`) of exposure_join come
 * from the Copernicus activation of `eventId` (the run's or answer's event, never a fallback); the rest of
 * exposure_join is the synthetic portfolio. Null when unknown.
 */
export function upstreamFor(view: string, eventId?: string | null, field?: string | null): SourceLink | null {
  if (/eu_watch/i.test(view)) return { ...GLOFAS, label: "Open-Meteo Flood API (GloFAS) · model, not an official warning" };
  if (/discharge/i.test(view)) return GLOFAS;
  if (/hazard_timeline|rain/i.test(view)) {
    return { href: "https://open-meteo.com/en/docs/historical-weather-api", label: "Open-Meteo historical weather API" };
  }
  if (/gauge|pegel/i.test(view)) return { href: "https://www.pegelonline.wsv.de/", label: "WSV PEGELONLINE" };
  if (/footprint/i.test(view) || /footprint/i.test(field ?? "")) return cemsLink(eventId);
  if (/exposure|portfolio/i.test(view)) return SYNTHETIC_PORTFOLIO;
  return null;
}

/** "Seed data" for a floodsense_seed.* view, so a seeded number is never shown as a live feed. */
function seedNote(view: string): string[] {
  return /floodsense_seed\./.test(view) ? ["Seed data (recorded rows)"] : [];
}

function pageFact(page: number | null | undefined, paragraph?: number | null): string[] {
  if (page === null || page === undefined) return [];
  return [paragraph ? `Page ${page}, paragraph ${paragraph}` : `Page ${page}`];
}

function safeLink(url: string | null | undefined, label: string): SourceLink | null {
  return url && /^https?:\/\//i.test(url) ? { href: url, label } : null;
}

/** Pure: a contract citation (Overview, Evidence) as one source record. */
export function sourceFromCitation(c: Citation, eventId?: string | null): SourceDetail {
  if (c.layer === "a") {
    const upstream = upstreamFor(c.title, eventId) ?? safeLink(c.source_url, "Upstream source");
    return {
      kind: "zetaris",
      heading: "Data via Zetaris",
      title: c.title,
      facts: [`View ${c.title}`, ...(c.query_id ? [`Query id ${c.query_id}`] : []), ...seedNote(c.title)],
      quote: c.quote ?? null,
      link: upstream,
    };
  }
  if (c.layer === "b") {
    return {
      kind: "provenance",
      heading: "Provenance",
      title: c.title,
      facts: [c.publisher, c.licence].filter(Boolean),
      quote: c.quote ?? null,
      link: safeLink(c.source_url, c.title),
    };
  }
  return {
    kind: "document",
    heading: "Document",
    title: c.title,
    facts: [c.publisher, ...pageFact(c.locator?.page ?? null, c.locator?.paragraph ?? null)].filter(Boolean),
    quote: c.quote ?? null,
    link: safeLink(c.source_url, c.publisher ? `${c.publisher} source` : "Source"),
  };
}

/** Pure: an adopted run citation (Ask chat) as one source record. */
export function sourceFromRun(c: ReplayCitation, eventId?: string | null): SourceDetail {
  if (c.layer === "a") {
    return {
      kind: "zetaris",
      heading: "Data via Zetaris",
      title: c.title,
      facts: [`View ${c.title}`, ...(c.queryId ? [`Query id ${c.queryId}`] : []), ...seedNote(c.title)],
      quote: c.quote,
      link: upstreamFor(c.title, eventId) ?? safeLink(c.sourceUrl, "Upstream source"),
    };
  }
  if (c.layer === "b") {
    return {
      kind: "provenance",
      heading: "Provenance",
      title: c.title,
      facts: [c.publisher, c.licence].filter((x): x is string => Boolean(x)),
      quote: c.quote,
      link: safeLink(c.sourceUrl, c.title),
    };
  }
  return {
    kind: "document",
    heading: "Document",
    title: c.title,
    facts: [c.publisher ?? "Unknown publisher", ...pageFact(c.page, c.paragraph)],
    quote: c.quote,
    link: safeLink(c.sourceUrl, c.publisher ? `${c.publisher} source` : "Source"),
  };
}

/** "H-MEM · approved run <id>", or "H-MEM · Demo seed" for a memory seeded by `tasks.py demo-seed` (or with no approving run). */
export function memoryLabel(m: Pick<MemoryUsed, "runId"> & { seeded?: boolean }): string {
  return m.runId && !m.seeded ? `H-MEM · approved run ${m.runId}` : "H-MEM · Demo seed";
}

export function sourceFromMemory(m: MemoryUsed): SourceDetail {
  return { kind: "memory", heading: "Approved memory", title: memoryLabel(m), facts: [], quote: m.text, link: null };
}
