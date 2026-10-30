import { useMemo } from "react";
import type { EuWatchRow, WatchSource } from "../lib/euWatch";
import type { GaugeSummary } from "../lib/gauges";
import { useLiveWatch, type LiveWatch } from "./useLiveWatch";

export interface InsurerWatch {
  gauges: GaugeSummary[];
  points: EuWatchRow[];
  /** Every source of the shared live watch (gauges, GloFAS points, Valencia hazard_now points). */
  sources: WatchSource[];
  /** Valencia hazard_now demo points (own recent flow, not official). */
  valencia: WatchSource[];
  gaugeQueryId: string | null;
  modelQueryId: string | null;
  gaugeExecutedAt: string | null;
  /** loading until both alert views answered; rows when either has rows. */
  state: "loading" | "rows" | "empty" | "unavailable";
  checkedAt: number | null;
  detail: string;
  /** Views that could not be read, by name. */
  missing: string[];
  live: LiveWatch;
}

/** The shared live watch (useLiveWatch, read once for every page) in the shape the insurer monitor and maps read. */
export function useInsurerWatch(): InsurerWatch {
  const live = useLiveWatch();
  return useMemo(() => {
    const g = live.gauges;
    const e = live.euWatch;
    const loading = g.state === "loading" || e.state === "loading";
    const any = live.gaugeSummaries.length > 0 || e.rows.length > 0;
    const state: InsurerWatch["state"] = loading ? "loading" : any ? "rows" : g.state === "unavailable" && e.state === "unavailable" ? "unavailable" : "empty";
    return {
      gauges: live.gaugeSummaries,
      points: e.rows,
      sources: live.sources,
      valencia: live.sources.filter((s) => s.kind === "valencia"),
      gaugeQueryId: "queryId" in g ? (g.queryId ?? null) : null,
      gaugeExecutedAt: "executedAt" in g ? (g.executedAt ?? null) : null,
      modelQueryId: e.queryId,
      state,
      checkedAt: live.updatedAt,
      detail: [g.detail, e.detail].filter(Boolean).join(" · "),
      missing: [g.state === "unavailable" && "PEGELONLINE gauges", e.state === "unavailable" && "GloFAS points"].filter((m): m is string => !!m),
      live,
    };
  }, [live]);
}
