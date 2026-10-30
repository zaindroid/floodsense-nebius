import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller } from "./stackPoll";
import { createThrottle } from "./throttle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("throttle", () => {
  it("emits the first value at once, then at most once per gap with the latest value", () => {
    const out: string[] = [];
    const t = createThrottle<string>((v) => out.push(v), 4000);
    t.push("a");
    expect(out).toEqual(["a"]);
    // events faster than the gap: a debounce would never announce; a throttle does.
    for (const v of ["b", "c", "d"]) {
      vi.advanceTimersByTime(1000);
      t.push(v);
      expect(out).toEqual(["a"]);
    }
    vi.advanceTimersByTime(1000); // 4 s after the first
    expect(out).toEqual(["a", "d"]);
    vi.advanceTimersByTime(4000);
    t.push("e");
    expect(out).toEqual(["a", "d", "e"]);
  });
  it("cancel drops a pending value", () => {
    const out: string[] = [];
    const t = createThrottle<string>((v) => out.push(v), 1000);
    t.push("a");
    t.push("b");
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(out).toEqual(["a"]);
  });
});

function setup(hidden: { v: boolean }, results: boolean[]) {
  const listeners = new Set<() => void>();
  const run = vi.fn(async () => results.shift() ?? true);
  const poller = createPoller({
    run,
    baseMs: 1000,
    isHidden: () => hidden.v,
    onVisible: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  });
  return { run, poller, listeners };
}

describe("poller", () => {
  it("polls at the base rate, backs off after failures, resets on success", async () => {
    const { run, poller } = setup({ v: false }, [false, false, true]);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999); // failure 1: wait 2 s
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000); // failure 2: wait 4 s
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000); // success: base again
    expect(run).toHaveBeenCalledTimes(4);
    poller.stop();
  });
  it("does not request while the tab is hidden, and polls at once when visible", async () => {
    const hidden = { v: true };
    const { run, poller, listeners } = setup(hidden, []);
    poller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).not.toHaveBeenCalled();
    hidden.v = false;
    listeners.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    poller.stop();
  });
  it("stop clears the timer, removes the listener and aborts the request", async () => {
    let seen: AbortSignal | null = null;
    const listeners = new Set<() => void>();
    const run = vi.fn((s: AbortSignal) => {
      seen = s;
      return Promise.resolve(true);
    });
    const poller = createPoller({
      run,
      baseMs: 1000,
      isHidden: () => false,
      onVisible: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    poller.stop();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
