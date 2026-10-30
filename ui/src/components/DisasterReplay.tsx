import { useEffect, useMemo, useState } from "react";
import { useConsole } from "../context/ConsoleContext";
import { ahrFixture, loadAhrRows, type EventRows } from "../lib/replaySource";
import {
  buildFrames,
  clampStep,
  crossings,
  dayStarts,
  isoOf,
  crossingText,
  dayText,
  isDailyDischarge,
  isTurnFrame,
  momentQuestionAt,
  momentText,
  nextStep,
  readingsAt,
  REPLAY_EVENTS,
  replayLabel,
  type ReplayReading,
} from "../lib/disasterReplay";
import { evidenceForReplay } from "../lib/liveEvidence";
import { storyMoments } from "../lib/story";
import { LiveSourceBadge } from "./LiveSources";
import { ChoosePast } from "./ModeSwitch";

const PLAY_MS = 220;
/** Under prefers-reduced-motion, Play steps once a second instead of ~4.5 times. */
const PLAY_MS_REDUCED = 1000;

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type EventData = EventRows;

/**
 * Disaster replay: scrub through the past flood chosen in the header (Ahr 2021 or Valencia 2024) hour by hour.
 * Never live: in Live mode the page asks which flood to show, which switches the whole console to Past flood.
 */
export function DisasterReplay() {
  const { mode } = useConsole();
  if (mode === "live")
    return (
      <ChoosePast title="Replay shows a past flood">
        You are on live data. Choose a flood to replay it hour by hour: the Ahr valley (July 2021) or Valencia (October 2024). This switches the
        whole console to Past flood; switch back to Live in the header at any time.
      </ChoosePast>
    );
  return <ReplayBody />;
}

