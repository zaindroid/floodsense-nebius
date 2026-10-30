import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptRunBody } from "../api/replay";
import { buildRunRequest } from "../api/ask";
import sample from "../fixtures/run_f16733274f1c.json";
import ahr from "../fixtures/ahr_2021.json";
import { ahrFixture, loadAhrRows, replayBadge, replayViewUrl, usableEventRows } from "./replaySource";
import { chartDescription } from "../components/DisasterReplay";
import { causalChainNote } from "../components/CausalChainHeader";
import { buildPipeline, formatLatency, parseBoard, PIPELINE_ORDER } from "./pipeline";
import { buildRetrieval, cleanQuote } from "./retrieval";
import { mergeContext, withAskContext } from "./askContext";
import {
  buildFrames,
  clampStep,
  crossings,
  dayStarts,
  momentQuestion,
  momentQuestionAt,
  crossingText,
  isDailyDischarge,
  isTurnFrame,
  nextStep,
  readingsAt,
  REPLAY_EVENTS,
  replayLabel,
  type ReplayReading,
} from "./disasterReplay";

const run = adoptRunBody(sample as unknown as Record<string, unknown>, "f16733274f1c")!;

describe("buildPipeline", () => {
  it("keeps the canonical node order and folds world_model into badges", () => {
    const model = buildPipeline(run);
    // A run recorded before the router has no router, quick- or forecast-lane steps, so they are not drawn.
    const routerSteps = ["router", "live_watch", "quick_answer", "forecast_data", "history", "forecast_answer"];
    expect(model.nodes.map((n) => n.id)).toEqual(PIPELINE_ORDER.filter((id) => !routerSteps.includes(id)));
    expect(model.nodes.some((n) => (n.id as string) === "world_model")).toBe(false);
  });

  it("shows the revise and repair loops from the run", () => {
    const model = buildPipeline(run);
    expect(model.reviseRounds).toBe(1);
    expect(model.repairRounds).toBe(1);
    const skeptic = model.nodes.find((n) => n.id === "skeptic")!;
    expect(skeptic.runs).toBe(2); // the revise edge step is not a run
    expect(skeptic.latencyMs).toBe(126328 + 181928);
    expect(model.nodes.find((n) => n.id === "judge")!.status).toBe("flag");
    expect(model.nodes.find((n) => n.id === "approval")!.status).toBe("waiting");
  });

  it("puts sponsor badges where they apply", () => {
    const model = buildPipeline(run);
    const badges = (id: string) => model.nodes.find((n) => n.id === id)!.badges.map((b) => b.text);
    expect(badges("watchers")).toEqual(["Zetaris · 3 queryIds"]);
    expect(badges("memory")).toEqual(["H-MEM recall · 3"]);
    // Shared provider rule: a Nemotron id is Nightshift.
    expect(badges("skeptic")).toContain("Nightshift · answered by Nemotron 3.5 Lightning 30B A3B");
    expect(badges("skeptic").some((t) => t.startsWith("World Model · H1 not_supported"))).toBe(true);
    expect(badges("investigator")).toContain("pgvector + Zetaris JDBC");
    expect(badges("scope")).toEqual([]);
    expect(model.board?.states).toEqual([
      { id: "H1", state: "not_supported" },
      { id: "H2", state: "supported" },
      { id: "H3", state: "supported" },
    ]);
  });

  it("follows the shared provider rule: a Nemotron id is Nightshift", () => {
    const body = (extra: Record<string, unknown>, step: Record<string, unknown> = {}) =>
      adoptRunBody(
        {
          served_from: "live",
          summary: "s",
          claims: [],
          trace: [{ seq: 1, node: "skeptic", lane: "sql", model_id: "nvidia/nemotron-3.5-lightning-30b-a3b", latency_ms: 5, ...step }],
          ...extra,
        },
        "x",
      )!;
    const text = (r: ReturnType<typeof body>) => buildPipeline(r).nodes.find((n) => n.id === "skeptic")!.badges[0].text;
    expect(text(body({}))).toMatch(/^Nightshift · /);
    // An explicit provider in the run or trace wins over the id rule.
    expect(text(body({ request: { llm_provider: "openrouter" } }))).toMatch(/^openrouter · /);
    expect(text(body({ request: { llm_provider: "nightshift" } }))).toMatch(/^Nightshift · /);
    expect(text(body({}, { provider: "nightshift" }))).toMatch(/^Nightshift · /);
  });

  it("shows H-MEM only when memory recalled something", () => {
    const mem = (summary: string) =>
      buildPipeline(
        adoptRunBody({ served_from: "live", summary: "s", claims: [], trace: [{ seq: 1, node: "memory", summary }] }, "x")!,
      ).nodes.find((n) => n.id === "memory")!.badges;
    expect(mem("recalled 0 past approved finding(s) for the Investigator")).toEqual([]);
    expect(mem("memory store unavailable")).toEqual([]);
    expect(mem("recalled 2 past approved finding(s)")).toEqual([{ kind: "hmem", text: "H-MEM recall · 2" }]);
  });

  it("shows an unknown model id as is and survives a bare body", () => {
    const bare = adoptRunBody(
      {
        served_from: "live",
        summary: "s",
        claims: [],
        trace: [{ seq: 1, node: "investigator", lane: "fast", model_id: "acme/model-x", latency_ms: 900 }],
      },
      "x",
    )!;
    const model = buildPipeline(bare);
    expect(model.reviseRounds).toBe(0);
    expect(model.nodes.find((n) => n.id === "investigator")!.badges).toEqual([{ kind: "model", text: "acme/model-x" }]);
    expect(model.nodes.find((n) => n.id === "watchers")!.status).toBe("skipped");
  });

  it("parses boards and latencies", () => {
    expect(parseBoard("board after investigator: H1 proposed, H2 supported")?.states).toHaveLength(2);
    expect(parseBoard("0 anomalies observed")).toBeNull();
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(980)).toBe("980 ms");
    expect(formatLatency(149338)).toBe("2 min 29 s");
  });
});

