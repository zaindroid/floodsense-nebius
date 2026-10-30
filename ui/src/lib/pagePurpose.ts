import type { CitizenPage, InsurerPage, OperatorPage } from "./route";

export interface PagePurpose {
  /** What the page is for in the story. */
  purpose: string;
  /** Where its data comes from. */
  data: string;
  /** What it shows in Live mode. */
  live: string;
  /** What it shows in Past flood mode. */
  past: string;
}

/** One row per page and desk. ui/README.md carries the same table; pagePurpose.test.ts keeps them in step. */
export const CITIZEN_PURPOSE: Record<CitizenPage, PagePurpose> = {
  now: {
    purpose: "Is anything near me high right now?",
    data: "gauge_levels, eu_watch, hazard_now",
    live: "Most notable place, search, Europe map, places to watch (all 45)",
    past: "Switch to Live to see this",
  },
  replay: {
    purpose: "How did a past flood unfold?",
    data: "hazard_timeline (floodsense_seed), bundled Ahr rows",
    live: "Choose a flood (switches to Past)",
    past: "Moments, hour scrubber, chart for the chosen flood",
  },
  overview: {
    purpose: "Is my area at risk, and why?",
    data: "all live views; replay rows in Past",
    live: "Risk card, place picker, next 48 h and Ask buttons",
    past: "Status of a place on the replay day",
  },
  area: {
    purpose: "Show my place on a map",
    data: "live views; discharge_daily and the Ahr seed in Past",
    live: "Place map, same-river places, or the whole watch",
    past: "Event map and the chosen point",
  },
  actions: {
    purpose: "What do I do?",
    data: "built-in safety guidance, official warning links",
    live: "Warning links for the place's country",
    past: "Same guidance, labelled as part of a replay",
  },
  evidence: {
    purpose: "Where does this come from?",
    data: "live view query ids; provenance and citations in Past",
    live: "View, query id and fetch time per source",
    past: "Replay provenance and the reviewed answer's citations",
  },
  how: {
    purpose: "How does FloodSense work?",
    data: "/config, /system",
    live: "Router, agents, data and human approval, with status dots",
    past: "Same",
  },
  tower: {
    purpose: "How does FloodSense keep watch, and is it running?",
    data: "/watch/status, /watch/events (read only)",
    live: "The watch loop, its feed and the sources it scans, read only",
    past: "Switch to Live to see this",
  },
};

export const INSURER_PURPOSE: Record<InsurerPage, PagePurpose> = {
  now: {
    purpose: "What is happening in the watch right now?",
    data: "hazard_now, gauge_levels, eu_watch",
    live: "Valencia cards, gauge map and list, Europe map",
    past: "Switch to Live to see this",
  },
  replay: {
    purpose: "How did a past flood unfold?",
    data: "hazard_timeline (floodsense_seed), bundled Ahr rows",
    live: "Choose a flood (switches to Past)",
    past: "Scrubber, chart and table for the chosen flood",
  },
  approvals: {
    purpose: "Which agent answers need a decision?",
    data: "/runs/past, live-run handoff",
    live: "Queue and the decision bar (same in both modes)",
    past: "Same queue; each run carries its own event",
  },
  portfolio: {
    purpose: "Which sites are exposed?",
    data: "exposure_join, live watch; replay exposure in Past",
    live: "Sites grouped by nearest watched source",
    past: "Replay exposure (Valencia) or a note that Ahr has no book",
  },
  sites: {
    purpose: "Where are the sites against the rivers?",
    data: "live watch, exposure_join; discharge_daily and Ahr seed in Past",
    live: "Europe map with every source and the insured sites",
    past: "Event map with the replay date slider and drill-down",
  },
  alerts: {
    purpose: "Which sources are raised, and what do we do?",
    data: "gauge_levels, eu_watch",
    live: "Live alert monitor, with an agent assessment per alert",
    past: "Switch to Live for the monitor; rehearsal of the chosen flood",
  },
  review: {
    purpose: "Is the evidence solid?",
    data: "bundled recorded run (Valencia 2024)",
    live: "Causal chain, Skeptic, Judge of the recorded run",
    past: "Same recorded run",
  },
  system: {
    purpose: "Are memory, cache, limits and models healthy?",
    data: "/system",
    live: "Counters and status (same in both modes)",
    past: "Same",
  },
  how: {
    purpose: "How does FloodSense work?",
    data: "/config, /system",
    live: "Router, agents, data and human approval, with status dots",
    past: "Same",
  },
  tower: {
    purpose: "Is the watch loop running, and what did it find?",
    data: "/watch/status, /watch/events, live watch",
    live: "Loop state, event feed, scan now, auto-assess switch",
    past: "Switch to Live to see this",
  },
};

/** The Civil protection desk is live only: its Past column says so. */
export const OPERATOR_PURPOSE: Record<OperatorPage, PagePurpose> = {
  situation: {
    purpose: "Which places need a call, and what do we say?",
    data: "gauge_levels, eu_watch, hazard_now, forecast lane",
    live: "Situation board with N of 45 sources, a call script and Escalate to agents",
    past: "Live only (no past form)",
  },
  approvals: {
    purpose: "Which of our escalated runs need a decision?",
    data: "/runs/past (this desk's own runs)",
    live: "Queue and decision bar for runs started here",
    past: "Live only (no past form)",
  },
  how: {
    purpose: "How does FloodSense work?",
    data: "/config, /system",
    live: "Router, agents, data and human approval, with status dots",
    past: "Live only (no past form)",
  },
};
