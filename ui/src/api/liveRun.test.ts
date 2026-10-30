import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFinalRun, subscribeRunEvents, type Snapshot } from "./liveRun";
import type { LiveEvent } from "../lib/liveRun";
import { modelLine, providerOf } from "../lib/liveRun";

class FakeEventSource {
  listeners = new Map<string, ((e: unknown) => void)[]>();
  closed = false;
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(data === undefined ? {} : { data: JSON.stringify(data) });
  }
}

const runBody = (status: string, served = "replay") => ({
  run_id: "r1",
  status,
  served_from: served,
  summary: "S",
  claims: [],
  trace: [{ seq: 1, node: "scope", summary: "ok" }],
});
const snap = (status: number, body: Record<string, unknown> | null): Snapshot => ({ status, body, run: null });

describe("subscribeRunEvents", () => {
  let es: FakeEventSource;
  let events: LiveEvent[];
  const make = (url: string) => {
    es = new FakeEventSource(url);
    return es as unknown as EventSource;
  };
  beforeEach(() => {
    events = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("forwards started, trace and status, then closes", () => {
    subscribeRunEvents("r1", (e) => events.push(e), { eventSource: make, base: "http://api" });
    expect(es.url).toBe("http://api/runs/r1/events");
    es.emit("started", { node: "scope" });
    es.emit("trace", { seq: 1, node: "scope" });
    es.emit("status", { status: "awaiting_approval", served_from: "live" });
    es.emit("trace", { seq: 2, node: "watchers" });
    expect(events.map((e) => e.type)).toEqual(["started", "trace", "status"]);
    expect(es.closed).toBe(true);
  });

  it("treats an SSE error event with status 404 as not_found", () => {
    subscribeRunEvents("r1", (e) => events.push(e), { eventSource: make });
    es.emit("error", { status: 404 });
    expect(events).toEqual([{ type: "status", data: { run_id: "r1", status: "not_found" } }]);
    expect(es.closed).toBe(true);
  });

  it("falls back to polling when the stream drops", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValueOnce(snap(200, runBody("running"))).mockResolvedValueOnce(snap(200, runBody("awaiting_approval", "live")));
    subscribeRunEvents("r1", (e) => events.push(e), { eventSource: make, fetchSnapshot, pollMs: 10 });
    es.emit("error");
    expect(es.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: "status", data: { status: "awaiting_approval", served_from: "live" } });
  });

  it("gives up after the error cap and reports an error", async () => {
    let t = 0;
    const fetchSnapshot = vi.fn().mockRejectedValue(new Error("down"));
    subscribeRunEvents("r1", (e) => events.push(e), { fetchSnapshot, pollMs: 10, maxErrorMs: 30, now: () => t, eventSource: make });
    es.emit("error");
    for (let i = 0; i < 6; i += 1) {
      t += 10;
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(events.at(-1)?.type).toBe("error");
    const calls = fetchSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchSnapshot.mock.calls.length).toBe(calls);
  });

  it("stops on abort and on the stop function", async () => {
    const ctrl = new AbortController();
    subscribeRunEvents("r1", (e) => events.push(e), { eventSource: make, signal: ctrl.signal });
    ctrl.abort();
    expect(es.closed).toBe(true);
    es.emit("trace", { seq: 1, node: "scope" });
    expect(events).toEqual([]);
    const stop = subscribeRunEvents("r2", (e) => events.push(e), { eventSource: make });
    stop();
    expect(es.closed).toBe(true);
  });
});

describe("resolveFinalRun", () => {
  it("re-reads a GET that still says running, and keeps the stream's served_from", async () => {
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: null, run: { status: "running", servedFrom: "replay" } })
      .mockResolvedValueOnce({ status: 200, body: null, run: { status: "awaiting_approval", servedFrom: "replay" } });
    const run = await resolveFinalRun("r1", "live", { fetchSnapshot, delayMs: 0 });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(run?.servedFrom).toBe("live");
  });
  it("uses the GET label when there was no stream label", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ status: 200, body: null, run: { status: "approved", servedFrom: "cache" } });
    expect((await resolveFinalRun("r1", null, { fetchSnapshot }))?.servedFrom).toBe("cache");
  });
  it("returns null after the tries run out", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue({ status: 200, body: null, run: null });
    expect(await resolveFinalRun("r1", "live", { fetchSnapshot, tries: 2, delayMs: 0 })).toBeNull();
  });
});

describe("provider labels", () => {
  it("derives the provider from the model id", () => {
    expect(providerOf("nvidia/nemotron-3.5-lightning-30b-a3b")).toBe("Nightshift");
    expect(modelLine("meterless/fast", "fast")).toBe("meterless/fast");
    expect(modelLine("openai/gpt-x", "fast")).not.toMatch(/Nightshift/);
  });
});
