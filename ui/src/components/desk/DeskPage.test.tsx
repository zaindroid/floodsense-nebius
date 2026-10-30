import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WatchSource } from "../../lib/euWatch";
import { evidenceFor, type ViewLoads } from "../PlacesToWatch";
import { DESK_SLOT_ORDER, DeskCard, DeskHead, DeskPage, EvidenceRow, ForecastCard, HazardLead } from "./DeskPage";

vi.mock("../LiveSources", async () => {
  const { createElement } = await import("react");
  return { LiveSourceBadge: ({ n }: { n: number }) => createElement("b", { className: "badge" }, `[src ${n}]`) };
});

const src = (over: Partial<WatchSource> = {}): WatchSource => ({
  id: "gauge:X",
  kind: "gauge",
  name: "Köln",
  river: "Rhein",
  country: "DE",
  lat: 0,
  lon: 0,
  status: "near",
  ratio: 0.9,
  value: "",
  live: true,
  question: "q",
  measuredAt: "2026-10-27T10:15:00Z",
  ...over,
});

const loads: ViewLoads = {
  gauges: { queryId: "g-1", executedAt: null, fetchedAt: 1_000 },
  euWatch: { queryId: "e-1", executedAt: null, fetchedAt: 2_000 },
  hazard: { state: "ready", data: { queryId: "h-1", executedAt: null }, fetchedAt: 3_000 },
};

describe("DeskPage", () => {
  it("renders filled slots in the shared order and skips empty ones (agents included)", () => {
    const html = renderToStaticMarkup(<DeskPage desk="insurer" footer="F" actions="A" impact="I" map="M" />);
    const at = (n: string) => html.indexOf(`desk__slot--${n}`);
    expect([at("impact"), at("map"), at("actions"), at("footer")]).toEqual([...[at("impact"), at("map"), at("actions"), at("footer")]].sort((a, b) => a - b));
    expect(at("impact")).toBeGreaterThan(-1);
    expect(html).not.toContain("desk__slot--agents");
    expect(html).not.toContain("desk__slot--hazard");
    expect(DESK_SLOT_ORDER[DESK_SLOT_ORDER.length - 2]).toBe("agents");
  });

  it("renders the agents slot only when passed", () => {
    expect(renderToStaticMarkup(<DeskPage desk="citizen" agents={<i>AGENTS</i>} />)).toContain("AGENTS");
  });

  it("head: only the tag is a live region", () => {
    const html = renderToStaticMarkup(<DeskHead title="T" tag="Live" updated="Updated 3 min ago · query abc" />);
    expect(html).toContain('<span aria-live="polite">Live</span>');
    expect(html).toContain("<h2");
  });

  it("every card has an h3", () => {
    expect(renderToStaticMarkup(<DeskCard label="Evidence">x</DeskCard>)).toMatch(/<h3[^>]*>Evidence<\/h3>/);
    expect(renderToStaticMarkup(<DeskCard label="L" title="Title">x</DeskCard>)).toMatch(/<h3[^>]*>Title<\/h3>/);
  });
});

describe("HazardLead", () => {
  const ev = evidenceFor(loads, src());
  it("live: time, basis and freshness are visible outside <details>; heading is the place", () => {
    const html = renderToStaticMarkup(<HazardLead label="Brief for" title="Rhein · Köln" source={src()} evidence={ev} summary={<p>Across the watch: 3</p>} />);
    expect(html).toMatch(/<h3[^>]*>Rhein · Köln<\/h3>/);
    expect(html).toContain("Measured");
    expect(html).toContain("· live");
    expect(html).toContain("Across the watch: 3");
    expect(html).not.toContain("<details");
    expect(html).not.toContain('role="alert"');
  });
  it("non-live: amber alert, not the calm sentence, and detail only inside <details>", () => {
    const html = renderToStaticMarkup(<HazardLead label="L" source={src({ live: false })} evidence={ev} detail={<p>EXTRA</p>} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("not live");
    expect(html).toMatch(/<details[\s\S]*EXTRA/);
  });
});

describe("ForecastCard and EvidenceRow", () => {
  it("always carries the model note unless overridden", () => {
    expect(renderToStaticMarkup(<ForecastCard>x</ForecastCard>)).toContain("A model, not an official warning.");
    expect(renderToStaticMarkup(<ForecastCard note="custom">x</ForecastCard>)).toContain("custom");
  });
  it("evidence row opens the panel", () => {
    const html = renderToStaticMarkup(<EvidenceRow evidence={evidenceFor(loads, src())} onOpen={() => undefined} />);
    expect(html).toContain("Open the evidence panel");
    expect(html).toContain("[src 1]");
  });
});

describe("evidenceFor with the insurer page's own loads", () => {
  it("carries query id and fetch time per source kind, no forced null", () => {
    const g = evidenceFor(loads, src());
    const m = evidenceFor(loads, src({ kind: "model", id: "model:A" }));
    const v = evidenceFor(loads, src({ kind: "valencia", id: "valencia:V" }));
    expect([g.queryId, m.queryId, v.queryId]).toEqual(["g-1", "e-1", "h-1"]);
    expect(g.fetchedAt).not.toBeNull();
    expect(m.fetchedAt).not.toBeNull();
    expect(v.fetchedAt).not.toBeNull();
  });
  it("hazard not ready gives no query id", () => {
    expect(evidenceFor({ ...loads, hazard: { state: "loading" } }, src({ kind: "valencia" })).queryId).toBeNull();
  });
});
