import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { next48hQuestion } from "../api/ask";
import { fetchEuWatch, type EuWatchLoad } from "../api/euWatch";
import { fetchHazardNow, type HazardNowResult } from "../api/now";
import { useConsole } from "../context/ConsoleContext";
import { useGaugeLevels } from "../hooks/useGaugeLevels";
import { buildSources } from "../lib/euWatch";
import { summariseGauges } from "../lib/gauges";
import { latestPastStamp, relativeTime, sparkSeries, summariseAll, type PointNow, type Trend } from "../lib/now";
import { pointById } from "../lib/series";
import { EuWatchSection } from "./EuWatch";
import { GaugeList, GaugeMap } from "./GaugeMap";
import { Sparkline } from "./Sparkline";
import { LoadingNote, SlowSourceNote } from "./Loading";
import { DemoChip } from "./ModeSwitch";
import { DEMO_SNAPSHOT_AT, demoSnapshotText } from "../lib/demo";
import { dataTime, staleNote, staleViews } from "../lib/staleness";

const REFRESH_MS = 5 * 60_000;
const MODEL_NOTE = "Modelled (GloFAS via Open-Meteo), not an official warning";
const ATTRIBUTION = "Weather data by Open-Meteo.com";

type Load =
  | { state: "loading" }
  | { state: "error"; detail: string }
  | { state: "ready"; data: HazardNowResult; fetchedAt: number };

function localTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function fmt(value: number | null, digits = 1): string {
  return value === null ? "–" : value.toFixed(digits);
}

const TREND_TEXT: Record<Trend, { arrow: string; label: string }> = {
  up: { arrow: "↑", label: "rising vs 24 h ago" },
  down: { arrow: "↓", label: "falling vs 24 h ago" },
  flat: { arrow: "→", label: "steady vs 24 h ago" },
  unknown: { arrow: "·", label: "no 24 h comparison" },
};

/**
 * Insurer Now: the dense live page, kept as it was (citizens get CitizenNowPage in NowPage.tsx).
 * One labelled section per region: the eight Valencia points (Open-Meteo/GloFAS model, own fetch, never the
 * replay fixture), the German PEGELONLINE gauges (gauge_levels view, shared with the citizen gauge map), and the
 * Europe live watch: those gauges plus the GloFAS points of eu_watch on one map, each click pre-filling Ask.
 */