describe("buildRetrieval", () => {
  it("groups layer (c) passages per claim with the Judge verdict and the flag", () => {
    const model = buildRetrieval(run);
    expect(model.groups.map((g) => g.claimId)).toEqual(["C-doc"]);
    const g = model.groups[0];
    expect(g.passages.length).toBe(model.passageCount);
    expect(g.flagged).toBe(true);
    expect(g.verdict?.grounding).toBe("unsupported");
    expect(model.query).toBe("Barranc del Poyo flash flood Paiporta Horta Sud delineation");
    expect(g.passages[0].page).toBe(3);
  });

  it("drops map-symbol noise and trims long quotes", () => {
    expect(cleanQuote("!\n!\n!!\n! !")).toBeNull();
    expect(cleanQuote("a ".repeat(400), 20)?.length).toBeLessThanOrEqual(20);
    expect(cleanQuote(null)).toBeNull();
  });
});

describe("ask context", () => {
  it("adds a clean context only when enabled", () => {
    expect(withAskContext({ q: 1 }, { page: "replay", place: " " }, true)).toEqual({ q: 1, context: { page: "replay" } });
    expect(withAskContext({ q: 1 }, { page: "replay" }, false)).toEqual({ q: 1 });
    expect(withAskContext({ q: 1 }, null, true)).toEqual({ q: 1 });
    expect(mergeContext({ role: "insurer", page: "sites" }, { page: "replay", event_id: "EMSR517" })).toEqual({
      role: "insurer",
      page: "replay",
      event_id: "EMSR517",
    });
  });

  it("rides on the run request", () => {
    const body = buildRunRequest({
      question: "q",
      context: { page: "replay", event_id: "EMSR517", replay_date: "2021-07-14T18:00:00Z" },
    });
    expect(body.context).toEqual({ page: "replay", event_id: "EMSR517", replay_date: "2021-07-14T18:00:00Z" });
  });
});

