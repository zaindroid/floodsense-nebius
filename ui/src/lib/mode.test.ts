import { describe, expect, it } from "vitest";
import { demoFetch, isDemo, setDemoFlag } from "./demo";
import { fetchGaugeLevels } from "../api/gauges";
import { fetchEuWatch } from "../api/euWatch";
import { fetchHazardNow } from "../api/now";
import { isDemoIsolated, contextForMode, modeSearch, modeStripText, modeUrl, parseModeSearch } from "./mode";
import { replayStatus } from "./places";
import { valenciaCuts } from "./euWatch";
import { CITIZEN_PURPOSE, INSURER_PURPOSE, OPERATOR_PURPOSE } from "./pagePurpose";
import { CITIZEN_PAGES, DESK_NAV, INSURER_PAGES, OPERATOR_PAGES } from "./route";

describe("mode state and URL persistence", () => {
  it("defaults to Live, Ahr 2021, no demo", () => {
    expect(parseModeSearch("")).toEqual({ mode: "live", eventId: "EMSR517", demo: false });
    expect(modeSearch({ mode: "live", eventId: "EMSR517", demo: false })).toBe("");
  });

  it("round-trips Past flood with its event and demo", () => {
    for (const eventId of ["EMSR517", "EMSR773"] as const) {
      const state = { mode: "past" as const, eventId, demo: true };
      expect(parseModeSearch(modeSearch(state))).toEqual(state);
    }
    expect(modeSearch({ mode: "past", eventId: "EMSR773", demo: false })).toBe("?mode=past&event=EMSR773");
  });

  it("ignores unknown values", () => {
    expect(parseModeSearch("?mode=bogus&event=EMSR000&demo=yes")).toEqual({ mode: "live", eventId: "EMSR517", demo: false });
  });

  it("keeps the hash route and other parameters when writing", () => {
    const loc = { pathname: "/", search: "?x=1", hash: "#/insurer/sites" };
    expect(modeUrl(loc, { mode: "past", eventId: "EMSR773", demo: false })).toBe("/?x=1&mode=past&event=EMSR773#/insurer/sites");
    expect(modeUrl({ ...loc, search: "?x=1&mode=past&event=EMSR773" }, { mode: "live", eventId: "EMSR773", demo: false })).toBe("/?x=1#/insurer/sites");
  });

  it("states the mode in the context strip", () => {
    const at = Date.UTC(2026, 9, 27, 12, 50);
    expect(modeStripText({ mode: "live", eventId: "EMSR517", demo: false }, at)).toBe("Live data · checked 12:50 UTC");
    expect(modeStripText({ mode: "live", eventId: "EMSR517", demo: false }, null)).toMatch(/^Live data/);
    expect(modeStripText({ mode: "past", eventId: "EMSR517", demo: false }, at)).toBe("Past flood: Ahr 2021 (replay)");
    expect(modeStripText({ mode: "past", eventId: "EMSR773", demo: false }, at)).toBe("Past flood: Valencia 2024 (replay)");
    expect(modeStripText({ mode: "live", eventId: "EMSR517", demo: true }, at)).toMatch(/^Demo data/);
  });

  it("Live strips event fields from a page's own context", () => {
    const ctx = { role: "citizen", page: "now", event_id: "EMSR517", replay_date: "2021-07-14", place: "Köln" };
    expect(contextForMode(ctx, "live")).toEqual({ role: "citizen", page: "now", place: "Köln" });
    expect(contextForMode(ctx, "past")).toEqual(ctx);
  });
});

describe("demo data swaps the live fetchers", () => {
  it("is off by default and reads the bundled snapshot when on", async () => {
    expect(isDemo()).toBe(false);
    const failing = (async () => new Response("down", { status: 503 })) as typeof fetch;
    expect((await fetchGaugeLevels(undefined, failing)).state).toBe("unavailable");
    setDemoFlag(true);
    try {
      const g = await fetchGaugeLevels(undefined, failing);
      expect(g.state).toBe("rows");
      expect(g.rows).toHaveLength(26);
      expect(g.queryId).toBe("demo-snapshot");
      const e = await fetchEuWatch(undefined, failing);
      expect(e.state).toBe("rows");
      expect(e.rows).toHaveLength(11);
      const h = await fetchHazardNow(new AbortController().signal);
      expect(new Set(h.rows.map((r) => r.point_id)).size).toBe(8);
      expect((await demoFetch("/api/views/other")).status).toBe(404);
    } finally {
      setDemoFlag(false);
    }
    expect(isDemo()).toBe(false);
  });
});

