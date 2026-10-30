/**
 * Migration 007 stores ts_utc without a zone. The session that wrote it is GMT.
 * A missing zone is UTC. A present zone is left alone.
 */
const STAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}|[+-]\d{4})?$/;

export function normalizeUtcTimestamp(value: string): string | null {
  const match = STAMP.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  const zone = match[4];
  let suffix = "Z";
  if (zone === "Z") suffix = "Z";
  else if (zone && zone.includes(":")) suffix = zone;
  else if (zone) suffix = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return `${match[1]}T${match[2]}${fraction}${suffix}`;
}

/** Instant for a zoned or zone-less stamp. Zone-less values match the same digits with Z. */
export function parseUtc(value: string): Date | null {
  const normalized = normalizeUtcTimestamp(value);
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