function ReplayBody() {
  const desk = useConsole();
  const { eventId } = desk;
  const event = REPLAY_EVENTS.find((e) => e.eventId === eventId) ?? REPLAY_EVENTS[0];

  // Ahr: Zetaris rows when the API serves AHR points, else the labelled bundled fixture.
  const [ahrRows, setAhrRows] = useState<EventRows>(() => ahrFixture());
  useEffect(() => {
    const controller = new AbortController();
    void loadAhrRows(REPLAY_EVENTS[0], controller.signal).then((rows) => {
      if (!controller.signal.aborted) setAhrRows(rows);
    });
    return () => controller.abort();
  }, []);
  const data = useMemo<EventData>(() => {
    if (event.eventId === "EMSR517") return ahrRows;
    return {
      rows: desk.hazard.rows,
      points: desk.points.map((p) => ({ point_id: p.point_id, name: `${p.name}` })),
      source: `hazard_timeline view (${desk.hazard.origin}): ERA5 hourly rain, GloFAS daily discharge. ${desk.hazard.detail}`,
      badge:
        desk.hazard.origin === "fixture"
          ? "Bundled view extract, not from Zetaris"
          : `Zetaris · hazard_timeline (${desk.hazard.origin})`,
      fromZetaris: desk.hazard.origin !== "fixture",
    };
  }, [event.eventId, ahrRows, desk.hazard, desk.points]);
  const daily = useMemo(() => isDailyDischarge(data.rows), [data.rows]);

  const frames = useMemo(() => buildFrames(data.rows, event), [data.rows, event]);
  const days = useMemo(() => dayStarts(frames), [frames]);
  const turned = useMemo(() => crossings(data.rows, frames, event.thresholdM3s), [data.rows, frames, event.thresholdM3s]);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pointId, setPointId] = useState<string>(data.points[0]?.point_id ?? "");

  // New rows (another event, or the Ahr rows arriving from Zetaris) restart at the first crossing.
  useEffect(() => {
    setPlaying(false);
    const first = [...turned.entries()].sort((a, b) => a[1].index - b[1].index)[0];
    setStep(first ? Math.max(0, first[1].index - 6) : 0);
    setPointId(first?.[0] ?? data.points[0]?.point_id ?? "");
  }, [turned, data.points]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const t = window.setInterval(() => setStep((s) => nextStep(s, frames.length)), reducedMotion() ? PLAY_MS_REDUCED : PLAY_MS);
    return () => window.clearInterval(t);
  }, [playing, frames.length]);

  const at = clampStep(step, frames.length);
  const iso = frames[at] ?? null;
  const now = useMemo(() => (iso ? readingsAt(data.rows, iso) : new Map()), [data.rows, iso]);
  const point = data.points.find((p) => p.point_id === pointId) ?? data.points[0];
  const series = useMemo(() => {
    const pts = data.rows.filter((r) => r.point_id === point?.point_id);
    const byIso = new Map(pts.map((r) => [isoOf(r.ts_utc), r]));
    return frames.map((f) => byIso.get(f) ?? null);
  }, [data.rows, frames, point?.point_id]);

  const citizen = desk.route === "citizen";
  const [showData, setShowData] = useState(false);
  const moments = useMemo(() => storyMoments(data.rows, data.points, frames, event, daily), [data, frames, event, daily]);
  const maxRain = useMemo(() => Math.max(5, ...series.map((r) => r?.rain_mm ?? 0)), [series]);

  const ask = () => {
    if (!iso || !point) return;
    desk.openAsk(momentQuestionAt(point.name, iso, daily), {
      page: "replay",
      event_id: event.eventId,
      replay_date: daily ? iso.slice(0, 10) : iso,
      point_id: point.point_id,
      place: point.name,
    });
  };

  return (
    <section className="card dr" aria-label="Disaster replay">
      <div className="dr-head">
        <div>
          <p className="section-label">Disaster replay</p>
          <h2 className="dr-title">{event.name}</h2>
        </div>
        <div className="dr-badges">
          <p className="dr-badge">{replayLabel(event)}</p>
          <p className={`dr-badge dr-badge-src${data.fromZetaris ? " is-zetaris" : ""}`}>{data.badge}</p>
        </div>
      </div>
      {frames.length > 0 && citizen && (
        <section className="dr-story" aria-labelledby="dr-story-title">
          <h3 className="section-title" id="dr-story-title">
            What happened
          </h3>
          <ol className="dr-moments">
            {moments.map((m, i) => (
              <li key={`${m.iso}-${m.pointId}-${m.topic}`}>
                {m.text}{" "}
                <LiveSourceBadge
                  n={i + 1}
                  evidence={evidenceForReplay(`${event.name} · ${data.points.find((p) => p.point_id === m.pointId)?.name ?? m.pointId}`, m.iso, data, m.topic, event.thresholdM3s)}
                />
              </li>
            ))}
          </ol>
          <p className="note">Replay of a past event, not live. The alert line is FloodSense's own line, not an official threshold.</p>
          <button
            type="button"
            className="button ghost"
            aria-expanded={showData}
            aria-controls="dr-data"
            onClick={() => setShowData((v) => !v)}
          >
            {showData ? "Hide the data" : "Show the data"}
          </button>
        </section>
      )}
      {frames.length === 0 ? (
        <p className="note">No readings for this window in the loaded rows.</p>
      ) : !citizen || showData ? (
        <div id="dr-data">
          <div className="dr-controls">
            <button type="button" className="dr-play" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
              {playing ? "Pause" : "Play"}
            </button>
            <button type="button" className="dr-chip" onClick={() => setStep((s) => clampStep(s - 1, frames.length))} aria-label="One hour back">
              −1 h
            </button>
            <button type="button" className="dr-chip" onClick={() => setStep((s) => clampStep(s + 1, frames.length))} aria-label="One hour on">
              +1 h
            </button>
            {days.map((d) => (
              <button key={d.day} type="button" className={`dr-chip${iso?.startsWith(d.day) ? " is-on" : ""}`} onClick={() => setStep(d.index)}>
                {momentText(`${d.day}T00:00:00Z`).replace(/ at .*/, "")}
              </button>
            ))}
          </div>
          <div className="dr-scrub">
            <input
              type="range"
              min={0}
              max={frames.length - 1}
              value={at}
              onChange={(e) => {
                setPlaying(false);
                setStep(Number(e.target.value));
              }}
              aria-label="Replay time"
              aria-valuetext={iso ? momentText(iso) : ""}
            />
            <div className="dr-ticks" aria-hidden="true">
              {[...turned.entries()].map(([pid, c]) => (
                <span
                  key={pid}
                  className="dr-tick"
                  style={{ left: `${(c.index / Math.max(1, frames.length - 1)) * 100}%` }}
                  title={`${data.points.find((p) => p.point_id === pid)?.name ?? pid} turned`}
                />
              ))}
            </div>
          </div>
          <p className="dr-now" aria-live={playing ? "off" : "polite"}>
            <strong>{iso ? `${momentText(iso)} UTC` : ""}</strong> · hour {at + 1} of {frames.length}
          </p>

          <p className="dr-axis note" aria-hidden="true">
            <span>rain (mm/h), top ↓</span>
            <span>river flow (m³/s) ↑</span>
          </p>
          <ReplayChart
            series={series}
            cursor={at}
            threshold={event.thresholdM3s}
            turnedAt={turned.get(point?.point_id ?? "")?.index ?? null}
            description={chartDescription(
              point?.name ?? "",
              series,
              event.thresholdM3s,
              turned.get(point?.point_id ?? "")?.iso ?? null,
              daily,
            )}
          />

          <ul className="dr-legend" aria-label="Chart legend">
            <li>
              <span className="dr-legend__swatch dr-legend__swatch--rain" aria-hidden="true" /> Rain (mm/h), bars hang from the
              top · top of chart = {maxRain.toFixed(0)} mm/h
            </li>
            <li>
              <span className="dr-legend__swatch dr-legend__swatch--q" aria-hidden="true" /> River flow (m³/s), line from the
              bottom
            </li>
            <li>
              <span className="dr-legend__swatch dr-legend__swatch--thr" aria-hidden="true" /> {event.thresholdM3s} m³/s alert line
            </li>
          </ul>

          <table className="dr-table">
            <thead>
              <tr>
                <th scope="col">Place</th>
                <th scope="col">Rain (mm/h)</th>
                <th scope="col">Discharge (m³/s)</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {data.points.map((p) => {
                const r = now.get(p.point_id);
                const c = turned.get(p.point_id);
                const above = r?.discharge_m3s != null && r.discharge_m3s >= event.thresholdM3s;
                const here = !!c && !!iso && isTurnFrame(iso, c.iso, daily);
                return (
                  <tr
                    key={p.point_id}
                    className={`${p.point_id === point?.point_id ? "is-sel " : ""}${above ? "is-above" : ""}${here ? " is-turn" : ""}`}
                  >
                    <th scope="row">
                      <button type="button" className="dr-link" onClick={() => setPointId(p.point_id)}>
                        {p.name}
                      </button>
                    </th>
                    <td>{r ? r.rain_mm.toFixed(1) : "—"}</td>
                    <td>{r?.discharge_m3s != null ? r.discharge_m3s.toFixed(1) : "—"}</td>
                    <td>
                      {here ? (
                        <strong className="dr-turn">The moment it turned · {crossingText(c.iso, daily)}</strong>
                      ) : above ? (
                        "Above the line"
                      ) : c && c.index > at ? (
                        `Crosses on ${daily ? dayText(c.iso) : `${momentText(c.iso)} UTC`}`
                      ) : (
                        "Below the line"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="button-row">
            <button type="button" className="dr-ask" onClick={ask} disabled={!point || !iso}>
              Ask the agents about this moment
            </button>
          </div>
          <p className="note">
            Line: {event.thresholdM3s} m³/s, the Watchers anomaly line.{" "}
            {daily
              ? "Discharge is the modelled GloFAS daily value, so a crossing is dated by day, not hour; rain is hourly."
              : "Discharge and rain are hourly."}{" "}
            {data.source}
          </p>
        </div>
      ) : null}
      {citizen && frames.length > 0 && (
        <div className="button-row">
          <button type="button" className="dr-ask" onClick={ask} disabled={!point || !iso}>
            Ask FloodSense about this flood
          </button>
        </div>
      )}
    </section>
  );
}

/** Rain bars and discharge line for the selected place, with the line, the cursor and the turning point. */
function ReplayChart({
  series,
  cursor,
  threshold,
  turnedAt,
  description,
}: {
  series: (ReplayReading | null)[];
  cursor: number;
  threshold: number;
  turnedAt: number | null;
  description: string;
}) {
  const W = 640;
  const H = 150;
  const n = Math.max(1, series.length);
  const maxQ = Math.max(threshold * 1.2, ...series.map((r) => r?.discharge_m3s ?? 0));
  const maxR = Math.max(5, ...series.map((r) => r?.rain_mm ?? 0));
  const x = (i: number) => (i / Math.max(1, n - 1)) * W;
  const yQ = (v: number) => H - (v / maxQ) * (H - 10);
  const line = series
    .map((r, i) => (r?.discharge_m3s != null ? `${x(i).toFixed(1)},${yQ(r.discharge_m3s).toFixed(1)}` : null))
    .filter(Boolean)
    .join(" ");
  return (
    <svg className="dr-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={description}>
      <desc>{description}</desc>
      {series.map((r, i) =>
        r && r.rain_mm > 0 ? (
          <rect key={i} className="dr-rain" x={x(i) - W / n / 2} width={Math.max(1, W / n - 0.5)} y={0} height={(r.rain_mm / maxR) * (H * 0.45)} />
        ) : null,
      )}
      <line className="dr-thr" x1={0} x2={W} y1={yQ(threshold)} y2={yQ(threshold)} />
      <polyline className="dr-q" points={line} fill="none" />
      {turnedAt !== null && <circle className="dr-turnpt" cx={x(turnedAt)} cy={yQ(series[turnedAt]?.discharge_m3s ?? threshold)} r={5} />}
      <line className="dr-cursor" x1={x(cursor)} x2={x(cursor)} y1={0} y2={H} />
    </svg>
  );
}

/** Pure text alternative for the chart: place, peak, line and crossing day. */
export function chartDescription(
  place: string,
  series: (ReplayReading | null)[],
  threshold: number,
  crossingIso: string | null,
  daily: boolean,
): string {
  let peak: ReplayReading | null = null;
  for (const r of series) if (r?.discharge_m3s != null && (!peak || r.discharge_m3s > (peak.discharge_m3s ?? 0))) peak = r;
  const rain = series.reduce((n, r) => n + (r?.rain_mm ?? 0), 0);
  const parts = [`${place}: hourly rain bars and discharge line against the ${threshold} m³/s line.`];
  if (peak?.discharge_m3s != null) {
    parts.push(`Peak discharge ${peak.discharge_m3s.toFixed(1)} m³/s on ${dayText(isoOf(peak.ts_utc) ?? peak.ts_utc)}.`);
  }
  parts.push(`Rain over the window ${rain.toFixed(1)} mm.`);
  parts.push(crossingIso ? `${crossingText(crossingIso, daily)}.` : "Discharge does not cross the line in this window.");
  return parts.join(" ");
}
