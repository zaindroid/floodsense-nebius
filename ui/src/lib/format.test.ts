import { describe, expect, it } from "vitest";
import type { Answer } from "../types/contract";
import { formatHour, formatUtcHm, servingLabel, servingQualifier } from "./format";
import { parseUtc } from "./time";

function answer(partial: Pick<Answer, "served_from" | "run_id"> & { cached_at?: string | null }): Answer {
  return {
    question: "q",
    claims: [],
    citations: [],
    evidence: [],
    ...partial,
  };
}

describe("servingLabel", () => {
  it("labels a live answer with no cached_at as live", () => {
    const label = servingLabel(answer({ served_from: "live", run_id: "run_1", cached_at: null }));
    expect(label.kind).toBe("live");
    expect(label.text).toBe("live");
  });

  it("never labels cache or replay as live", () => {
    const cached = servingLabel(
      answer({ served_from: "cache", run_id: "run_2", cached_at: "2026-10-24T14:32:00Z" }),
    );
    const replay = servingLabel(
      answer({ served_from: "replay", run_id: "run_3", cached_at: "2026-10-24T14:32:00Z" }),
    );
    expect(cached.kind).toBe("cached");
    expect(cached.text).toBe("cached at 14:32");
    expect(cached.text).not.toMatch(/live/);
    expect(servingQualifier(cached)).toBe("cache");
    expect(replay.kind).toBe("cached");
    expect(replay.text).toBe("cached at 14:32");
    expect(replay.text).not.toMatch(/live/);
    expect(servingQualifier(replay)).toBe("replay");
  });

  it("leaves a broken combination unlabelled and does not call it live", () => {
    const liveWithCache = servingLabel(
      answer({ served_from: "live", run_id: "run_4", cached_at: "2026-10-24T14:32:00Z" }),
    );
    const cacheWithoutTime = servingLabel(answer({ served_from: "cache", run_id: "run_5" }));
    expect(liveWithCache.kind).toBe("unlabelled");
    expect(liveWithCache.text).toBe("unlabelled · cached_at is set");
    expect(liveWithCache.text).not.toMatch(/live/);
    expect(servingQualifier(liveWithCache)).toBe("unlabelled");
    expect(cacheWithoutTime.kind).toBe("unlabelled");
    expect(cacheWithoutTime.text).toBe("cache · cached time missing");
    expect(cacheWithoutTime.text).not.toMatch(/live/);
  });
});

describe("formatUtcHm", () => {
  it("formats a Z stamp and a zone-less stamp as the same UTC time", () => {
    expect(formatUtcHm("2024-10-29T12:00:00Z")).toBe("12:00");
    expect(formatUtcHm("2024-10-29T12:00:00")).toBe("12:00");
    expect(formatUtcHm("2024-10-29 12:00:00")).toBe("12:00");
    expect(formatHour("2024-10-29T12:00:00")).toBe("12:00 UTC");
    expect(parseUtc("2024-10-29T12:00:00")?.toISOString()).toBe("2024-10-29T12:00:00.000Z");
    expect(parseUtc("2024-10-29 12:00:00")?.toISOString()).toBe("2024-10-29T12:00:00.000Z");
  });
});
