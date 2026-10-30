import { describe, expect, it } from "vitest";
import type { PlatformStatus } from "../api/platform";
import { heartbeat, STALE_AFTER_MS } from "./heartbeat";

const ok = {} as PlatformStatus;
describe("heartbeat", () => {
  it("starts, then reports unreachable without a status", () => {
    expect(heartbeat(null, 0, 5).state).toBe("starting");
    expect(heartbeat(null, 1000, 2000).state).toBe("unreachable");
  });
  it("is watching when fresh and stale when old", () => {
    expect(heartbeat(ok, 1000, 2000).state).toBe("watching");
    expect(heartbeat(ok, 1000, 1000 + STALE_AFTER_MS + 1).state).toBe("stale");
  });
  it("boundaries: exactly STALE_AFTER_MS is still fresh; status with at=0 is starting", () => {
    expect(heartbeat(ok, 1000, 1000 + STALE_AFTER_MS).state).toBe("watching");
    expect(heartbeat(ok, 0, 5).state).toBe("starting");
  });
});
