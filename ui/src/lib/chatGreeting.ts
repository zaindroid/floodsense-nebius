import { EVENT_META, type EventId } from "./events";
import type { Mode } from "./mode";
import type { DeskRoute } from "./route";

export interface ChatGreeting {
  text: string;
  /** Three questions that fit the page. A click sends one as typed. */
  suggestions: readonly string[];
}

const CITIZEN_TEXT = "Hi! I'm FloodSense. Ask me about flood risk where you are — every answer cites its sources.";
const INSURER_TEXT = "Hi! I'm FloodSense. Ask me about your portfolio's flood exposure — every answer cites its sources.";

const OPERATOR_TEXT = "Hi! I'm FloodSense. I can brief you on any watched place and prepare a script for callers — every answer cites its sources.";

const OPERATOR_SUGGESTIONS = [
  "Which gauges on the Elbe are above normal?",
  "Brief me on the Rhine at Köln",
  "What does the 48 h outlook show along the Danube?",
] as const;

const INSURER_SUGGESTIONS = [
  "Which of our insured sites are exposed in Valencia?",
  "How much insured value sits inside the flood footprint?",
  "Which sites should we review first?",
] as const;

const INSURER_AHR_SUGGESTIONS = [
  "Which of our sites lie in the Ahr valley flood footprint?",
  "How high did the Ahr rise at Altenahr on 14 July 2021?",
  "What happened in the Ahr valley in July 2021?",
] as const;

const CITIZEN_LIVE_SUGGESTIONS = [
  "Do the next 48 hours look safe at Köln?",
  "How high is the Rhine at Köln today?",
  "Is anything in our watch above its mean high water right now?",
] as const;

const CITIZEN_PAST_SUGGESTIONS: Record<EventId, readonly string[]> = {
  EMSR517: [
    "What happened in the Ahr valley in July 2021?",
    "How high did the Ahr rise at Altenahr on 14 July 2021?",
    "When did the Ahr cross the alert line in July 2021?",
  ],
  EMSR773: [
    "What happened at Paiporta in the Valencia flood of October 2024?",
    "When did the Valencia points cross the alert line in October 2024?",
    "How much rain fell around Valencia on 29 October 2024?",
  ],
};

const INSURER_LIVE_SUGGESTIONS = [
  "Which of our insured sites are near a raised watch source?",
  "Do the next 48 hours look safe for our sites?",
  "Which sites should we review first?",
] as const;

/**
 * Pure: the opening message for a role, page and global mode. Live suggestions are about the live watch;
 * Past suggestions are about the chosen flood, so an Ahr page never suggests a Valencia question.
 */
export function greetingFor(route: DeskRoute, mode: Mode = "live", shownEvent: EventId = "EMSR773"): ChatGreeting {
  if (route.role === "operator") return { text: OPERATOR_TEXT, suggestions: OPERATOR_SUGGESTIONS };
  if (route.role === "insurer") {
    if (mode === "live") return { text: INSURER_TEXT, suggestions: INSURER_LIVE_SUGGESTIONS };
    return { text: INSURER_TEXT, suggestions: shownEvent === "EMSR517" ? INSURER_AHR_SUGGESTIONS : INSURER_SUGGESTIONS };
  }
  if (mode === "past") return { text: CITIZEN_TEXT, suggestions: CITIZEN_PAST_SUGGESTIONS[shownEvent] };
  return { text: CITIZEN_TEXT, suggestions: CITIZEN_LIVE_SUGGESTIONS };
}

/** Pure: the label of the button that re-asks a declined question on the event that holds it. */
export function switchEventLabel(eventId: string): string | null {
  const meta = EVENT_META[eventId as EventId];
  return meta ? `Ask about ${meta.short} instead` : null;
}

/** Pure: the event a declined run's switch button re-asks on, or null when no button shows. */
export function switchTarget(run: { status: string | null; elsewhere?: string | null }): string | null {
  if (run.status !== "out_of_scope" || !run.elsewhere) return null;
  return switchEventLabel(run.elsewhere) ? run.elsewhere : null;
}