describe("disaster replay timeline", () => {
  const ahrEvent = REPLAY_EVENTS[0];
  const rows = ahr.hazard_timeline as ReplayReading[];

  it("steps hourly through the Ahr window, one day stop each", () => {
    const frames = buildFrames(rows, ahrEvent);
    expect(frames.length).toBe(96);
    expect(frames[0]).toBe("2021-07-13T00:00:00Z");
    expect(dayStarts(frames).map((d) => d.index)).toEqual([0, 24, 48, 72]);
    expect(clampStep(-3, 96)).toBe(0);
    expect(clampStep(200, 96)).toBe(95);
    expect(nextStep(95, 96)).toBe(0);
    expect(readingsAt(rows, frames[30]).size).toBe(4);
  });

  it("marks the moment discharge crosses the line", () => {
    const frames = buildFrames(rows, ahrEvent);
    const c = crossings(rows, frames, ahrEvent.thresholdM3s).get("AHR01");
    expect(c?.iso).toBe("2021-07-14T00:00:00Z");
    // Discharge is daily: the crossing is dated by day, never by an hour.
    expect(isDailyDischarge(rows)).toBe(true);
    expect(crossingText(c!.iso, true)).toBe("Crossed the line on 14 Jul 2021 (daily value)");
    expect(isTurnFrame("2021-07-14T18:00:00Z", c!.iso, true)).toBe(true);
    expect(isTurnFrame("2021-07-14T18:00:00Z", c!.iso, false)).toBe(false);
    expect(momentQuestionAt("Altenahr", "2021-07-14T18:00:00Z", true)).toBe("Why was Altenahr at risk on 14 Jul 2021?");
    expect(c && c.discharge).toBeGreaterThanOrEqual(100);
  });

  it("reads zone-less view stamps and labels the replay", () => {
    const view: ReplayReading[] = [
      { point_id: "V", ts_utc: "2024-10-29 00:00:00.0", rain_mm: 0, discharge_m3s: 30 },
      { point_id: "V", ts_utc: "2024-10-30 00:00:00.0", rain_mm: 9, discharge_m3s: 400 },
      { point_id: "V", ts_utc: "2024-11-02 00:00:00.0", rain_mm: 0, discharge_m3s: 50 },
    ];
    const frames = buildFrames(view, REPLAY_EVENTS[1]);
    expect(frames).toEqual(["2024-10-29T00:00:00Z", "2024-10-30T00:00:00Z"]);
    expect(crossings(view, frames, 100).get("V")?.index).toBe(1);
    expect(replayLabel(REPLAY_EVENTS[1])).toBe("Replay of Valencia DANA, 28–31 Oct 2024 · not live");
    expect(momentQuestion("Altenahr", "2021-07-14T18:00:00Z")).toBe("Why was Altenahr at risk on 14 Jul 2021 at 18:00 UTC?");
  });
});

describe("replay sources and labels", () => {
  it("uses API rows only when they hold AHR points in the window", () => {
    const ev = REPLAY_EVENTS[0];
    expect(usableEventRows([{ point_id: "VAL01", ts_utc: "2024-10-29T00:00:00Z", rain_mm: 0, discharge_m3s: 1 }], ev, "AHR")).toBeNull();
    expect(usableEventRows({ detail: "x" }, ev, "AHR")).toBeNull();
    expect(
      usableEventRows([{ point_id: "AHR04", ts_utc: "2021-07-14 12:00:00.0", rain_mm: 3, discharge_m3s: 200 }], ev, "AHR"),
    ).toHaveLength(1);
    expect(ahrFixture().badge).toBe("Bundled modelled data (Open-Meteo, CC BY 4.0), not from Zetaris");
  });

  it("reads the Ahr replay from floodsense_seed and badges it", async () => {
    expect(replayViewUrl("http://api", "hazard_timeline", "EMSR517")).toBe(
      "http://api/views/hazard_timeline?event_id=EMSR517&source=replay",
    );
    expect(replayBadge("floodsense_seed")).toBe("Replay · Zetaris floodsense_seed · not live");
    const rows = [{ point_id: "AHR01", ts_utc: "2021-07-14T12:00:00Z", rain_mm: 5.5, discharge_m3s: 249.61 }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rows), { headers: { "x-schema": "floodsense_seed", "x-query-id": "q-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const got = await loadAhrRows(REPLAY_EVENTS[0]);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("source=replay");
    expect(got.fromZetaris).toBe(true);
    expect(got.badge).toBe("Replay · Zetaris floodsense_seed · not live");
    expect(got.rows).toHaveLength(1);
  });

  it("falls back to the fixture when the replay read holds no AHR rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
    const got = await loadAhrRows(REPLAY_EVENTS[0]);
    expect(got.fromZetaris).toBe(false);
    expect(got.badge).toBe(ahrFixture().badge);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("describes the chart and the causal chain source", () => {
    const rows = ahr.hazard_timeline.filter((r) => r.point_id === "AHR01") as ReplayReading[];
    const d = chartDescription("Altenahr", rows, 100, "2021-07-14T00:00:00Z", true);
    expect(d).toContain("Peak discharge 249.6 m³/s on 14 Jul 2021");
    expect(d).toContain("Crossed the line on 14 Jul 2021 (daily value)");
    expect(causalChainNote({ kind: "bundled" })).toMatch(/Bundled recording/);
    expect(causalChainNote({ kind: "failed", id: "abc" })).toMatch(/Could not load recorded run abc/);
    expect(causalChainNote({ kind: "configured", id: "abc" })).toBeNull();
  });
});
