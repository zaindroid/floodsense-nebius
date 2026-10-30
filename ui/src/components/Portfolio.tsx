import { useMemo, useState } from "react";
import { SIMULATED_ALERT_M3S } from "../config/scenario";
import { useConsole } from "../context/ConsoleContext";
import { useInsurerWatch } from "../hooks/useInsurerWatch";
import { statusView } from "../lib/places";
import { formatDay, formatEur } from "../lib/format";
import { exposureStats, rowsOnDate } from "../lib/series";
import { EVENT_META } from "../lib/events";
import { DEMO_BOOK_LINE, groupByNearest, NEAR_KM, nearestSource, siteWatchLine } from "../lib/nearest";
import { hhmm } from "../lib/alertMonitor";
import { statusLabel } from "../lib/origin";
import { next48hQuestion } from "../api/ask";
import { OriginList } from "./Banners";
import { LoadingNote } from "./Loading";
import { LiveHealthNote, SwitchToLive } from "./ModeSwitch";
import "../styles/insurer.css";

const SITE_PAGE = 25;

/**
 * Follows the global mode. Live: each insured site against its nearest watched source. Past flood: the replay exposure
 * of the chosen event (Valencia has the synthetic book; Ahr says it has none), clearly a replay.
 */
export function Portfolio() {
  const { mode } = useConsole();
  if (mode === "past")
    return (
      <div className="page-stack">
        <ReplayExposure />
        <SwitchToLive title="Live site status is live-only">
          The nearest watched source per site, and its live status, only exist for live data.
        </SwitchToLive>
        <details className="card disclosure">
          <summary>Data origin</summary>
          <OriginList />
        </details>
      </div>
    );
  return <LivePortfolio />;
}

