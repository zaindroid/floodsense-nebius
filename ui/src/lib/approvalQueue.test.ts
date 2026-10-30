import { describe, expect, it } from "vitest";
import { adoptPastRuns, approvalHeader, buildQueue, eventLabel, completedFullRuns, curateQueue, earlierText, isSmallTalk, pickSelection, preferJudgePass, queueRowLine, readHidden, utcStamp, writeHidden } from "./approvalQueue";

import type { RecordedRun } from "../api/replay";
import { loadNewestRun } from "../components/CausalChainHeader";
import realPast from "../fixtures/runs_past_real.json";

const PAST = {
  runs: [
    { run_id: "old", status: "awaiting_approval", question: "Old one", created_at: "2026-10-27T08:00:00Z", lane: "full", judge_overall: 0.8 },
    { run_id: "done", status: "approved", approval: "approved", created_at: "2026-10-27T11:00:00Z" },
    { run_id: "new", status: "awaiting_approval", question: "Kaub warning", created_at: "2026-10-27T10:30:00Z", lane: "full", event_id: "LIVE-EU" },
    { run_id: "busy", status: "running", question: "Still working", created_at: "2026-10-27T11:20:00Z" },
    { status: "awaiting_approval" },
  ],
};

describe("approval queue layout", () => {
  it("adopts /runs/past rows and drops malformed ones", () => {
    const rows = adoptPastRuns(PAST);
    expect(rows.map((r) => [r.runId, r.state])).toEqual([
      ["old", "awaiting"],
      ["done", "decided"],
      ["new", "awaiting"],
      ["busy", "running"],
    ]);
    expect(adoptPastRuns(null)).toEqual([]);
    expect(adoptPastRuns([{ run_id: "x", status: "running" }])).toHaveLength(1);
  });

  it("lists awaiting runs newest first, then running ones, never decided ones", () => {
    const queue = buildQueue(adoptPastRuns(PAST), null);
    expect(queue.map((r) => r.runId)).toEqual(["new", "old", "busy"]);
  });

  it("keeps the handoff run and runs started here before the past list has them", () => {
    const queue = buildQueue(adoptPastRuns(PAST), "handoff", [{ runId: "mine", question: "Assess Köln", startedAt: "2026-10-27T11:30:00Z" }]);
    expect(queue.map((r) => [r.runId, r.state])).toEqual([
      ["new", "awaiting"],
      ["old", "awaiting"],
      ["handoff", "awaiting"],
      ["mine", "running"],
      ["busy", "running"],
    ]);
    // A started run the past list already carries keeps the list's own status.
    const again = buildQueue(adoptPastRuns(PAST), null, [{ runId: "new", question: "x", startedAt: "2026-10-27T11:30:00Z" }]);
    expect(again.find((r) => r.runId === "new")?.state).toBe("awaiting");
  });

  it("selects the current pick, else the handoff, else the newest awaiting run, else nothing (the example)", () => {
    const queue = buildQueue(adoptPastRuns(PAST), "old");
    expect(pickSelection(queue, "new", "old")).toBe("new");
    expect(pickSelection(queue, null, "old")).toBe("old");
    expect(pickSelection(queue, "busy", null)).toBe("new");
    expect(pickSelection(queue, "gone", "gone")).toBe("new");
    expect(pickSelection([], null, null)).toBeNull();
  });

  it("by default prefers the newest run with outbound actions, a Judge pass and fresh data; else the newest", () => {
    const queue = buildQueue(adoptPastRuns(PAST), null);
    // "new" is the newest; make it weak (stale, no pass) so the older, good run wins.
    const q = {
      new: { outbound: 2, total: 2, passes: false, stale: true },
      old: { outbound: 1, total: 1, passes: true, stale: false },
    };
    expect(pickSelection(queue, null, null, q)).toBe("old");
    expect(pickSelection(queue, "new", null, q)).toBe("new"); // manual pick kept
    expect(pickSelection(queue, null, null, { new: { outbound: 0, total: 1, passes: true }, old: { outbound: 1, total: 1, passes: true, stale: true } })).toBe("new");
    expect(pickSelection(queue, null, null, {})).toBe("new");
  });

  it("writes the row line from the run's own state and time", () => {
    const [row] = buildQueue(adoptPastRuns(PAST), null);
    expect(queueRowLine(row)).toBe("Live · 10:30 UTC");
    expect(utcStamp("nonsense")).toBeNull();
  });
});

