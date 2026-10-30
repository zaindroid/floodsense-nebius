import { useEffect, useState } from "react";
import { next48hQuestion } from "../api/ask";
import { useConsole } from "../context/ConsoleContext";
import type { WatchSource } from "../lib/euWatch";
import { relativeTime } from "../lib/now";
import { headlineCounts, headlineText, worstFirst } from "../lib/places";
import { EuWatchLegend, EuWatchMap } from "./EuWatch";
import { LoadingNote, SlowSourceNote } from "./Loading";
import { DemoChip, LiveHealthNote, SwitchToLive } from "./ModeSwitch";
import { PlacePicker, useCitizenPlace } from "./CitizenView";
import { demoSnapshotText } from "../lib/demo";
import { ImpactStrip } from "./ImpactStrip";
import { citizenChips, FACTS, GOALS } from "../lib/impact";
import { forecastLine } from "../lib/deskForecast";
import { InsurerNowPage } from "./InsurerNowPage";
import { useStackData } from "../hooks/useStackData";
import { AgentsLive } from "./agents/AgentsLive";
import { WebCheckCard } from "./desk/WebCheck";
import { DeskCard, DeskHead, DeskPage, EvidenceRow, ForecastCard, HazardLead } from "./desk/DeskPage";
import { evidenceFor, PlacesToWatch } from "./PlacesToWatch";

/** Now: insurers keep the dense page; citizens get the calm, live-first one. Both render through DeskPage. */
export function NowPage() {
  const { route, mode } = useConsole();
  if (mode === "past")
    return (
      <SwitchToLive title="Now shows live readings">
        You are viewing a past flood, so there is no "now" here. Live readings from the gauges and model points are one click away. To see the past
        flood itself, open Replay.
      </SwitchToLive>
    );
  return route === "insurer" ? <InsurerNowPage /> : <CitizenNowPage />;
}

/**
 * Citizen Now: the chosen place (or the worst place in the watch) first, in one plain sentence with its source;
 * then its 48 h outlook, ONE Europe map of every live-watch source, the evidence entry and "Places to watch", worst first.
 * Numbers only behind Details.
 */
function CitizenNowPage() {
  const { openAsk, openLiveEvidence, placeId, demo } = useConsole();
  const stack = useStackData();
  const ctx = useCitizenPlace();
  const live = ctx.live;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  const chosen = live.sources.find((s) => s.id === placeId) ?? null;
  const lead: WatchSource | null = chosen ?? worstFirst(live.sources)[0] ?? null;
  const loading = live.gauges.state === "loading" || live.euWatch.state === "loading" || live.hazard.state === "loading";
  const ask = (s: WatchSource) => openAsk(s.question, { page: "now", place: s.name });
  const evidence = lead ? evidenceFor(live, lead) : null;
  const line = forecastLine(lead, live.valencia);
  const partial = live.health.failed.length > 0 && !live.health.loading;

  return (
    <DeskPage
      desk="citizen"
      impact={<ImpactStrip goal={GOALS.citizen} chips={citizenChips(live.sources)} fact={FACTS.citizen} />}
      head={
        <DeskHead
          title="Right now, across our watch"
          tag={<span className="desk-tag">{demo ? `Demo snapshot ${demoSnapshotText()}` : live.sources.length > 0 ? "Live data · Zetaris" : "Live data unavailable"}</span>}
          updated={
            <>
              {demo && <DemoChip />}
              {live.updatedAt ? ` Updated ${relativeTime(live.updatedAt, clock)}${partial ? ` · ${live.health.loaded} of ${live.health.total} sources` : ""}` : ""}
            </>
          }
        >
          <button type="button" className="now-refresh" onClick={() => openAsk(next48hQuestion(lead?.name), lead ? { place: lead.name } : undefined)}>
            Is the next 48 h safe {lead ? "at " + lead.name : "anywhere"}?
          </button>
          <button type="button" className="now-refresh" onClick={live.refresh}>
            Refresh
          </button>
        </DeskHead>
      }
      health={
        <>
          <LiveHealthNote live={live} />
          <SlowSourceNote pending={loading && live.sources.length > 0} what="A live source" />
        </>
      }
      hazard={
        lead && evidence ? (
          <HazardLead
            label={chosen ? "Your place" : "Most notable right now"}
            source={lead}
            evidence={evidence}
            summary={
              <p className="note">
                Across the watch: {headlineText(headlineCounts(live.sources))}
                {partial ? ` (of the ${live.sources.length} loaded)` : ""}.
              </p>
            }
          />
        ) : loading ? (
          <LoadingNote what="live readings" />
        ) : (
          <p className="now-status" role="status">
            No live readings right now: the live views did not answer. Try Refresh in a few minutes, or switch on Demo data in the header.
          </p>
        )
      }
      forecast={
        lead &&
        (line ? (
          <ForecastCard title={lead.name}>
            <p>{line}</p>
          </ForecastCard>
        ) : (
          <p className="note">We are watching this place; a detailed outlook is not available here yet.</p>
        ))
      }
      map={
        <>
          <DeskCard label="Find a place">
            <PlacePicker {...ctx} />
          </DeskCard>
          <DeskCard label="Map" title="Europe · live watch">
            <EuWatchMap sources={live.sources} />
            <details className="disclosure">
              <summary>How we colour the map</summary>
              <p className="note">
                Circles are river gauges, measured, against each station's long-term mean high water (not a warning level).
                Diamonds and squares are GloFAS model points: a model, not an official warning. Faded or dashed markers are not
                a fresh live reading. Click a place to ask about it.
              </p>
              <EuWatchLegend />
              {live.euWatch.state === "unavailable" && <p className="note">GloFAS points unavailable: {live.euWatch.detail}</p>}
              {live.hazard.state === "error" && <p className="note">Valencia points unavailable: {live.hazard.detail}</p>}
              {live.gauges.state === "unavailable" && <p className="note">Gauges unavailable: {live.gauges.detail}</p>}
            </details>
          </DeskCard>
        </>
      }
      evidence={
        <>
          {evidence && <EvidenceRow evidence={evidence} onOpen={() => openLiveEvidence(evidence)} />}
          <WebCheckCard stack={stack} desk="citizen" place={lead?.name} />
        </>
      }
      agents={<AgentsLive stack={stack} compact plain />}
      actions={
        <div className="card desk-card">
          <PlacesToWatch live={live} onAsk={ask} start={2} exclude={lead?.id ?? null} />
        </div>
      }
      footer={
        <p className="desk-source">Quelle: WSV, PEGELONLINE (DL-DE-Zero-2.0) · Weather data by Open-Meteo.com (GloFAS, CC BY 4.0) · via Zetaris</p>
      }
    />
  );
}