function LivePortfolio() {
  const desk = useConsole();
  const watch = useInsurerWatch();
  const sites = desk.exposure.rows;
  const nearest = useMemo(() => groupByNearest(sites, watch.sources), [sites, watch.sources]);
  const [shown, setShown] = useState(SITE_PAGE);

  return (
    <div className="page-stack">
      <section className="card" aria-labelledby="pf-live">
        <div className="card-head">
          <div>
            <p className="section-label">Insured sites · live watch</p>
            <h2 id="pf-live">Nearest watched source per site</h2>
          </div>
          <span className="chip chip--sample">{statusLabel(desk.exposure.origin)} book</span>
        </div>
        <LiveHealthNote live={watch.live} />
        <p className="demo-book">{DEMO_BOOK_LINE}</p>
        {watch.state === "loading" ? (
          <LoadingNote what="the live watch" partial />
        ) : watch.sources.length === 0 ? (
          <p className="note">The live watch returned no sources ({watch.detail || "no detail"}), so no site can be matched. Try again in a few minutes, switch on Demo data in the header, or switch to Past flood: Valencia 2024 for the replay exposure.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="pf-table">
                <caption className="sr-only">Insured sites grouped by nearest watched source</caption>
                <thead>
                  <tr>
                    <th scope="col">Nearest watched source</th>
                    <th scope="col">Live status</th>
                    <th scope="col">Distance</th>
                    <th scope="col">Sites</th>
                    <th scope="col">Next step</th>
                  </tr>
                </thead>
                <tbody>
                  {nearest.groups.map((g) => (
                    <tr key={g.source.id}>
                      <td data-label="Nearest source">
                        {g.source.river ? `${g.source.river} at ${g.source.name}` : g.source.name} <span className="muted small">({g.source.kind === "gauge" ? "gauge" : "model"}, {g.source.country})</span>
                      </td>
                      <td data-label="Live status">
                        {g.near ? (
                          <span className={`plain-chip plain-chip--${statusView(g.source.kind, g.source.status).tone}`}>{statusView(g.source.kind, g.source.status).word}</span>
                        ) : (
                          <span className="muted small">too far to describe these sites</span>
                        )}
                        {!g.source.live && <span className="muted small"> · not live</span>}
                      </td>
                      <td data-label="Distance">
                        {Math.round(g.minKm) === Math.round(g.maxKm) ? `${Math.round(g.minKm)} km` : `${Math.round(g.minKm)}–${Math.round(g.maxKm)} km`}
                      </td>
                      <td data-label="Sites">{g.sites}</td>
                      <td data-label="Next step">
                        <button type="button" className="link-button" onClick={() => desk.openAsk(next48hQuestion(g.source.name), { place: g.source.name })}>
                          Is the next 48 h safe here?
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note">
              A source within {NEAR_KM} km is taken to describe a site; farther, it is only the nearest one.
              {nearest.groups.length > 0 && !nearest.groups.some((g) => g.near)
                ? ` No watched source is within ${NEAR_KM} km of any site in this book, so no live reading describes these sites yet. Switch to Past flood: Valencia 2024 for the book's replay exposure.`
                : ""}
              {nearest.unplaced > 0 ? ` ${nearest.unplaced} site${nearest.unplaced === 1 ? " has" : "s have"} no usable lat/lon.` : ""}
              {watch.checkedAt !== null ? ` Checked ${hhmm(watch.checkedAt)}.` : ""}
            </p>
            <details className="disclosure">
              <summary>Per site ({sites.length})</summary>
              <ul className="pf-sites">
                {sites.slice(0, shown).map((site) => (
                  <li key={site.policy_id}>
                    <strong>{site.policy_id}</strong> <span className="muted small">{site.segment} · {formatEur(site.sum_insured_eur)}</span>
                    <br />
                    <span className="small">{siteWatchLine(nearestSource(site, watch.sources))}</span>
                  </li>
                ))}
              </ul>
              {shown < sites.length && (
                <button type="button" className="button" onClick={() => setShown((n) => n + SITE_PAGE * 4)}>
                  Show more ({sites.length - shown} left)
                </button>
              )}
            </details>
          </>
        )}
      </section>
      <details className="card disclosure">
        <summary>Data origin</summary>
        <OriginList />
      </details>
    </div>
  );
}

/** The EMSR773 replay exposure (synthetic book against the Copernicus footprint), clearly a replay. */
function ReplayExposure() {
  const desk = useConsole();
  const stats = useMemo(() => exposureStats(desk.exposure.rows), [desk.exposure.rows]);
  const peakCount = rowsOnDate(desk.discharge.rows, desk.date).filter((row) => row.discharge_m3s >= SIMULATED_ALERT_M3S).length;
  const largest = stats.segments[0]?.sum ?? 0;

  if (desk.eventId !== "EMSR773") {
    return (
      <section className="card" aria-label="Replay exposure">
        <p className="section-label">
          Replay exposure · {EVENT_META[desk.eventId].short} · not live
        </p>
        <h2>No insured book for this event</h2>
        <p className="note">
          The synthetic demo portfolio sits in Valencia, so it is joined to the Valencia 2024 flood footprint only. It has no policies or footprint rows
          for {EVENT_META[desk.eventId].short}, so there is nothing to total here.
        </p>
        <div className="button-row">
          <button type="button" className="button" onClick={() => desk.setEventId("EMSR773")}>
            Show the Valencia replay exposure
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="pf-replay">
      <div className="card-head">
        <div>
          <p className="section-label">Replay exposure · {formatDay(desk.date)} · not live</p>
          <h2 id="pf-replay">Synthetic book against the Valencia 2024 flood footprint</h2>
        </div>
        <span className="chip chip--sample">Replay of a past event</span>
      </div>
      <dl className="kpis">
        <div>
          <dt>Points</dt>
          <dd>{desk.points.length}</dd>
        </div>
        <div>
          <dt>Peak band</dt>
          <dd>{peakCount}</dd>
        </div>
        <div>
          <dt>in_footprint</dt>
          <dd>
            {stats.inFootprint} / {stats.policies}
          </dd>
        </div>
        <div>
          <dt>Sum insured</dt>
          <dd>{formatEur(stats.sumInsured)}</dd>
        </div>
      </dl>
      <h3 className="pf-sub">Sum insured inside the footprint, by segment</h3>
      {stats.segments.length === 0 ? (
        <p className="note">No policies inside the footprint in the loaded rows.</p>
      ) : (
        <ul className="bars">
          {stats.segments.map((segment) => (
            <li key={segment.segment}>
              <span className="bar-label">{segment.segment}</span>
              <span className="bar-track" aria-hidden="true">
                <span style={{ width: `${largest > 0 ? (segment.sum / largest) * 100 : 0}%` }} />
              </span>
              <span className="bar-value">
                {formatEur(segment.sum)} · {segment.count} {segment.count === 1 ? "policy" : "policies"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="note">
        Portfolio rows are synthetic. exposure_join.in_footprint marks them against the Copernicus Valencia 2024 footprint of the 29 Oct 2024 flood.
      </p>
    </section>
  );
}
