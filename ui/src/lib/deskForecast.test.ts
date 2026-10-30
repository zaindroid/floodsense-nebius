import { describe, expect, it } from "vitest";
import { forecastLine, peakWhen } from "./deskForecast";
import type { PointNow } from "./now";

const pt = (now: number | null, max: number | null, trend: PointNow["trend"] = "flat"): PointNow =>
  ({
    point_id: "VAL01",
    latest: now === null ? null : { discharge_m3s: now },
    trend,
    forecastMax: max === null ? null : { discharge_m3s: max, ts_utc: "2026-10-30T05:00:00Z" },
  }) as unknown as PointNow;
const val = { id: "valencia:VAL01" };

describe("forecastLine", () => {
  it("rising names the peak as a day part, with no digits", () => {
    const line = forecastLine(val, [pt(10, 30, "up")], new Date("2026-10-29T10:00:00Z"));
    expect(line).toBe("Water is rising and may peak tomorrow morning.");
    expect(line).not.toMatch(/\d/);
  });
  it("day-part boundaries in Madrid time", () => {
    const now = new Date("2026-10-30T08:00:00Z");
    const w = (iso: string) => peakWhen(iso, now);
    expect(w("2026-10-30T16:00:00Z")).toBe("this evening");
    expect(w("2026-10-30T22:00:00Z")).toBe("tonight");
    expect(w("2026-10-31T10:00:00Z")).toBe("tomorrow morning");
    expect(w("2026-10-31T12:00:00Z")).toBe("tomorrow afternoon");
    expect(w("2026-11-01T14:00:00Z")).toBe("on Sunday afternoon");
  });
  it("falling and steady", () => {
    expect(forecastLine(val, [pt(10, 10, "down")])).toBe("Water is falling, no rise expected in the next two days.");
    expect(forecastLine(val, [pt(10, 10.2, "flat")])).toBe("Water is steady, no rise expected in the next two days.");
  });
  it("trend up but forecast max below the rise threshold is not called steady", () => {
    expect(forecastLine(val, [pt(10, 10.5, "up")])).toBe("Water level is up slightly, no big rise expected in the next two days.");
  });
  it("null when nothing real to say", () => {
    expect(forecastLine({ id: "gauge:X" }, [pt(10, 30)])).toBeNull();
    expect(forecastLine(val, [pt(10, null)])).toBeNull();
    expect(forecastLine(val, [pt(null, 30)])).toBeNull();
    expect(forecastLine(null, [])).toBeNull();
  });
});
