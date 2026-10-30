import type { RecordedRun, ReplayCitation } from "../api/replay";

export interface RetrievalPassage {
  id: string;
  title: string;
  page: number | null;
  publisher: string | null;
  licence: string | null;
  attribution: string | null;
  /** Trimmed quote, or null when the passage has no readable text (a map page). */
  quote: string | null;
}

export interface RetrievalGroup {
  claimId: string;
  claimText: string;
  passages: RetrievalPassage[];
  /** Zetaris query ids that hydrated these passages, deduplicated. */
  queryIds: string[];
  verdict: { grounding: string | null; score: number | null; rationale: string | null; modelId: string | null } | null;
  flagged: boolean;
}

export interface RetrievalModel {
  query: string | null;
  groups: RetrievalGroup[];
  passageCount: number;
}

export const QUOTE_MAX = 280;

/** Pure: a quote fit to show. Mostly-punctuation text (map symbol layers) is not a quote. */
export function cleanQuote(quote: string | null, max = QUOTE_MAX): string | null {
  if (!quote) return null;
  const text = quote.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters / text.length < 0.4) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function passage(c: ReplayCitation): RetrievalPassage {
  return {
    id: c.id,
    title: c.title,
    page: c.page,
    publisher: c.publisher,
    licence: c.licence,
    attribution: c.attribution,
    quote: cleanQuote(c.quote),
  };
}

/** Pure: layer (c) citations grouped per claim, with the Judge's verdict on that claim. */
export function buildRetrieval(run: RecordedRun): RetrievalModel {
  const groups: RetrievalGroup[] = [];
  for (const claim of run.claims) {
    const docs = claim.citations.filter((c) => c.layer === "c");
    if (!docs.length) continue;
    const verdict = run.judgeClaims?.find((j) => j.claimId === claim.id) ?? null;
    groups.push({
      claimId: claim.id,
      claimText: claim.text,
      passages: docs.map(passage),
      queryIds: [...new Set(docs.map((c) => c.queryId).filter((q): q is string => !!q))],
      verdict: verdict
        ? { grounding: verdict.grounding, score: verdict.score, rationale: verdict.rationale, modelId: verdict.modelId }
        : null,
      flagged: run.flaggedClaimIds.includes(claim.id),
    });
  }
  return {
    query: run.docQuery ?? null,
    groups,
    passageCount: groups.reduce((n, g) => n + g.passages.length, 0),
  };
}
