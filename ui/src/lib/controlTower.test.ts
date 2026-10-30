import { describe, expect, it } from "vitest";
import example from "../../../contracts/examples/watch_event.json";
import {
  AGENTS,
  announcement,
  appMode,
  asWatchEvent,
  asWatchStatus,
  askQuestionFor,
  canOpenApprovals,
  capsText,
  collapseRepeats,
  elapsedText,
  eventNumber,
  eventTime,
  evidenceForEvent,
  filterEvents,
  hasSource,
  kpiLine,
  loopState,
  mergeEvents,
  placeOptions,
  repeatNote,
  tiles,
  unreachableText,
  DEMO_LIVE_DOWN_HINT,
  type WatchEvent,
  type WatchStatus,
} from "./controlTower";

function ev(n: number, over: Partial<WatchEvent> = {}): WatchEvent {
  return {
    ...(example as unknown as WatchEvent),
    id: `w${String(n).padStart(8, "0")}`,
    ts: "2026-10-27T14:52:00Z",
    ...over,
  };
}

function status(over: Partial<WatchStatus> = {}): WatchStatus {
  return {
    note: "n",
    loop: { enabled: true, alive: true, interval_s: 300, next_cycle_at: null },
    scanning: false,
    started_at: "2026-10-27T14:50:00Z",
    last_cycle: { finished_at: "2026-10-27T14:52:10Z" },
    counts: { sources: 45, elevated: 5, events: 12, awaiting_approval: 1 },
    latest_event_id: "w00000012",
    awaiting_run_ids: ["r1"],
    auto_assess: { enabled: false, per_hour: 1, per_day: 3, used_hour: 0, used_day: 0, next_allowed_at: null, uses_model_calls: true },
    persisted: true,
    served_from: "live",
    cached_at: null,
    ...over,
  };
}

describe("asWatchEvent", () => {
  it("accepts the contract example", () => {
    const e = asWatchEvent(example);
    expect(e?.id).toBe("w00000042");
    expect(e?.agent).toBe("Watch");
    expect(e?.source.view).toBe("eu_watch");
  });
  it("drops what is not a feed event instead of guessing", () => {
    expect(asWatchEvent(null)).toBeNull();
    expect(asWatchEvent({ ...example, id: "42" })).toBeNull();
    expect(asWatchEvent({ ...example, kind: "alarm" })).toBeNull();
    expect(asWatchEvent({ ...example, agent: "Model" })).toBeNull();
    expect(asWatchEvent({ ...example, tone: "red" })).toBeNull();
    expect(asWatchEvent({ ...example, source: null })).toBeNull();
    expect(asWatchEvent({ ...example, text: undefined })).toBeNull();
  });
  it("defaults the optional fields", () => {
    const e = asWatchEvent({ ...example, run_id: undefined, place_id: undefined, data: undefined });
    expect(e?.run_id).toBeNull();
    expect(e?.place_id).toBeNull();
    expect(e?.data).toEqual({});
  });
});