describe("page purpose table", () => {
  it("has a complete row for every page of both desks", () => {
    for (const page of CITIZEN_PAGES) for (const f of Object.values(CITIZEN_PURPOSE[page])) expect(f.length).toBeGreaterThan(3);
    for (const page of INSURER_PAGES) for (const f of Object.values(INSURER_PURPOSE[page])) expect(f.length).toBeGreaterThan(3);
    expect(Object.keys(CITIZEN_PURPOSE).sort()).toEqual([...CITIZEN_PAGES].sort());
    expect(Object.keys(INSURER_PURPOSE).sort()).toEqual([...INSURER_PAGES].sort());
    expect(Object.keys(OPERATOR_PURPOSE).sort()).toEqual([...OPERATOR_PAGES].sort());
  });

  it("is the table in ui/README.md, row for row", () => {
    const readme = Object.values(import.meta.glob("../../README.md", { query: "?raw", import: "default", eager: true }))[0] as string;
    for (const [desk, table, nav] of [
      ["Citizen", CITIZEN_PURPOSE, DESK_NAV.citizen],
      ["Insurer", INSURER_PURPOSE, DESK_NAV.insurer],
      ["Operator", OPERATOR_PURPOSE, DESK_NAV.operator],
    ] as const) {
      for (const item of nav) {
        const row = (table as Record<string, { purpose: string; data: string; live: string; past: string }>)[item.page];
        const line = `| ${desk} | ${item.label} | ${row.purpose} | ${row.data} | ${row.live} | ${row.past} |`;
        expect(readme, line).toContain(line);
      }
    }
  });
});

describe("replay status", () => {
  it("uses the event's own line, never Valencia's 20/80 demo lines, and is never red", () => {
    expect(replayStatus(249.6, 100).word).toBe("Above the 100 m³/s FloodSense alert line (daily value)");
    expect(replayStatus(50, 100).word).toBe("Below the 100 m³/s FloodSense alert line (daily value)");
    expect(replayStatus(null, 100).word).toBe("No reading");
    expect(replayStatus(249.6, 100).tone).not.toBe("warning");
    expect(replayStatus(30, 100).word).not.toMatch(/20|80/);
  });
});

describe("Valencia cuts follow the point's own flow", () => {
  it("does not raise a point whose base flow is ~30 m³/s", () => {
    const past = [29, 30, 31, 30.5, 30].map((q) => ({ discharge_m3s: q }));
    const cuts = valenciaCuts(past);
    expect(cuts.watch).toBeCloseTo(60);
    expect(cuts.warning).toBeCloseTo(120);
    expect(30.1).toBeLessThan(cuts.watch);
  });
  it("floors a near-dry point at 5 m³/s so noise is not an alert", () => {
    expect(valenciaCuts([{ discharge_m3s: 0.05 }, { discharge_m3s: null }])).toEqual({ watch: 10, warning: 20 });
    expect(valenciaCuts([])).toEqual({ watch: 10, warning: 20 });
  });
});

describe("context strip always reaches a final state", () => {
  const live = { mode: "live" as const, eventId: "EMSR517" as const, demo: false };
  const at = Date.UTC(2026, 9, 27, 12, 50);
  it("says checking only while the views load, then a time or unavailable", () => {
    expect(modeStripText(live, null, { loaded: 0, total: 45, failed: [], loading: true }, "approvals")).toBe("Live data · checking…");
    expect(modeStripText(live, null, { loaded: 0, total: 45, failed: ["river gauges (gauge_levels)"], loading: false }, "approvals")).toBe("Live data · unavailable");
    expect(modeStripText(live, at, { loaded: 45, total: 45, failed: [], loading: false }, "system")).toBe("Live data · checked 12:50 UTC");
  });
  it("names a partial load instead of reading as calm", () => {
    const t = modeStripText(live, at, { loaded: 26, total: 45, failed: ["GloFAS points (eu_watch)"], loading: false }, "now");
    expect(t).toBe("Live data · checked 12:50 UTC · 26 of 45 sources");
  });
  it("labels pages demo mode cannot isolate, and has no demo wording in Past", () => {
    const demo = { ...live, demo: true };
    expect(modeStripText(demo, at, null, "now")).toMatch(/^Demo data/);
    for (const page of ["approvals", "review", "system", "how"]) {
      expect(isDemoIsolated(page)).toBe(false);
      expect(modeStripText(demo, at, null, page)).toBe("Live data (demo mode only affects the watch views)");
    }
    expect(modeStripText({ ...demo, mode: "past" }, at, null, "now")).toBe("Past flood: Ahr 2021 (replay)");
  });
});
