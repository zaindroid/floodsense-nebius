import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformStatus } from "../api/platform";
import { publishPlatform, resetPlatform } from "../lib/platformStore";
import { AgentHeartbeat } from "./AgentHeartbeat";

afterEach(() => {
  resetPlatform();
  vi.useRealTimers();
});

// No DOM library is installed, so this renders to markup (effects, and so the 30 s interval, do not run on the server).
describe("AgentHeartbeat", () => {
  it("renders each real state from the shared snapshot and starts no timer on the server", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    expect(renderToStaticMarkup(<AgentHeartbeat />)).toContain('data-heartbeat="starting"');
    publishPlatform(null, Date.now());
    expect(renderToStaticMarkup(<AgentHeartbeat />)).toContain('data-heartbeat="unreachable"');
    publishPlatform({} as PlatformStatus, Date.now());
    const html = renderToStaticMarkup(<AgentHeartbeat />);
    expect(html).toContain("Platform status OK");
    expect(html).toContain('data-heartbeat="watching"');
    expect(vi.getTimerCount()).toBe(0);
  });
});