export function InsurerNowPage() {
  const { points, openAsk, demo, reportChecked } = useConsole();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const gauges = useGaugeLevels(0, demo);
  const lastDemo = useRef(demo);
  const gaugeSummaries = useMemo(() => summariseGauges(gauges.rows), [gauges.rows]);
  const [euWatch, setEuWatch] = useState<EuWatchLoad>({ state: "loading", rows: [], detail: "", queryId: null });
  const watchSources = useMemo(() => buildSources(gaugeSummaries, euWatch.rows), [gaugeSummaries, euWatch.rows]);
  const [clock, setClock] = useState(() => Date.now());
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (lastDemo.current !== demo) {
      // Live and demo rows are never shown together.
      lastDemo.current = demo;
      setLoad({ state: "loading" });
      setEuWatch({ state: "loading", rows: [], detail: "", queryId: null });
    }
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setLoad((prev) => (prev.state === "ready" ? prev : { state: "loading" }));
    void fetchEuWatch(ctrl.signal).then((result) => {
      // A failed refresh keeps the last good rows on screen.
      if (!ctrl.signal.aborted) setEuWatch((prev) => (result.state === "rows" || prev.state !== "rows" ? result : prev));
    });
    fetchHazardNow(ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setLoad({ state: "ready", data, fetchedAt: Date.now() });
      })
      .catch((error: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoad({ state: "error", detail: error instanceof Error ? error.message : "request failed" });
      });
  }, [demo]);

  useEffect(() => {
    refresh();
    let timer: number | undefined;
    const schedule = () => {
      window.clearInterval(timer);
      if (document.visibilityState === "visible") timer = window.setInterval(refresh, REFRESH_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    const tick = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.current?.abort();
    };
  }, [refresh]);

  const summaries = useMemo(() => (load.state === "ready" ? summariseAll(load.data.rows) : []), [load]);
  const stamp = load.state === "ready" ? latestPastStamp(load.data.rows) : null;
  const fetchedAt = load.state === "ready" ? dataTime(load.data.cache, load.fetchedAt) : null;
  useEffect(() => {
    if (fetchedAt !== null) reportChecked(demo ? Date.parse(DEMO_SNAPSHOT_AT) : fetchedAt);
  }, [fetchedAt, reportChecked, demo]);

  return (
    <div className="now-page">
      <header className="now-head">
        <div>
          <h2 className="now-title">Right now{stamp ? ` · ${localTime(stamp)}` : ""}</h2>
          {load.state === "ready" && (
            <p className="now-meta" aria-live="polite">
              <span className="now-live-tag">{demo ? `Demo snapshot ${demoSnapshotText()}` : "Live data · Zetaris"}</span> {demo && <DemoChip />}{demo ? "" : ` Updated ${relativeTime(dataTime(load.data.cache, load.fetchedAt) ?? load.fetchedAt, clock)}`}
              {!demo && load.data.cache?.cache === "stale" ? ` · ${staleNote(staleViews([load.data.cache]))}` : ""}
              {load.data.queryId ? ` · Zetaris query ${load.data.queryId.slice(0, 8)}` : ""}
              {load.data.dropped > 0 ? ` · ${load.data.dropped} rows dropped` : ""}
              {load.data.truncated ? " · truncated" : ""}
            </p>
          )}
        </div>
        <div className="button-row">
          <button type="button" className="now-refresh" onClick={() => openAsk(next48hQuestion())}>
            Is the next 48 h safe anywhere?
          </button>
          <button type="button" className="now-refresh" onClick={refresh}>
            Refresh
          </button>
        </div>
      </header>
      <section className="now-region" aria-labelledby="now-es">
        <div className="now-region-head">
          <h3 className="now-subtitle" id="now-es">
            Spain · Valencia (Open-Meteo/GloFAS model)
          </h3>
        </div>
        <p className="now-note">{MODEL_NOTE}. Dashed line and “forecast” values are model forecasts.</p>

      {load.state === "loading" && <LoadingNote what="Valencia readings" />}
      <SlowSourceNote pending={euWatch.state === "loading" || gauges.state === "loading"} what="A live source" />
      {load.state === "error" && (
        <div className="now-error" role="alert">
          <p>Could not load the Valencia readings. The other regions below may still be shown.</p>
          <p className="now-detail">{load.detail}</p>
          <button type="button" className="now-refresh" onClick={refresh}>
            Retry
          </button>
        </div>
      )}
      {load.state === "ready" && summaries.length === 0 && <p className="now-status">No live rows returned.</p>}
      {load.state === "ready" && summaries.length > 0 && (
        <div className="now-grid">
          {summaries.map((summary) => (
            <PointCard key={summary.point_id} summary={summary} name={pointById(points, summary.point_id)?.name} />
          ))}
        </div>
      )}
        <p className="now-source">{ATTRIBUTION}</p>
      </section>

      <section className="now-region" aria-labelledby="now-de">
        <div className="now-region-head">
          <h3 className="now-subtitle" id="now-de">
            Germany · federal waterways (PEGELONLINE live gauges)
          </h3>
        </div>
        <p className="now-note">Measured water levels. Colour and bar compare each level with the station's MHW; dashed or Stale means not a fresh live reading.</p>
        <GaugeMap load={gauges} gauges={gaugeSummaries} />
        <GaugeList load={gauges} gauges={gaugeSummaries} />
        <p className="now-source">Quelle: WSV, PEGELONLINE</p>
      </section>

      <EuWatchSection sources={watchSources} model={euWatch} />
    </div>
  );
}

function PointCard({ summary, name }: { summary: PointNow; name?: string }) {
  const trend = TREND_TEXT[summary.trend];
  const { values, split } = sparkSeries(summary);
  return (
    <article className="now-card">
      <h3 className="now-card-title">
        {name ?? summary.point_id} <span className="now-id">{summary.point_id}</span>
      </h3>
      {summary.latest ? (
        <dl className="now-stats">
          <div>
            <dt>Discharge</dt>
            <dd>
              {fmt(summary.latest.discharge_m3s)} m³/s{" "}
              <span className={`now-trend now-trend-${summary.trend}`} title={trend.label} aria-hidden="true">
                {trend.arrow}
              </span>
              <span className="sr-only">{trend.label}</span>
            </dd>
          </div>
          <div>
            <dt>Rain last hour</dt>
            <dd>{fmt(summary.rainLastHour)} mm</dd>
          </div>
          <div>
            <dt>Rain last 24 h</dt>
            <dd>{fmt(summary.rain24h)} mm</dd>
          </div>
        </dl>
      ) : (
        <p className="now-status">No past rows for this point.</p>
      )}
      <p className="now-forecast">
        {summary.forecastMax
          ? `Forecast max next 48 h: ${fmt(summary.forecastMax.discharge_m3s)} m³/s at ${localTime(summary.forecastMax.ts_utc)}`
          : "No forecast rows."}
      </p>
      {values.length > 1 && (
        <Sparkline
          values={values}
          activeIndex={split ?? values.length - 1}
          splitIndex={split}
          label={`${name ?? summary.point_id} discharge, past 72 h and forecast 48 h (dashed)`}
        />
      )}
    </article>
  );
}
