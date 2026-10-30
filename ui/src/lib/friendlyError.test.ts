import { describe, expect, it } from "vitest";
import { classifyError, friendlyError, statusFromMessage, stripInternal } from "./friendlyError";

const RAW = "The service failed (503): agents service unreachable at http://agents:8100: RemoteProtocolError.";

describe("stripInternal", () => {
  it("removes URLs and host:port pairs", () => {
    const out = stripInternal(RAW);
    expect(out).not.toMatch(/agents:8100|http/);
    expect(out).toMatch(/RemoteProtocolError/);
    expect(stripInternal("GET http://localhost:18000/runs/x failed; 10.0.0.5:8000 down; redis:6379")).not.toMatch(/localhost|10\.0\.0\.5|6379/);
  });
  it("strips service names only in host-like contexts", () => {
    for (const host of ["agents", "api", "engines", "pgvector", "redis"]) {
      for (const raw of [`GET http://${host}/runs failed`, `${host}:8100 refused`, `dial //${host} refused`, `user@${host} refused`]) {
        expect(stripInternal(raw)).not.toMatch(new RegExp(`\\b${host}\\b`));
      }
    }
    expect(stripInternal("our agents are busy; the api returned 503")).toBe("our agents are busy; the api returned 503");
  });
  it("keeps quoted version strings", () => {
    expect(stripInternal("schema 'v1.2' and \"2.0.1\" are fine")).toBe("schema 'v1.2' and \"2.0.1\" are fine");
  });
  it("removes quoted hostnames", () => {
    const out = stripInternal(`could not resolve 'redis' or "agents.internal" (host 'pgvector')`);
    expect(out).not.toMatch(/redis|agents\.internal|pgvector/);
    expect(stripInternal(`field "question" is required`)).toMatch(/"question"/);
  });
  it("removes IPv6 with a port", () => {
    const out = stripInternal("connect to [::1]:6379 failed, then [fe80::1%eth0]:8100 refused");
    expect(out).not.toMatch(/::1|6379|fe80|8100/);
    expect(out).toMatch(/failed/);
  });
});

describe("friendlyError", () => {
  it("503 / unreachable: agents restarting, retry, offer recorded", () => {
    expect(statusFromMessage(RAW)).toBe(503);
    const f = friendlyError(503, RAW, "insurer", true);
    expect(f).toMatchObject({ kind: "unavailable", retry: true, offerRecorded: true });
    expect(f.text).toMatch(/^Our agents are restarting or busy right now/);
    expect(f.text).toMatch(/Here is the latest recorded answer/);
    expect(f.text).not.toMatch(/503|http/);
    expect(f.technical).not.toMatch(/agents:8100/);
    expect(friendlyError(null, "Could not reach the API (Failed to fetch).").kind).toBe("unavailable");
    expect(friendlyError(502, "x", "citizen").text).toMatch(/local authorities/);
  });
  it("only promises a recorded answer when one is shown", () => {
    expect(friendlyError(503, RAW, "insurer", false).text).not.toMatch(/recorded answer/);
    expect(friendlyError(503, RAW, "citizen").text).not.toMatch(/recorded answer/);
    expect(friendlyError(503, RAW, "citizen", true).text).toMatch(/Here is the latest recorded answer/);
  });
  it("timeouts", () => {
    expect(friendlyError(504, "gateway").text).toMatch(/^This is taking longer than usual/);
    expect(classifyError(null, "Lost contact with run r1 for over 60 s")).toBe("timeout");
  });
  it("422: rephrase, no retry", () => {
    expect(friendlyError(422, "Request refused: bad")).toMatchObject({ text: "I couldn't read that question — try rephrasing.", retry: false });
  });
  it("failed and not found", () => {
    expect(classifyError(null, "Run r1 failed after it started.")).toBe("failed");
    expect(classifyError(null, "Run r1 was not found.")).toBe("not_found");
  });
});