describe("feed helpers", () => {
  it("numbers an event by its sequence", () => {
    expect(eventNumber("w00000012")).toBe(12);
    expect(eventNumber("nonsense")).toBe(0);
  });
  it("merges by id, keeps order and caps at the newest", () => {
    const a = [ev(1), ev(2)];
    const merged = mergeEvents(a, [ev(2, { text: "changed" }), ev(3)]);
    expect(merged.map((e) => e.id)).toEqual(["w00000001", "w00000002", "w00000003"]);
    expect(merged[1].text).toBe("changed");
    const many = Array.from({ length: 12 }, (_, i) => ev(i + 1));
    expect(mergeEvents([], many, 5).map((e) => eventNumber(e.id))).toEqual([8, 9, 10, 11, 12]);
    expect(mergeEvents([ev(3)], [ev(1)]).map((e) => eventNumber(e.id))).toEqual([1, 3]);
  });
  it("collapses identical consecutive failures into the newest row with a count", () => {
    const down = (n: number, repeats: number) =>
      ev(n, { kind: "info", text: "The river model feed could not be read this scan; sources keep their last status.", data: { dedupe_key: "down:eu_watch:w1", repeats, since: "14:05" } });
    const shown = collapseRepeats([ev(1), down(2, 1), ev(3), down(4, 2), down(5, 3)]);
    expect(shown.map((e) => eventNumber(e.id))).toEqual([1, 3, 5]);
    expect(repeatNote(shown[2])).toBe("×3 since 14:05");
    expect(repeatNote(down(9, 1))).toBeNull();
    expect(repeatNote(ev(9))).toBeNull();
  });
  it("keeps a technical detail apart from the plain text", () => {
    const e = asWatchEvent({ ...example, detail: "Zetaris HTTP 400: 429", kind: "info" });
    expect(e?.detail).toBe("Zetaris HTTP 400: 429");
    expect(asWatchEvent(example)?.detail).toBeNull();
  });
  it("filters by agent and place, newest first", () => {
    const events = [
      ev(1, { agent: "Watch", place_id: "model:EU03" }),
      ev(2, { agent: "Forecast", place_id: "model:EU03" }),
      ev(3, { agent: "Watch", place_id: "gauge:KÖLN" }),
      ev(4, { agent: "Watch", place_id: null, place: "" }),
    ];
    expect(filterEvents(events, { agent: "all", place: "all" }).map((e) => eventNumber(e.id))).toEqual([4, 3, 2, 1]);
    expect(filterEvents(events, { agent: "Watch", place: "all" }).map((e) => eventNumber(e.id))).toEqual([4, 3, 1]);
    expect(filterEvents(events, { agent: "all", place: "model:EU03" }).map((e) => eventNumber(e.id))).toEqual([2, 1]);
    expect(filterEvents(events, { agent: "Judge", place: "all" })).toEqual([]);
  });
  it("lists the places in the feed once, by name", () => {
    const events = [
      ev(1, { place_id: "model:EU03", place: "Orleans", river: "Loire" }),
      ev(2, { place_id: "model:EU03", place: "Orleans", river: "Loire" }),
      ev(3, { place_id: "valencia:VAL01", place: "Paiporta", river: "" }),
      ev(4, { place_id: null, place: "" }),
    ];
    expect(placeOptions(events)).toEqual([
      { id: "model:EU03", label: "Loire · Orleans" },
      { id: "valencia:VAL01", label: "Paiporta" },
    ]);
  });
  it("knows the six agents", () => {
    expect(AGENTS).toEqual(["Watch", "Forecast", "Exposure", "Playbook", "Judge", "Human"]);
  });
  it("words the time, plainly", () => {
    expect(eventTime("2026-10-27T14:52:07Z")).toBe("14:52 UTC");
    expect(eventTime("garbage")).toBe("garbage");
    expect(elapsedText("2026-10-27T14:50:00Z", Date.parse("2026-10-27T14:50:07Z"))).toBe("00:07");
    expect(elapsedText("2026-10-27T14:50:00Z", Date.parse("2026-10-27T14:52:05Z"))).toBe("02:05");
    expect(elapsedText(null, Date.now())).toBe("00:00");
  });
});

describe("tiles and the KPI line", () => {
  it("reads the scan's own numbers", () => {
    const t = tiles(status(), { watched: 1, elevated: 1 });
    expect(t).toEqual({ watched: 45, elevated: 5, lastScan: "14:52", awaiting: 1, autoAssess: "OFF" });
    expect(kpiLine(t)).toBe("45 sources watched · 5 elevated · last scan 14:52 · 1 run awaiting approval · auto-assess OFF");
  });
  it("falls back to the live views before the first scan, and says no scan yet", () => {
    const t = tiles(status({ last_cycle: null, counts: { sources: 0, elevated: 0, events: 0, awaiting_approval: 0 } }), { watched: 45, elevated: 5 });
    expect(t.watched).toBe(45);
    expect(t.elevated).toBe(5);
    expect(kpiLine(t)).toContain("no scan yet");
    expect(kpiLine(t)).toContain("0 runs awaiting approval");
  });
  it("shows auto-assess ON, and unreachable as zeros that say no scan", () => {
    expect(tiles(status({ auto_assess: { ...status().auto_assess, enabled: true } }), { watched: 0, elevated: 0 }).autoAssess).toBe("ON");
    expect(kpiLine(tiles(null, { watched: 0, elevated: 0 }))).toContain("no scan yet");
  });
  it("states the caps from the service's numbers", () => {
    expect(capsText(status().auto_assess)).toContain("At most 1 per hour and 3 per day");
    expect(capsText(status().auto_assess)).toContain("never approves anything");
    expect(capsText({ ...status().auto_assess, used_hour: 1, used_day: 2, next_allowed_at: "2026-10-27T15:30:00Z" })).toContain("Next allowed after 15:30 UTC");
    expect(capsText(null)).toContain("At most 1 per hour");
    expect(capsText({ ...status().auto_assess, blocked: "Nothing is saved between restarts here." })).toContain("cannot be switched on here: Nothing is saved");
    expect(asWatchStatus({ ...status(), persisted: false, persisted_reason: "why" })?.persisted_reason).toBe("why");
  });
});

