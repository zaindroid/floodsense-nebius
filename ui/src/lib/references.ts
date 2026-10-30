import type { ReplayCitation, ReplayClaim } from "../api/replay";
import type { Answer, Citation } from "../types/contract";
import { sourceFromCitation, sourceFromRun, type SourceKind, type SourceLink } from "./sources";

/**
 * Numbered references, [1] [2] …, for a block of claims. Numbers follow the first appearance of each source
 * across the claims, so the same passage keeps one number everywhere in that block (claim sentence, passage
 * list, drawer). Every reference has a DOM anchor (`ref-<scope>-<n>`) so a passage list item can be linked.
 */
export interface Reference {
  n: number;
  /** Stable identity of the source inside one block (citation id, else title + page + quote). */
  key: string;
  anchor: string;
  kind: SourceKind;
  /** "Document", "Data via Zetaris", "Provenance". */
  heading: string;
  title: string;
  layer: string;
  publisher: string | null;
  licence: string | null;
  attribution: string | null;
  page: number | null;
  paragraph: number | null;
  quote: string | null;
  /** Data: the Zetaris query id. Document: the Zetaris query that hydrated the passage. */
  queryId: string | null;
  /** Data: the cited view. */
  view: string | null;
  /** Document: the citation's own source URL. Data: the upstream feed (lib/sources.ts). */
  link: SourceLink | null;
}

export interface NumberedClaim {
  id: string;
  text: string;
  refs: number[];
}

export interface ReferenceSet {
  claims: NumberedClaim[];
  refs: Reference[];
}

export function referenceAnchor(scope: string, n: number): string {
  return `ref-${scope.replace(/[^A-Za-z0-9_-]/g, "-")}-${n}`;
}

function keyOf(id: string | null | undefined, title: string, page: number | null, quote: string | null): string {
  return id && id.trim() ? `id:${id}` : `t:${title}|${page ?? ""}|${(quote ?? "").slice(0, 80)}`;
}

function fromRun(c: ReplayCitation, eventId: string | null): Omit<Reference, "n" | "anchor" | "key"> {
  const detail = sourceFromRun(c, eventId);
  return {
    kind: detail.kind,
    heading: detail.heading,
    title: c.title,
    layer: c.layer,
    publisher: c.publisher,
    licence: c.licence,
    attribution: c.attribution,
    page: c.page,
    paragraph: c.paragraph ?? null,
    quote: c.quote,
    queryId: c.queryId,
    view: c.layer === "a" ? c.title : null,
    link: detail.link,
  };
}

function fromContract(c: Citation, eventId: string | null): Omit<Reference, "n" | "anchor" | "key"> {
  const detail = sourceFromCitation(c, eventId);
  return {
    kind: detail.kind,
    heading: detail.heading,
    title: c.title,
    layer: c.layer,
    publisher: c.publisher || null,
    licence: c.licence || null,
    attribution: c.attribution || null,
    page: c.locator?.page ?? null,
    paragraph: c.locator?.paragraph ?? null,
    quote: c.quote ?? null,
    queryId: c.query_id ?? null,
    view: c.layer === "a" ? c.title : null,
    link: detail.link,
  };
}

/** Pure: number every citation of a run's claims, in claim order. `layers` limits which layers get a number. */
export function numberRunReferences(
  claims: readonly ReplayClaim[],
  options: { scope: string; eventId?: string | null; layers?: readonly string[] },
): ReferenceSet {
  const refs: Reference[] = [];
  const byKey = new Map<string, number>();
  const out: NumberedClaim[] = claims.map((claim) => {
    const nums: number[] = [];
    for (const c of claim.citations) {
      if (options.layers && !options.layers.includes(c.layer)) continue;
      const key = keyOf(c.id, c.title, c.page, c.quote);
      let n = byKey.get(key);
      if (n === undefined) {
        n = refs.length + 1;
        byKey.set(key, n);
        refs.push({ n, key, anchor: referenceAnchor(options.scope, n), ...fromRun(c, options.eventId ?? null) });
      }
      if (!nums.includes(n)) nums.push(n);
    }
    return { id: claim.id, text: claim.text, refs: nums };
  });
  return { claims: out, refs };
}