describe("Approvals header", () => {
  const [row] = buildQueue(adoptPastRuns(PAST), null);

  it("states the live run's own facts: id, start, lane, model, Judge", () => {
    const h = approvalHeader({
      runId: "new",
      row,
      modelIds: ["deterministic", "nvidia/nemotron-3.5-lightning-30b-a3b"],
      judgeScore: 0.91,
      judgePasses: true,
    });
    expect(h.kind).toBe("live");
    expect(h.title).toBe("Live run new");
    expect(h.facts).toEqual([
      { label: "Live run", value: "new" },
      { label: "Started", value: "27 Oct 2026, 10:30 UTC" },
      { label: "Lane", value: "Full investigation" },
      { label: "Model", value: "Nemotron 3.5 Lightning 30B" },
      { label: "Judge", value: "0.91 · passes" },
      { label: "Event", value: "Live" },
    ]);
    expect(h.note).toBeNull();
    // No serving or cache line from the console's fixture answer leaks into a live run's header.
    expect(JSON.stringify(h)).not.toMatch(/cached at|replay|not live/i);
  });

  it("says what it does not know instead of inventing it", () => {
    const h = approvalHeader({ runId: "handoff", row: null, modelIds: [], judgeScore: null, judgePasses: null });
    expect(h.facts.find((f) => f.label === "Started")?.value).toBe("not reported");
    expect(h.facts.find((f) => f.label === "Model")?.value).toMatch(/rules only/);
    expect(h.facts.find((f) => f.label === "Judge")?.value).toBe("not scored");
    expect(h.note).toMatch(/start time or lane/);
  });

  it("labels the packed example as a recording, not live", () => {
    const h = approvalHeader({ runId: null, row: null, modelIds: [], judgeScore: 0.89, judgePasses: null, exampleRunId: "run_fixture" });
    expect(h.kind).toBe("example");
    expect(h.facts[0]).toEqual({ label: "Run", value: "run_fixture (example)" });
    expect(h.note).toMatch(/not live/);
  });
});