describe("states", () => {
  it("tells down, loading, off, first scan and running apart", () => {
    expect(loopState({ reachable: false, status: null })).toBe("down");
    expect(loopState({ reachable: null, status: null })).toBe("loading");
    expect(loopState({ reachable: true, status: status({ last_cycle: null }) })).toBe("first");
    expect(loopState({ reachable: true, status: status({ last_cycle: null, loop: { enabled: false, alive: false, interval_s: 300, next_cycle_at: null } }) })).toBe("off");
    expect(loopState({ reachable: true, status: status() })).toBe("running");
  });
  it("demo mode renders the recorded feed, never the unreachable state", () => {
    expect(loopState({ reachable: false, status: status(), demo: true })).toBe("running");
    expect(loopState({ reachable: false, status: null, demo: true })).toBe("loading");
    expect(loopState({ reachable: false, status: status(), demo: false })).toBe("down");
    expect(DEMO_LIVE_DOWN_HINT).not.toContain("cannot be read");
  });
  it("offers demo data only in demo mode", () => {
    expect(appMode("?mode=demo", "")).toBe("demo");
    expect(appMode("", "#/insurer/tower?mode=demo")).toBe("demo");
    expect(appMode("?mode=live", "")).toBe("live");
    expect(appMode("", "")).toBe("live");
    expect(unreachableText("demo")).toContain("recorded demo data");
    expect(unreachableText("live")).not.toContain("demo");
    expect(unreachableText("live")).toContain("not reachable");
  });
  it("parses a status and rejects a body that is not one", () => {
    expect(asWatchStatus(status())?.counts.sources).toBe(45);
    expect(asWatchStatus({})).toBeNull();
    expect(asWatchStatus(null)).toBeNull();
  });
});

describe("announcements are rare", () => {
  it("speaks for notable events, at most once per gap", () => {
    const fresh = [ev(1, { kind: "checked" }), ev(2, { kind: "detected", text: "Loire at Orleans: Elevated (model)." }), ev(3, { kind: "detected", text: "Po" })];
    expect(announcement(fresh, 0, 100_000)).toBe("Watch: Po and 1 more");
    expect(announcement(fresh, 90_000, 100_000)).toBeNull();
    expect(announcement([ev(4, { kind: "checked" }), ev(5, { kind: "info" })], 0, 100_000)).toBeNull();
    expect(announcement([ev(6, { kind: "awaiting_approval", agent: "Judge", text: "Waiting." })], 0, 100_000)).toBe("Judge: Waiting.");
  });
});

describe("row actions and sources", () => {
  it("opens Approvals only for a run that is still waiting", () => {
    const e = ev(1, { kind: "awaiting_approval", run_id: "r1" });
    expect(canOpenApprovals(e, ["r1"])).toBe(true);
    expect(canOpenApprovals(e, [])).toBe(false);
    expect(canOpenApprovals(ev(2, { kind: "drafted", run_id: "r1" }), ["r1"])).toBe(false);
    expect(canOpenApprovals(ev(3, { kind: "awaiting_approval", run_id: null }), ["r1"])).toBe(false);
  });
  it("prefills Ask with a plain question, no number", () => {
    expect(askQuestionFor({ place: "Orleans", river: "Loire" })).toBe("Is the Loire at Orleans at risk right now, and what should we do?");
    expect(askQuestionFor({ place: "Paiporta", river: "" })).toBe("Is Paiporta at risk right now, and what should we do?");
  });
  it("gives a source badge to data events only, and the drawer the recorded query id", () => {
    expect(hasSource(ev(1))).toBe(true);
    expect(hasSource(ev(2, { source: { view: "runs", query_id: null } }))).toBe(false);
    expect(hasSource(ev(3, { source: { view: "watch", query_id: null } }))).toBe(false);
    const d = evidenceForEvent(ev(4));
    expect(d.queryId).toBe("5f0c2d3e-8a4b-4c1d-9e7f-0a1b2c3d4e5f");
    expect(d.view).toBe("floodsense.eu_watch");
    expect(d.timeLabel).toBe("Modelled");
    expect(d.notes.join(" ")).toContain("Not an official warning");
    const g = evidenceForEvent(ev(5, { source: { view: "gauge_levels", query_id: "q" } }));
    expect(g.timeLabel).toBe("Measured");
    expect(g.notes.join(" ")).toContain("not a warning level");
    for (const view of ["hazard_now", "weather_forecast", "exposure_join"]) {
      expect(evidenceForEvent(ev(6, { source: { view, query_id: "q" } })).view).toBe(`floodsense.${view}`);
    }
  });
});
