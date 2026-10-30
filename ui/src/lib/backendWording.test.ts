import { afterEach, describe, expect, it, vi } from "vitest";
import { getLlmBackend, llmBoxTitle, providerLabel, setLlmBackend, subscribeLlmBackend } from "./lanes";
import { modelChip, runModelLine } from "./modelChip";
import { modelBadge } from "./pipeline";
import { asWatchEvent, plainEventText, RATE_LIMIT_TEXT } from "./controlTower";
import { fetchPlatformStatus } from "../api/platform";

const ID = "nvidia/nemotron-3.5-lightning-30b-a3b";
afterEach(() => {
  setLlmBackend(null);
  vi.unstubAllGlobals();
});

describe("backend-aware LLM wording", () => {
  it("a live run is named after the current backend", () => {
    expect(modelChip(ID, "fast", null, "nebius")).toBe("Nemotron 3.5 Lightning 30B · Nebius Token Factory fast lane");
    expect(runModelLine([ID], null, "nebius")).toBe("Nemotron 3.5 Lightning 30B via Nebius Token Factory");
    expect(modelChip(ID, "deep", null, "nightshift")).toBe("Nemotron 3.5 Lightning 30B · Nightshift deep lane");
    expect(llmBoxTitle("nebius")).toBe("Nebius Token Factory · NVIDIA Nemotron");
    expect(llmBoxTitle("nightshift")).toBe("Nightshift · NVIDIA Nemotron");
  });
  it("a recorded run without a provider stays neutral, whatever the current backend is", () => {
    setLlmBackend("nebius");
    expect(modelChip(ID, "fast")).toBe("Nemotron 3.5 Lightning 30B");
    expect(runModelLine([ID])).toBe("Nemotron 3.5 Lightning 30B");
    expect(modelBadge(ID).text).not.toMatch(/Nebius|Nightshift/);
  });
  it("a run with only usage model ids and no provider never names a backend", () => {
    setLlmBackend("nebius");
    const line = runModelLine(["nvidia/Nemotron-3.5-Super-VL"]);
    expect(line).not.toMatch(/Nightshift|Nebius/);
    expect(modelChip("nvidia/Nemotron-3_5-Lightning", "fast")).not.toMatch(/Nightshift|Nebius/);
    expect(runModelLine(["nvidia/Nemotron-3.5-Super-VL"], "nightshift")).toMatch(/via Nightshift$/);
  });
  it("a stated provider wins", () => {
    expect(providerLabel(ID, "nightshift", "nebius")).toBe("Nightshift");
    expect(modelBadge(ID, "nebius")).toEqual({ kind: "model", text: expect.stringContaining("Nebius Token Factory") });
  });
  it("unknown backend is neutral, never Nightshift", () => {
    expect(llmBoxTitle(null)).toBe("Model backend · NVIDIA Nemotron");
    expect(providerLabel(ID, null, null)).toBeNull();
  });
});

describe("backend store wiring", () => {
  it("notifies subscribers when the status arrives", () => {
    const seen: (string | null)[] = [];
    const off = subscribeLlmBackend(() => seen.push(getLlmBackend()));
    setLlmBackend("Nebius");
    setLlmBackend("nebius");
    off();
    setLlmBackend("nightshift");
    expect(seen).toEqual(["nebius"]);
  });
  it("a failed /platform/status leaves the backend unknown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const r = await fetchPlatformStatus("http://x");
    setLlmBackend(r.status?.llmBackend);
    expect(getLlmBackend()).toBeNull();
  });
});

describe("raw upstream rate-limit text", () => {
  const raw =
    "Could not read hazard_now this scan... (Zetaris HTTP 400: {\"msg\":\"REST API call failed: Server returned HTTP response code: 429 for URL: https://flood-api.open-meteo.com/v1/flood?latitude=39.47&longitude=-0.38&daily=river_discharge\"})";
  it("becomes a plain sentence with the raw text as detail", () => {
    expect(plainEventText(raw)).toEqual({ text: RATE_LIMIT_TEXT, detail: raw });
    const e = asWatchEvent({ id: "w00000001", ts: "2026-10-30T10:00:00Z", kind: "info", agent: "Watch", tone: "neutral", text: raw, source: { view: "hazard_now" } });
    expect(e?.text).toBe(RATE_LIMIT_TEXT);
    expect(e?.detail).toBe(raw);
  });
  it("leaves ordinary text alone", () => {
    expect(plainEventText("Level rose 20 cm").detail).toBeNull();
  });
});
