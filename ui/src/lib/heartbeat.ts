import type { PlatformStatus } from "../api/platform";

export interface Heartbeat {
  state: "watching" | "stale" | "unreachable" | "starting";
  text: string;
}

/** A status poll runs every 30 s; past this the beat is called stale instead of fresh. */
export const STALE_AFTER_MS = 90_000;

/** Pure: the header heartbeat from the real platform snapshot. No snapshot means no pulse: never a guessed "watching". */
export function heartbeat(status: PlatformStatus | null, at: number, now: number): Heartbeat {
  if (!at) return { state: "starting", text: "Checking platform status" };
  if (!status) return { state: "unreachable", text: "Platform status unreachable" };
  const t = new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return now - at > STALE_AFTER_MS ? { state: "stale", text: `Platform status last checked ${t}` } : { state: "watching", text: `Platform status OK · last check ${t}` };
}