describe("curateQueue", () => {
  const row = (runId: string, over: Record<string, unknown> = {}) => ({
    run_id: runId,
    status: "awaiting_approval",
    question: "Why was Altenahr at risk on 14 Jul 2021?",
    created_at: "2026-10-27T12:28:00Z",
    event_id: "EMSR517",
    mode: "event",
    lane: "full",
    judge_overall: 1,
    ...over,
  });
  const base = buildQueue(
    adoptPastRuns([
      row("new", { created_at: "2026-10-27T12:28:00Z" }),
      row("old1", { created_at: "2026-10-27T10:06:00Z" }),
      row("old2", { created_at: "2026-10-27T09:06:00Z" }),
      row("hello", { question: "Hello, how are you FloodSense?", lane: "reply" }),
      row("quick", { question: "How high is the Rhine?", lane: "quick" }),
      row("fc", { question: "Do the next 48 hours look safe at Köln?", lane: "forecast" }),
      row("noact", { question: "Is Bonn at risk?" }),
      row("val", { question: "Why Paiporta?", event_id: "EMSR773" }),
      row("live", { question: "Is the Elbe high?", event_id: "LIVE-EU", mode: "live" }),
    ]),
    null,
  );
  const c = (outbound: number, total = outbound) => ({ outbound, total });
  const counts = { new: c(2), old1: c(2), old2: c(1), noact: c(0), val: c(1), live: c(1) };
  const input = { mode: "past" as const, eventId: "EMSR517", hidden: new Set<string>(), showHidden: false, actionCounts: counts };

  it("keeps full-lane runs with outbound actions and folds duplicates into the newest", () => {
    const { rows } = curateQueue(base, input);
    expect(rows.map((r) => r.runId)).toEqual(["new"]);
    expect(rows[0].earlier).toBe(2);
    expect(earlierText(rows[0])).toBe("+2 earlier runs");
    expect(queueRowLine(rows[0])).toBe("Ahr 2021 · 12:28 UTC · Judge 1.00");
  });

  it("drops small talk and abandoned running runs", () => {
    expect(isSmallTalk("Hello, how are you FloodSense?")).toBe(true);
    expect(isSmallTalk("Hi, how are you?")).toBe(true);
    expect(isSmallTalk("Is Bonn at risk?")).toBe(false);
    const q = buildQueue(
      adoptPastRuns([
        row("small", { question: "Hi, how are you?" }),
        row("stale", { status: "running", created_at: "2026-10-27T08:00:00Z" }),
        row("fresh", { status: "running", question: "Is Bonn at risk?", created_at: "2026-10-27T12:25:00Z" }),
      ]),
      null,
    );
    const out = curateQueue(q, { ...input, actionCounts: { small: c(3) }, now: Date.parse("2026-10-27T12:30:00Z") });
    expect(out.rows.map((r) => r.runId)).toEqual(["fresh"]);
  });

  it("scopes to the mode: Live shows live runs, Past the chosen event", () => {
    expect(curateQueue(base, { ...input, mode: "live" }).rows.map((r) => r.runId)).toEqual(["live"]);
    expect(curateQueue(base, { ...input, eventId: "EMSR773" }).rows.map((r) => r.runId)).toEqual(["val"]);
  });

  it("lists a run with only internal actions as Internal notes, and drops one with no actions", () => {
    const only = { ...counts, noact: c(0, 3) };
    const rows = curateQueue(base, { ...input, actionCounts: only }).rows;
    const note = rows.find((r) => r.runId === "noact");
    expect(note?.internalOnly).toBe(true);
    expect(queueRowLine(note!)).toMatch(/^Internal notes · Ahr 2021/);
    expect(curateQueue(base, { ...input, actionCounts: counts }).rows.find((r) => r.runId === "noact")).toBeUndefined();
  });

  it("asks for the actions of runs it has not looked up yet", () => {
    expect(curateQueue(base, { ...input, actionCounts: {} }).pendingIds.sort()).toEqual(["new", "noact"]);
  });

  it("hides a run until Show hidden, and counts it", () => {
    const hidden = new Set(["new"]);
    const a = curateQueue(base, { ...input, hidden });
    expect(a.rows).toEqual([]);
    expect(a.hiddenCount).toBe(1);
    expect(curateQueue(base, { ...input, hidden, showHidden: true }).rows.map((r) => r.runId)).toEqual(["new"]);
  });

  it("round-trips the hidden list through storage", () => {
    const mem: Record<string, string> = {};
    const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => void (mem[k] = v) };
    writeHidden(storage, new Set(["a", "b"]));
    expect([...readHidden(storage)].sort()).toEqual(["a", "b"]);
    expect(readHidden(null).size).toBe(0);
  });
});

describe("Review run choice", () => {
  const rows = adoptPastRuns({
    runs: [
      { run_id: "a", status: "approved", lane: "full", mode: "live", question: "q1", created_at: "2026-10-27T10:00:00Z" },
      { run_id: "b", status: "awaiting_approval", lane: "full", mode: "live", question: "q2", created_at: "2026-10-27T09:00:00Z" },
      { run_id: "c", status: "awaiting_approval", lane: "quick", mode: "live", question: "q3", created_at: "2026-10-27T11:00:00Z" },
    ],
  });
  it("lists finished full-lane runs newest first", () => {
    expect(completedFullRuns(rows, "live", "LIVE-EU").map((r) => r.runId)).toEqual(["a", "b"]);
  });
  it("prefers the newest run that passed the Judge, else the newest", () => {
    const c = completedFullRuns(rows, "live", "LIVE-EU");
    expect(preferJudgePass(c, { a: false, b: true })?.runId).toBe("b");
    expect(preferJudgePass(c, { a: true, b: true })?.runId).toBe("a");
    expect(preferJudgePass(c, { a: false, b: false })?.runId).toBe("a");
    expect(preferJudgePass([], {})).toBeNull();
  });
});

