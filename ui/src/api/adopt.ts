import type { DataOrigin } from "../types/views";

export interface AdoptedView<T> {
  rows: T[];
  origin: DataOrigin;
  detail: string;
  /** True when the body was a JSON array. A miss keeps the fixture rows. */
  adopted: boolean;
}

function sourceOf(row: unknown): string | null {
  if (!row || typeof row !== "object" || !("source" in row)) return null;
  const source = (row as { source: unknown }).source;
  return typeof source === "string" ? source : null;
}

function stamped(source: string | null): source is string {
  return typeof source === "string" && source.length > 0;
}

function syntheticYes(row: unknown): boolean {
  if (!row || typeof row !== "object" || !("synthetic" in row)) return false;
  return (row as { synthetic: unknown }).synthetic === "yes";
}

/**
 * Seed when any row is seed-stamped, or when any row is the synthetic book
 * (`synthetic === "yes"`, migration 018). That book is not a live exposure feed.
 * Live only when every row carries a non-seed source stamp and none is synthetic.
 * An empty array, or a row with no source stamp, is fixture. Not live.
 */
export function originForRows(rows: unknown[]): DataOrigin {
  if (rows.length === 0) return "fixture";
  if (rows.some(syntheticYes)) return "seed";
  const sources = rows.map(sourceOf);
  if (sources.some((source) => (source ?? "").startsWith("seed:"))) return "seed";
  if (sources.every((source) => stamped(source))) return "live";
  return "fixture";
}

function withOrigin(detail: string, origin: DataOrigin): string {
  const stripped = detail.replace(/ · (seed|live|fixture|unstamped)$/, "");
  return `${stripped} · ${origin}`;
}

/**
 * Health failure, or a body that is not a valid row array, keeps the fixture.
 * A valid array is adopted only from that view response. [] stays empty.
 * GET /health on its own never selects live or seed.
 * Empty arrays and unstamped rows are not live.
 */
export function adoptView<T>(input: {
  healthOk: boolean;
  parsed: T[] | null;
  fixtureRows: T[];
  fixtureDetail: string;
  missDetail: string;
}): AdoptedView<T> {
  if (!input.healthOk || input.parsed === null) {
    const detail = input.healthOk
      ? `${input.fixtureDetail} ${input.missDetail}.`
      : input.fixtureDetail;
    return { rows: input.fixtureRows, origin: "fixture", detail, adopted: false };
  }
  const origin = originForRows(input.parsed);
  const stamp = origin === "fixture" ? "unstamped" : origin;
  const detail =
    input.parsed.length === 0 ? `${input.missDetail} · 0 rows` : `${input.missDetail} · ${stamp}`;
  return { rows: input.parsed, origin, detail, adopted: true };
}

/**
 * Sibling views often have no source column. A seed discharge response marks
 * an unstamped sibling seed. A live discharge response does not. Hazard can
 * inherit seed; it does not inherit Live. `synthetic === "yes"` is already
 * seed from originForRows, so exposure_join never becomes live that way.
 * An empty sibling stays empty. A miss stays the fixture.
 */
export function markBatchSeed<T>(discharge: AdoptedView<unknown>, slice: AdoptedView<T>): AdoptedView<T> {
  if (!slice.adopted || slice.rows.length === 0) {
    if (slice.adopted && slice.rows.length === 0) return { ...slice, origin: "fixture" };
    return slice;
  }
  const own = originForRows(slice.rows);
  if (own === "seed") return { ...slice, origin: "seed", detail: withOrigin(slice.detail, "seed") };
  if (discharge.adopted && discharge.origin === "seed") {
    return { ...slice, origin: "seed", detail: withOrigin(slice.detail, "seed") };
  }
  if (own === "live") return { ...slice, origin: "live", detail: withOrigin(slice.detail, "live") };
  return slice;
}
