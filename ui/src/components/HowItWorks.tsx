import { useEffect, useState, type ReactNode } from "react";
import { fetchAgentsConfig } from "../api/config";
import { fetchSystem } from "../api/system";
import { fetchGaugeLevels } from "../api/gauges";
import { TechTraceOverview } from "./TechTrace";
import { useConsole } from "../context/ConsoleContext";
import { boxStatuses, DOT_TEXT, feedsMode, zetarisHealth, humanBox, type BoxId, type ConfigProbe, type DotState } from "../lib/howItWorks";
import type { SystemStatus } from "../lib/system";

const AGENTS = ["Scope", "Watchers", "Memory", "Investigator", "Skeptic", "Exposure", "Playbook", "Judge"];

function Dot({ state, note }: { state: DotState; note?: string | null }) {
  const text = note ? `${DOT_TEXT[state]}: ${note}` : DOT_TEXT[state];
  return (
    <span className={`hiw-dot hiw-dot-${state}`} title={text}>
      <span className="sr-only">Status: {text}</span>
    </span>
  );
}

function Box({
  id,
  title,
  line,
  status,
  note,
  children,
}: {
  id: BoxId;
  title: string;
  line: string;
  status: Record<BoxId, DotState> | null;
  /** Why the dot is not plain green (e.g. a rate limit). */
  note?: string | null;
  children?: ReactNode;
}) {
  return (
    <section className={`hiw-box hiw-box-${id}`} aria-label={title}>
      <p className="hiw-box-title">
        <Dot state={status ? status[id] : "unknown"} note={note} /> {title}
      </p>
      <p className="hiw-box-line">{line}</p>
      {note && <p className="note">{note}</p>}
      {children}
    </section>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <p className="hiw-arrow" aria-hidden="true">
      ↓{label ? <span> {label}</span> : null}
    </p>
  );
}

/** One page diagram of the system, with a live status dot per box from GET /config and GET /system. */
export function HowItWorks() {
  const [probes, setProbes] = useState<{ config: ConfigProbe; system: SystemStatus | null; systemError: string | null; gauge: "rows" | "empty" | "unavailable" | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([fetchAgentsConfig(controller.signal), fetchSystem(undefined, controller.signal), fetchGaugeLevels(controller.signal)]).then(([config, sys, gauges]) => {
      if (!controller.signal.aborted && !sys.aborted) setProbes({ config, system: sys.status, systemError: sys.error, gauge: gauges.state });
    });
    return () => controller.abort();
  }, []);
  const status = probes ? boxStatuses(probes.config, probes.system, probes.gauge) : null;
  const mode = probes ? feedsMode(probes.config) : null;
  const zetarisNote = probes ? zetarisHealth(probes.system?.viewsCache, probes.gauge).note : null;
  const { route } = useConsole();
  const human = humanBox(route);
  const intro =
    route === "citizen"
      ? "A question goes through a router, a team of agents that read real data through Zetaris, and an independent checker. Dots show what is running right now."
      : "A question goes through a router, a team of agents that read real data through Zetaris, an independent checker, and a person before anything is sent. Dots show what is running right now.";

  return (
    <div className="view hiw">
      <div className="view__intro">
        <div>
          <h2 className="view__title">How it works</h2>
          <p className="muted">{intro}</p>
        </div>
      </div>
      <p className="hiw-legend note" aria-label="Status legend">
        <Dot state="ok" /> running <Dot state="partial" /> partly unavailable <Dot state="off" /> switched off <Dot state="down" /> not reachable <Dot state="unknown" />{" "}
        unknown
        {probes && !probes.system && " · component health (GET /system) is not available, so some dots are unknown"}
      </p>

      <TechTraceOverview status={status} />
      <div className="hiw-flow">
        <p className="hiw-start">Your question</p>
        <Arrow />
        <Box id="router" title="Router" line="Reads the question and picks the cheapest path that can answer it." status={status}>
          <ul className="hiw-lanes" aria-label="Router lanes">
            <li>
              <strong>reply</strong> greetings and help, answered at once
            </li>
            <li>
              <strong>quick</strong> one data lookup, short answer
            </li>
            <li>
              <strong>full</strong> the whole agent team below
            </li>
          </ul>
        </Box>
        <Arrow label="full" />
        <Box id="agents" title="Agent team" line="Each agent does one job and hands a cited result to the next." status={status}>
          <ol className="hiw-agents" aria-label="Agents in order">
            {AGENTS.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ol>
        </Box>

        <div className="hiw-grid">
          <Box
            id="zetaris"
            title="Data via Zetaris"
            line={`Every number comes from a SQL query with an id you can open.${mode ? ` Now: ${mode}.` : ""}`}
            status={status}
            note={zetarisNote}
          >
            <ul className="hiw-tags">
              <li>Open-Meteo GloFAS</li>
              <li>PEGELONLINE</li>
              <li>Copernicus EMS</li>
              <li>Seed data</li>
            </ul>
          </Box>
          <Box
            id="nightshift"
            title="Nightshift · NVIDIA Nemotron"
            line="The language model the agents think with: a fast lane for quick steps, a deep lane for checking."
            status={status}
          >
            <ul className="hiw-tags">
              <li>fast lane</li>
              <li>deep lane</li>
            </ul>
          </Box>
          <Box
            id="memory"
            title="Meterless H-MEM + World Model"
            line="Remembers only findings a person approved, and tracks which hypotheses still hold."
            status={status}
          />
          <Box
            id="rag"
            title="Document search (RAG)"
            line="Finds the page and paragraph in reports and maps that back a sentence."
            status={status}
          >
            <ul className="hiw-tags">
              <li>pgvector</li>
              <li>NIM nemotron-embed</li>
            </ul>
          </Box>
          <Box
            id="redis"
            title="Redis cache + rate limits"
            line="Repeats a recent answer instantly and keeps the service fair when it is busy."
            status={status}
          />
          <Box id="feeds" title="Live feeds" line="Open-Meteo and PEGELONLINE polled on a schedule when live data is on." status={status} />
        </div>

        <Arrow />
        <Box id="human" title={human.title} line={human.line} status={status} />
      </div>
    </div>
  );
}