/** Pure: the same numbering for a contract Answer (the reviewed answer on insurer Review). */
export function numberAnswerReferences(answer: Answer, options: { scope: string; eventId?: string | null }): ReferenceSet {
  const refs: Reference[] = [];
  const byKey = new Map<string, number>();
  const claims = answer.claims.map((claim) => {
    const nums: number[] = [];
    for (const c of answer.citations.filter((ci) => ci.claim_id === claim.claim_id)) {
      const key = keyOf(c.citation_id, c.title, c.locator?.page ?? null, c.quote ?? null);
      let n = byKey.get(key);
      if (n === undefined) {
        n = refs.length + 1;
        byKey.set(key, n);
        refs.push({ n, key, anchor: referenceAnchor(options.scope, n), ...fromContract(c, options.eventId ?? null) });
      }
      if (!nums.includes(n)) nums.push(n);
    }
    return { id: claim.claim_id, text: claim.text, refs: nums };
  });
  return { claims, refs };
}

/** Pure: the reference with that citation's number in the set, by citation id. */
export function refForCitation(set: ReferenceSet, c: Pick<ReplayCitation, "id" | "title" | "page" | "quote">): Reference | null {
  const key = keyOf(c.id, c.title, c.page, c.quote);
  return set.refs.find((r) => r.key === key) ?? null;
}

export interface DrawerField {
  label: string;
  value: string;
}

/** Query ids in the bundled fixtures are fixture ids, not Zetaris ids. Say so instead of implying a real query. */
export function isFixtureQueryId(id: string | null): boolean {
  return !!id && /^qry_fixture/i.test(id);
}

/**
 * Pure: what the Evidence drawer lists for one reference. A document shows title, publisher, page and
 * paragraph, licence, and the Zetaris query id that hydrated it; data shows the view, the query id, and the
 * upstream link (lib/sources.ts). Missing facts are said, not left out silently.
 */
export function drawerFields(ref: Reference): DrawerField[] {
  const qid = ref.queryId
    ? isFixtureQueryId(ref.queryId)
      ? `${ref.queryId} (fixture id, not a Zetaris query)`
      : ref.queryId
    : "not recorded";
  if (ref.kind === "document") {
    const where =
      ref.page === null ? "not stated" : ref.paragraph ? `page ${ref.page}, paragraph ${ref.paragraph}` : `page ${ref.page}`;
    return [
      { label: "Title", value: ref.title },
      { label: "Publisher", value: ref.publisher ?? "not stated" },
      { label: "Page / paragraph", value: where },
      ...(ref.licence ? [{ label: "Licence", value: ref.licence }] : []),
      { label: "Zetaris hydration query id", value: qid },
    ];
  }
  if (ref.kind === "zetaris") {
    return [
      { label: "View", value: ref.view ?? ref.title },
      { label: "Query id", value: qid },
      ...(/floodsense_seed\./.test(ref.view ?? "") ? [{ label: "Data", value: "Seed data (recorded rows), not live" }] : []),
    ];
  }
  return [
    { label: "Dataset", value: ref.title },
    ...(ref.publisher ? [{ label: "Publisher", value: ref.publisher }] : []),
    ...(ref.licence ? [{ label: "Licence", value: ref.licence }] : []),
  ];
}

/** Pure: the reference for a citation id (ReplayCitation.id is the citation_id, else its title). */
export function refById(set: ReferenceSet, id: string): Reference | null {
  return set.refs.find((r) => r.key === `id:${id}`) ?? null;
}

/** "[1][3]" for plain-text contexts (titles, aria). */
export function refMarks(nums: readonly number[]): string {
  return nums.map((n) => `[${n}]`).join("");
}
