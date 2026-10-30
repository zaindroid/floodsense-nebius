import type { Answer } from "../types/contract";
import { parseUtc } from "./time";

export type ServingKind = "live" | "cached" | "unlabelled";

export interface ServingLabel {
  kind: ServingKind;
  /** Visible label. Cached and replay always include the words "cached at HH:MM" when a time exists. */
  text: string;
  servedFrom: Answer["served_from"];
  runId: string;
}

export function formatUtcHm(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = parseUtc(iso);
  if (!date) return null;
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Live answers say live.
 * Cache and replay say "cached at HH:MM" and are never described as live.
 * A broken combination is labelled as unlabelled rather than promoted to live.
 */
export function servingLabel(answer: Answer): ServingLabel {
  const runId = answer.run_id;
  if (answer.served_from === "live") {
    if (answer.cached_at) {
      return {
        kind: "unlabelled",
        text: "unlabelled · cached_at is set",
        servedFrom: answer.served_from,
        runId,
      };
    }
    return { kind: "live", text: "live", servedFrom: "live", runId };
  }
  const hm = formatUtcHm(answer.cached_at);
  if (!hm) {
    return {
      kind: "unlabelled",
      text: `${answer.served_from} · cached time missing`,
      servedFrom: answer.served_from,
      runId,
    };
  }
  return {
    kind: "cached",
    text: `cached at ${hm}`,
    servedFrom: answer.served_from,
    runId,
  };
}

/** Word next to the serving time under the top-bar chip. Cache and replay never use the word live. */
export function servingQualifier(label: ServingLabel): "live" | "cache" | "replay" | "unlabelled" {
  if (label.kind === "live") return "live";
  if (label.servedFrom === "cache") return "cache";
  if (label.servedFrom === "replay") return "replay";
  return "unlabelled";
}

export function formatHour(ts: string): string {
  const hm = formatUtcHm(ts);
  return hm ? `${hm} UTC` : ts;
}

export function formatDay(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function formatM3s(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(value);
}

export function formatMm(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value);
}

export function formatEur(value: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
