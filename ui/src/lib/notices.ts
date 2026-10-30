import type { Answer } from "../types/contract";
import type { Notice } from "../types/ui";
import type { DischargeDailyRow } from "../types/views";
import { servingLabel, formatDay } from "./format";
import { datesOf } from "./series";

export function replayNotice(answer: Answer): Notice {
  const serving = servingLabel(answer);
  return {
    id: "replay-loaded",
    tone: "info",
    read: false,
    title: "Replay on the insurer desk",
    body: `The reviewed answer is a ${answer.served_from}, ${serving.kind === "cached" ? `${serving.text} UTC` : serving.text}. The top-bar chip has the detail.`,
  };
}

function dischargeSpan(rows: DischargeDailyRow[]): { points: number; span: string; sourceText: string } {
  const points = new Set(rows.map((row) => row.point_id)).size;
  const dates = datesOf(rows);
  const sources = [...new Set(rows.map((row) => row.source))];
  const span =
    dates.length === 0
      ? "no dates"
      : dates.length === 1
        ? formatDay(dates[0])
        : `${formatDay(dates[0])}–${formatDay(dates[dates.length - 1])}`;
  const sourceText = sources.length === 0 ? "no source value" : sources.join(", ");
  return { points, span, sourceText };
}

/** Shown only while discharge rows are the fixture. Wording comes from those rows. */
export function fixtureDischargeNotice(rows: DischargeDailyRow[]): Notice {
  const { points, span, sourceText } = dischargeSpan(rows);
  return {
    id: "fixture-loaded",
    tone: "info",
    read: false,
    title: "Discharge fixture loaded",
    body: `${points} points, ${span}. Source column: ${sourceText}.`,
  };
}

/** View response whose source stamps are seed. */
export function seedRowsNotice(rows: DischargeDailyRow[]): Notice {
  const { points, span, sourceText } = dischargeSpan(rows);
  return {
    id: "seed-loaded",
    tone: "info",
    read: false,
    title: "Seed discharge rows",
    body: `${points} points, ${span}. Source column: ${sourceText}. These rows are seed.`,
  };
}
