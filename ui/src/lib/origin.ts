import type { ServingKind } from "./format";
import type { DataOrigin } from "../types/views";

export type PillTone = "fixture" | "seed" | "live" | "mixed";

/** Visible status word. Green “live” is reserved for a non-seed view response. */
export function statusLabel(origin: DataOrigin): "Fixture" | "Seed" | "Live" {
  if (origin === "seed") return "Seed";
  if (origin === "live") return "Live";
  return "Fixture";
}

export type HonestyState = "preview" | "cached" | "live";

/**
 * The one top-bar chip. Any fixture or seed row is Preview, whatever the answer says.
 * With every view live, a cached, replayed, or unlabelled answer is Cached.
 * Live needs every view live and a live answer.
 */
export function honestyChip(origins: DataOrigin[], serving: ServingKind): { state: HonestyState; label: string } {
  if (origins.length === 0 || origins.some((origin) => origin !== "live")) return { state: "preview", label: "Preview" };
  if (serving !== "live") return { state: "cached", label: "Cached" };
  return { state: "live", label: "Live" };
}

export function originPill(origins: DataOrigin[]): { tone: PillTone; label: string } {
  const kinds = new Set(origins);
  if (kinds.size <= 1) {
    const only = origins[0] ?? "fixture";
    return { tone: only, label: statusLabel(only) };
  }
  const order: DataOrigin[] = ["seed", "fixture", "live"];
  return {
    tone: "mixed",
    label: order
      .filter((item) => kinds.has(item))
      .map((item) => statusLabel(item))
      .join(" · "),
  };
}