describe("event label, Valencia scope, newest run", () => {
  const rows = adoptPastRuns({
    runs: [
      { run_id: "val", status: "awaiting_approval", event_id: "EMSR773", mode: "event", lane: "full", question: "Valencia sites?", created_at: "2026-10-30T00:18:24Z" },
      { run_id: "liv", status: "awaiting_approval", event_id: "EMSR773", mode: "live", lane: "full", question: "Any point at risk?", created_at: "2026-10-30T00:10:00Z" },
    ],
  });
  it("labels a live-data run Live even when it carries EMSR773", () => {
    expect(eventLabel("EMSR773", "live")).toBe("Live");
    expect(eventLabel("EMSR773", "event")).toBe("Valencia 2024");
    expect(queueRowLine(rows[1])).toContain("Live");
    expect(queueRowLine(rows[1])).not.toContain("Valencia");
    expect(approvalHeader({ runId: "liv", row: rows[1], modelIds: [], judgeScore: 1, judgePasses: true, eventId: "EMSR773" }).facts).toContainEqual({ label: "Event", value: "Live" });
  });
  it("Past Valencia keeps the EMSR773 event run, Live keeps the live one", () => {
    const base = buildQueue(rows, null, []);
    const counts = { val: { outbound: 2, total: 3 }, liv: { outbound: 1, total: 1 } };
    const past = curateQueue(base, { mode: "past", eventId: "EMSR773", hidden: new Set(), showHidden: false, actionCounts: counts });
    expect(past.rows.map((r) => r.runId)).toEqual(["val"]);
    const live = curateQueue(base, { mode: "live", eventId: "EMSR773", hidden: new Set(), showHidden: false, actionCounts: counts });
    expect(live.rows.map((r) => r.runId)).toEqual(["liv"]);
  });
  it("picks the newest completed full run for the event", () => {
    expect(completedFullRuns(rows, "past", "EMSR773").map((r) => r.runId)).toEqual(["val", "liv"]);
  });
  it("real /runs/past payload: newest by created_at, not list order, null judge ok", () => {
    const real = adoptPastRuns(realPast);
    // f1673 is listed first but is the 26 Oct recording; skip it. Live: newest of the rest, any event.
    const live = completedFullRuns(real, "live", "EMSR773", "f16733274f1c").map((r) => r.runId);
    expect(live[0]).toBe("2b613166f0f5");
    expect(live).not.toContain("f16733274f1c");
    // Shuffled input gives the same answer.
    expect(completedFullRuns([...real].reverse(), "live", "EMSR773", "f16733274f1c")[0].runId).toBe("2b613166f0f5");
    // Past Valencia prefers EMSR773 over the equally new EMSR517 run; Past Ahr prefers EMSR517.
    expect(completedFullRuns(real, "past", "EMSR773", "f16733274f1c")[0].runId).toBe("2b613166f0f5");
    expect(completedFullRuns(real, "past", "EMSR517", "f16733274f1c")[0].runId).toBe("438fbad8e8e2");
    // Answered forecast runs are never offered.
    expect(live).not.toContain("40e0b5838c31");
  });
  it("loadNewestRun: an aborted first fetch retries the next candidate; all failing is reported, not hidden", async () => {
    const real = adoptPastRuns(realPast);
    const ok = (id: string) => ({ runId: id }) as unknown as RecordedRun;
    const tried: string[] = [];
    const got = await loadNewestRun(real, "live", "EMSR773", async (id) => (tried.push(id), tried.length === 1 ? null : ok(id)));
    expect(tried.length).toBe(2);
    expect(got.run?.runId).toBe(tried[1]);
    const none = await loadNewestRun(real, "live", "EMSR773", async () => null);
    expect(none).toEqual({ run: null, failedId: expect.any(String) });
    expect(await loadNewestRun([], "live", "EMSR773", async () => null)).toEqual({ run: null, failedId: null });
  });
});
