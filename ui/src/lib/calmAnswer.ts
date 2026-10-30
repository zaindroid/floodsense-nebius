import type { RecordedRun, ReplayClaim } from "../api/replay";
import type { GaugeStatus } from "./gauges";
import { statusView, type Tone } from "./places";
import { WARNING_LINKS, warningCountriesForCountry, type WarningLink } from "./safety";
import { sourceFromRun, type SourceDetail } from "./sources";

/**
 * The calm, plain-language answer of the quick and forecast lanes (agents/floodsense_agents/plain.py).
 * The agents build it by fixed rules, with no model call; this file only adopts it and derives what the
 * CalmAnswer component shows. Nothing here changes a word of the headline, the sentence or the disclaimer.
 */
export type PlainStatus = "normal" | "watch" | "elevated" | "unknown";

export interface PlainAnswer {
  headline: string;
  oneLine: string;
  horizon: "48h" | "7d";
  status: PlainStatus;
  basis: "gauge" | "model";
  places: string[];
  /** ISO alpha-2 of the first asked place; picks the official warning links. */
  country: string | null;
  /** Every asked place's country, in order; each gets its official links. */
  countries: string[];
  /** The official service, in words. */
  service: string | null;
  /** A history item, already framed as history by the agents. */
  context: string | null;
  nextStep: string;
  disclaimer: string;
  /** claim_id of the claims that are the cited detail. */
  details: string[];
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const STATUSES: readonly PlainStatus[] = ["normal", "watch", "elevated", "unknown"];

/** Pure: the run body's `plain` object, or null when it is absent or unusable (the run then renders as before). */
export function adoptPlain(value: unknown): PlainAnswer | null {
  const p = rec(value);
  if (!p) return null;
  const headline = str(p.headline);
  const oneLine = str(p.one_line);
  const nextStep = str(p.next_step);
  const disclaimer = str(p.disclaimer);
  const status = STATUSES.find((s) => s === p.status);
  if (!headline || !oneLine || !nextStep || !disclaimer || !status) return null;
  return {
    headline,
    oneLine,
    horizon: p.horizon === "7d" ? "7d" : "48h",
    status,
    basis: p.basis === "gauge" ? "gauge" : "model",
    places: Array.isArray(p.places) ? p.places.filter((x): x is string => typeof x === "string") : [],
    country: str(p.country),
    countries: Array.isArray(p.countries) ? p.countries.filter((x): x is string => typeof x === "string") : [],
    service: str(p.service),
    context: str(p.context),
    nextStep,
    disclaimer,
    details: Array.isArray(p.details) ? p.details.filter((x): x is string => typeof x === "string") : [],
  };
}

/** Pure: only a quick or forecast answer that carries a usable `plain` object is shown calmly. Everything else renders as today. */
export function calmApplies(run: Pick<RecordedRun, "lane" | "plain">): boolean {
  return (run.lane === "quick" || run.lane === "forecast") && !!run.plain;
}

const GAUGE_STATUS: Record<PlainStatus, GaugeStatus> = { normal: "ok", watch: "near", elevated: "over", unknown: "unknown" };

/** Pure: the status chip, from the same statusView words and tones as the places lists (no red for model bands or mean high water). */
export function calmChip(p: Pick<PlainAnswer, "status" | "basis">): { word: string; tone: Tone } {
  const view = statusView(p.basis === "gauge" ? "gauge" : "model", GAUGE_STATUS[p.status]);
  return p.status === "unknown" ? { word: "Not fully checked", tone: view.tone } : { word: view.word, tone: view.tone };
}

/** Pure: what the answer looks at, in words. */
export function horizonWord(p: Pick<PlainAnswer, "horizon">): string {
  return p.horizon === "7d" ? "This week" : "Next two days";
}

/** Pure: the official warning links of every asked place's country (once each), from the safety allowlist (nothing invented). */
export function officialLinks(p: { country: string | null; countries?: readonly string[] }): { title: string; links: readonly WarningLink[] }[] {
  const countries = p.countries && p.countries.length > 0 ? p.countries : [p.country];
  const keys = [...new Set(countries.flatMap((c) => warningCountriesForCountry(c)))];
  return keys.map((k) => WARNING_LINKS[k]);
}

const NON_ENGLISH =
  /(?:[¿¡äöüßñ]|\b(?:der|die|das|wird|ist|und|steigt|nächste[nr]?|woche|tage[n]?|morgen|jetzt|heute|pegel|el|los|las|esta|semana|próxim\w*|mañana|hoy|ahora|nivel|cómo|qué|está|sube|lloverá|le|la|les|demain|cette|semaine)\b)/i;

/** Pure: a question that is evidently not English (German, Spanish, French cues). The answers are English for now. */
export function isNonEnglish(question: string | null | undefined): boolean {
  return !!question && NON_ENGLISH.test(question.replace(/Köln/g, "Koeln"));
}

export const ENGLISH_NOTE = "Answers are currently in English.";

/** Pure: the insurer reads the detailed claims first, then the plain headline; the citizen the other way round. */
export function calmOrder(role: string | null | undefined): "plain-first" | "details-first" {
  return role === "insurer" ? "details-first" : "plain-first";
}

export interface DetailClaim {
  claim: ReplayClaim;
  flagged: boolean;
  /** One number per distinct source across the answer, in first-seen order. */
  badges: { n: number; detail: SourceDetail }[];
}

/** Pure: the cited claims (the plain object's `details`, else every claim) with their [n] source badges. */
export function detailClaims(run: Pick<RecordedRun, "claims" | "plain" | "flaggedClaimIds" | "eventId">): DetailClaim[] {
  const wanted = new Set(run.plain?.details ?? []);
  const claims = wanted.size > 0 ? run.claims.filter((c) => wanted.has(c.id)) : run.claims;
  const numbers = new Map<string, number>();
  return (claims.length > 0 ? claims : run.claims).map((claim) => {
    const badges: DetailClaim["badges"] = [];
    for (const citation of claim.citations) {
      const key = `${citation.layer}|${citation.title}|${citation.queryId ?? ""}|${citation.page ?? ""}|${citation.paragraph ?? ""}`;
      if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
      const n = numbers.get(key) as number;
      if (!badges.some((b) => b.n === n)) badges.push({ n, detail: sourceFromRun(citation, run.eventId) });
    }
    return { claim, flagged: run.flaggedClaimIds.includes(claim.id), badges };
  });
}
