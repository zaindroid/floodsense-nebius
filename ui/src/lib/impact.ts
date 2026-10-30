import type { ExposureJoinRow } from "../types/views";
import type { WatchSource } from "./euWatch";
import { headlineCounts } from "./places";
import { exposureStats } from "./series";

export interface Chip {
  label: string;
  /** null renders as "no data yet": never a made-up number. */
  value: string | null;
}

export const GOALS = {
  citizen: "Is my street at risk, and what do I do?",
  insurer: "Which insured sites are exposed, and what do we tell the customer?",
  operator: "Which rivers and places need attention first, and what do hotline staff tell callers?",
} as const;

/** Cited facts from docs/DECK-FACTS.md; none of these is on its "sources disagree" list. */
export const FACTS = {
  citizen: {
    text: "At 18:00, the town of Turís recorded 42 mm of precipitation in 10 minutes, and set the new Spanish record with 184.6 mm (7.27 in) in one hour.",
    source: "2024 Spanish floods, Wikipedia rev. 1379732613 (docs/DECK-FACTS.md, section 4 paragraph 3)",
  },
  insurer: {
    text: "Munich Re estimates the total damage to have been 10.7 billion euros ($11 billion) of which 4.1 billion euros ($4.2 billion) were insured.",
    source: "2024 Spanish floods, Wikipedia rev. 1379732613 (docs/DECK-FACTS.md, section 5 paragraph 4)",
  },
  operator: {
    text: "Valencia alone accounted for 70% of flood-related deaths in Europe in 2024.",
    source: "2024 Spanish floods, Wikipedia rev. 1379732613 (docs/DECK-FACTS.md, section 5 paragraph 5)",
  },
} as const;

const n = (v: number) => v.toLocaleString("en-GB");

export function citizenChips(sources: readonly WatchSource[]): Chip[] {
  if (sources.length === 0)
    return ["Places watched", "Gauges close to or above mean high water", "Model points at Watch or Elevated (model)"].map((label) => ({ label, value: null }));
  const c = headlineCounts(sources);
  return [
    { label: "Places watched", value: n(c.total) },
    { label: "Gauges close to or above mean high water", value: n(c.gaugesAbove + c.gaugesNear) },
    { label: "Model points at Watch or Elevated (model)", value: n(c.modelElevated + c.modelWatch) },
  ];
}

/** Pending-approvals chip text: null when unread or in demo mode, "50+" when the list was capped by the fetch limit. */
export function pendingLabel(awaiting: number | null, fetched: number, limit: number, demo: boolean): string | null {
  if (demo || awaiting === null) return null;
  return fetched >= limit ? `${n(awaiting)}+` : n(awaiting);
}

export function insurerChips(rows: readonly ExposureJoinRow[], watched: number): Chip[] {
  const s = rows.length > 0 ? exposureStats([...rows]) : null;
  return [
    { label: "Policies exposed (synthetic book)", value: s ? `${n(s.inFootprint)} of ${n(s.policies)}` : null },
    { label: "Sum insured exposed (synthetic)", value: s ? `EUR ${n(Math.round(s.sumInsured))}` : null },
    { label: "Live sources watched", value: watched > 0 ? n(watched) : null },
  ];
}

export function operatorChips(sources: readonly WatchSource[], pending: string | null): Chip[] {
  const has = sources.length > 0;
  const c = headlineCounts(sources);
  return [
    { label: "Gauges close to or above mean high water", value: has ? n(c.gaugesAbove + c.gaugesNear) : null },
    { label: "Model points at Watch or Elevated (model)", value: has ? n(c.modelElevated + c.modelWatch) : null },
    { label: "Approvals awaiting a person", value: pending },
  ];
}
