import { describe, expect, it } from "vitest";
import { isReply, mapRunResponse } from "./ask";

const reply = {
  kind: "reply",
  intent: "greeting",
  answer: "Hello! I'm FloodSense.",
  suggestions: ["Is Valencia at risk of flooding in the next 48 hours?"],
  model_id: "rules",
  latency_ms: 4,
};

describe("isReply", () => {
  it("accepts a front-door reply", () => {
    expect(isReply(reply)).toBe(true);
  });

  it("rejects run snapshots and malformed bodies", () => {
    expect(isReply({ run_id: "r1", status: "awaiting_approval", served_from: "live" })).toBe(false);
    expect(isReply({ ...reply, intent: "flood_question" })).toBe(false);
    expect(isReply({ ...reply, answer: "" })).toBe(false);
    expect(isReply({ ...reply, suggestions: [1] })).toBe(false);
    expect(isReply(null)).toBe(false);
    expect(isReply([reply])).toBe(false);
  });

  it("mapRunResponse returns the reply, not a run", () => {
    const r = mapRunResponse(200, reply, null);
    expect(r).toEqual({ ok: false, kind: "reply", message: reply.answer, reply });
  });
});
