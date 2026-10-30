import type { SkepticOutcome } from "../types/skeptic";

export type { SkepticOutcome };

export interface CausalLink {
  id: "rain" | "catchment" | "river" | "site";
  label: string;
  title: string;
  note: string;
  claim_id: string;
}

export interface SkepticVerdict {
  claim_id: string;
  outcome: SkepticOutcome;
  counter_check: string;
}

export const causalChain: CausalLink[] = [
  {
    id: "rain",
    label: "Rain",
    title: "Rain the day before the discharge peak",
    note: "Hourly rain is hazard_timeline. This seed extract covers 28–30 Oct 2024. warning_level stays null.",
    claim_id: "claim_val01_rain",
  },
  {
    id: "catchment",
    label: "Catchment",
    title: "Chiva, upstream of the Barranc del Poyo",
    note: "VAL07 is the Chiva point on the Valencia point list. discharge_daily has no upstream column.",
    claim_id: "claim_val07",
  },
  {
    id: "river",
    label: "River",
    title: "Modelled discharge at Paiporta",
    note: "GloFAS via Open-Meteo. Modelled discharge, not a gauge on the rambla.",
    claim_id: "claim_val01_peak",
  },
  {
    id: "site",
    label: "Site",
    title: "The shared grid cell at Horta Sud",
    note: "VAL01 in_flood comes from the point list. Identical VAL01 and VAL02 values are one 0.05° GloFAS cell, not two gauges.",
    claim_id: "claim_grid",
  },
];

export const skepticVerdicts: SkepticVerdict[] = [
  {
    claim_id: "claim_val01_rain",
    outcome: "challenged",
    counter_check:
      "The peak rain hour is 29 Oct 12:00 UTC, and 467.81 m³/s is the next calendar day. warning_level is null. The row supports the rain figure and does not name a channel.",
  },
  {
    claim_id: "claim_val07",
    outcome: "held",
    counter_check:
      "0.62 and 45.99 match the VAL07 rows, and the source stamp matches. Calling Chiva upstream is the point list, not a discharge_daily column.",
  },
  {
    claim_id: "claim_val01_peak",
    outcome: "held",
    counter_check:
      "467.81 is the VAL01 row for 30 Oct 2024. From 20 Oct through 27 Oct the same point stays between 5.27 and 11.02. The source value is the seed stamp.",
  },
  {
    claim_id: "claim_grid",
    outcome: "revised",
    counter_check:
      "The two-row sample shows the 30 Oct pair. Across all 17 dates in the fixture, VAL01 and VAL02 are identical. The claim holds once it is read as one Open-Meteo grid cell, not two gauges.",
  },
];
