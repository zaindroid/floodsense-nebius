import { describe, expect, it } from "vitest";
import { fixtureDischargeNotice, replayNotice, seedRowsNotice } from "./notices";
import { loadFixtures } from "../fixtures/load";
import type { DischargeDailyRow } from "../types/views";

const row: DischargeDailyRow = {
  point_id: "VAL01",
  date: "2024-10-29",
  discharge_m3s: 31.06,
  source: "seed:open-meteo-flood-glofas",
};

describe("replayNotice", () => {
  it("names the serving time and points at the chip, never calling a replay live", () => {
    const { answer } = loadFixtures();
    const notice = replayNotice(answer);
    expect(notice.body).toContain(`a ${answer.served_from}, cached at 14:32 UTC.`);
    expect(notice.body).toContain("top-bar chip");
    expect(notice.body).not.toMatch(/\blive\b/i);
  });
});

describe("discharge notices", () => {
  it("gives the fixture notice its own id", () => {
    const notice = fixtureDischargeNotice([row]);
    expect(notice.id).toBe("fixture-loaded");
    expect(notice.title).toMatch(/fixture/i);
    expect(notice.body).not.toMatch(/\bseed rows\b/i);
  });

  it("keeps the seed notice for a seed origin", () => {
    const notice = seedRowsNotice([row]);
    expect(notice.id).toBe("seed-loaded");
    expect(notice.body).toMatch(/These rows are seed/);
  });
});
