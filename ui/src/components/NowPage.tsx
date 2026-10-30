import { useEffect, useState } from "react";
import { next48hQuestion } from "../api/ask";
import { useConsole } from "../context/ConsoleContext";
import type { WatchSource } from "../lib/euWatch";
import { relativeTime } from "../lib/now";
import { basisLabel, calmSentence, headlineCounts, headlineText, plainOf, worstFirst } from "../lib/places";
import { EuWatchLegend, EuWatchMap } from "./EuWatch";
import { LoadingNote, SlowSourceNote } from "./Loading";
import { DemoChip, LiveHealthNote, SwitchToLive } from "./ModeSwitch";
import { PlacePicker, useCitizenPlace } from "./CitizenView";
import { demoSnapshotText } from "../lib/demo";
import { InsurerNowPage } from "./InsurerNowPage";
import { LiveSourceBadge } from "./LiveSources";
import { evidenceFor, PlacesToWatch, sourceTitle, StatusChip, timeText } from "./PlacesToWatch";

/** Now: insurers keep the dense page; citizens get the calm, live-first one. */
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
 * then ONE Europe map of every live-watch source, the legend behind "How we colour the map", and "Places to watch",
 * worst first. Numbers only behind Details.
 */
function CitizenNowPage() {
  const { openAsk, placeId, demo } = useConsole();
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

  return (
    <div className="now-page">
      <header className="now-head">
        <div>
          <h2 className="now-title">Right now, across our watch</h2>
          <p className="now-meta" aria-live="polite">
            <span className="now-live-tag">{demo ? `Demo snapshot ${demoSnapshotText()}` : live.sources.length > 0 ? "Live data · Zetaris" : "Live data unavailable"}</span> {demo && <DemoChip />}
            {live.updatedAt ? ` Updated ${relativeTime(live.updatedAt, clock)}${live.health.failed.length > 0 && !live.health.loading ? ` · ${live.health.loaded} of ${live.health.total} sources` : ""}` : ""}
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="now-refresh" onClick={() => openAsk(next48hQuestion(lead?.name), lead ? { place: lead.name } : undefined)}>
            Is the next 48 h safe {lead ? "at " + lead.name : "anywhere"}?
          </button>
          <button type="button" className="now-refresh" onClick={live.refresh}>
            Refresh
          </button>
        </div>
      </header>

      <LiveHealthNote live={live} />
      {lead ? (
        <section className="now-lead" aria-label={chosen ? "Your place" : "Most notable place right now"}>
          <p className="eyebrow">{chosen ? "Your place" : "Most notable right now"}</p>
          <p>
            <StatusChip view={plainOf(lead)} large /> <strong>{sourceTitle(lead)}</strong>{" "}
            <span className="muted small">{lead.country}</span>
          </p>
          <p>
            {calmSentence(lead.kind, lead.status, lead.river, lead.name)}{" "}
            <LiveSourceBadge n={1} evidence={evidenceFor(live, lead)} />
          </p>
          <p className="note">
            {timeText(lead.kind, lead.measuredAt)} · {basisLabel(lead.kind)}
          </p>
          <p className="note">Across the watch: {headlineText(headlineCounts(live.sources))}{live.health.failed.length > 0 && !live.health.loading ? ` (of the ${live.sources.length} loaded)` : ""}.</p>
        </section>
      ) : (
        loading ? (
          <LoadingNote what="live readings" />
        ) : (
          <p className="now-status" role="status">
            No live readings right now: the live views did not answer. Try Refresh in a few minutes, or switch on Demo data in the header.
          </p>
        )
      )}

      <SlowSourceNote pending={loading && live.sources.length > 0} what="A live source" />
      <section className="now-region" aria-label="Find a place">
        <h3 className="now-subtitle">Find your place</h3>
        <PlacePicker {...ctx} />
      </section>

      <section className="now-region" aria-labelledby="now-eu">
        <div className="now-region-head">
          <h3 className="now-subtitle" id="now-eu">
            Europe · live watch
          </h3>
        </div>
        <EuWatchMap sources={live.sources} />
        <details className="disclosure">
          <summary>How we colour the map</summary>
          <p className="now-note">
            Circles are river gauges, measured, against each station's long-term mean high water (not a warning level).
            Diamonds and squares are GloFAS model points: a model, not an official warning. Faded or dashed markers are not
            a fresh live reading. Click a place to ask about it.
          </p>
          <EuWatchLegend />
          {live.euWatch.state === "unavailable" && <p className="note">GloFAS points unavailable: {live.euWatch.detail}</p>}
          {live.hazard.state === "error" && <p className="note">Valencia points unavailable: {live.hazard.detail}</p>}
          {live.gauges.state === "unavailable" && <p className="note">Gauges unavailable: {live.gauges.detail}</p>}
        </details>
        <PlacesToWatch live={live} onAsk={ask} start={2} exclude={lead?.id ?? null} />
        <p className="now-source">
          Quelle: WSV, PEGELONLINE (DL-DE-Zero-2.0) · Weather data by Open-Meteo.com (GloFAS, CC BY 4.0) · via Zetaris
        </p>
      </section>
    </div>
  );
}
