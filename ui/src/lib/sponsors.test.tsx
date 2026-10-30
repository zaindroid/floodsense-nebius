import { renderToStaticMarkup } from "react-dom/server";
import { PlainAgents } from "../components/agents/AgentsLive";
import type { AgentsLiveModel } from "../hooks/useAgentsLive";
import { describe, expect, it, vi } from "vitest";
import { parsePlatformStatus } from "../api/platform";
import { adoptRunBody } from "../api/replay";
import { SponsorChips } from "../components/SponsorStrip";
import { WebCheckCard } from "../components/desk/WebCheck";
import { TavilyCard } from "../components/stack/TavilyCard";
import type { StackData } from "../hooks/useStackData";
import { agoPhrase, regionBadge, sponsorChips, webCheckView, webContextOf } from "./sponsors";
import { buildTechTrace } from "./techTrace";

vi.mock("../components/LiveSources", () => ({ LiveSourceBadge: () => null }));

const status = (over: Record<string, unknown> = {}) =>
  parsePlatformStatus({
    agents_ok: true,
    llm_backend: "nebius",
    lanes: { fast: "nvidia/nemotron-3.5-lightning-30b-a3b", deep: "nvidia/nemotron-3.5-super-vl-120b-a12b" },
    data_backend: "zetaris",
    tavily: true,
    tavily_status: { enabled: true, key_configured: true, calls: 4, cache_hits: 1, avg_latency_ms: 420, last_status: "ok" },
    ...over,
  });

const WEB = {
  status: "ok",
  query: "Koeln flood",
  n_results: 4,
  latency_ms: 310,
  cached: false,
  retrieved_at: "2026-10-30T09:00:00Z",
  results: [1, 2, 3, 4].map((i) => ({ url: `https://example.org/${i}`, title: `Item ${i}` })),
  web_check: { claim_id: "C-1", verdict: "contradicts", url: "https://example.org/1" },
};
const stackOf = (raw: unknown): StackData =>
  ({ platform: { data: null, error: null, loading: false }, system: { data: null, error: null, loading: false }, stackRun: raw ? { raw, run: { summary: "Koeln level is high", question: "Is Koeln flooding?", eventId: null } as never, kind: "replay" } : null, live: null, runsError: null }) as StackData;

describe("sponsor chips", () => {
  it("every dot is unavailable without a status, never a guess", () => {
    expect(sponsorChips(null).every((c) => c.state === "unavailable")).toBe(true);
  });
  it("Tavily shows calls and model ids come from the lanes", () => {
    const chips = sponsorChips(status());
    expect(chips.find((c) => c.id === "tavily")).toMatchObject({ state: "on", detail: "4 calls" });
    expect(chips.find((c) => c.id === "nemotron")?.detail).toContain("deep 3.5 Super VL 120B");
    expect(sponsorChips(status({ tavily_status: { enabled: false }, tavily: false })).find((c) => c.id === "tavily")?.detail).toBe("off");
  });
  it("links to the Stack page and carries the Tavily explanation", () => {
    const html = renderToStaticMarkup(<SponsorChips platform={status()} role="insurer" />);
    expect(html).toContain('href="#/insurer/stack"');
    expect(html).toContain("Complements Zetaris");
  });
});

describe("region badge", () => {
  it("does not imply EU-only", () => {
    expect(regionBadge({ region: "eu-north1", country: "Finland" })).toBe("EU (Finland)");
    expect(regionBadge({ region: "us-central1", country: "USA" })).toBe("US");
    expect(regionBadge({ region: "mars-1", country: null })).toBe("mars-1");
    expect(regionBadge(null)).toBeNull();
  });
});

describe("web check", () => {
  it("empty state is honest", () => {
    expect(webCheckView(null).headline).toBe("No web check in the run shown.");
    expect(renderToStaticMarkup(<WebCheckCard stack={stackOf(null)} desk="citizen" />)).toContain("No web check in the run shown.");
  });
  it("reads both the projected answer and the raw body, and maps verdict words", () => {
    expect(webContextOf({ answer: { web_context: WEB } })?.web_check?.verdict).toBe("contradicts");
    expect(webContextOf({ web: { status: "ok", items: [{ url: "https://a.b", title: "t" }] } })?.n_results).toBe(1);
    expect(webContextOf({})).toBeNull();
    expect(webCheckView(webContextOf({ answer: { web_context: WEB } })).verdict).toBe("conflicts");
  });
  it("citizen: words and links only, at most 3, no numbers; insurer sees detail", () => {
    const raw = { answer: { web_context: WEB } };
    const c = renderToStaticMarkup(<WebCheckCard stack={stackOf(raw)} desk="citizen" place="Koeln" />);
    expect(c).toContain("From the latest checked answer for Koeln");
    expect(c).toContain("REPLAY");
    expect(c).toContain("A web report conflicts with this.");
    expect(c).toContain("Web context, not an official warning");
    expect(c).toContain("conflicts");
    expect(c).toContain('rel="noopener noreferrer"');
    expect(c).not.toContain("Item 4");
    expect(c).not.toContain("310 ms");
    expect(renderToStaticMarkup(<WebCheckCard stack={stackOf(raw)} desk="insurer" />)).toContain("310 ms");
  });
});

describe("review fixes", () => {
  const raw = { answer: { web_context: { ...WEB, results: [{ url: "javascript:alert(1)", title: "<b>bold</b>" }, { url: "https://ok.example/x", title: "<img src=x onerror=1>" }] } } };
  it("citizen web check shows no event id, ISO time or digits; place match folds diacritics", () => {
    const clean = { answer: { web_context: { ...WEB, results: [{ url: "https://example.org/a", title: "River report" }] } } };
    const stack = stackOf(clean);
    (stack.stackRun!.run as unknown as Record<string, unknown>).eventId = "EMSR773";
    const html = renderToStaticMarkup(<WebCheckCard stack={stack} desk="citizen" place="Köln" />);
    expect(html).toContain("From the latest checked answer for Köln");
    expect(html).not.toContain("EMSR773");
    expect(html).not.toContain("2026-10-30");
    expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/\d/);
    expect(agoPhrase("2026-10-30T09:00:00Z", Date.parse("2026-10-30T09:05:00Z"))).toBe("a few minutes ago");
  });
  it("citizen sees nothing for a different place", () => {
    const html = renderToStaticMarkup(<WebCheckCard stack={stackOf(raw)} desk="citizen" place="Valencia" />);
    expect(html).toContain("another place");
    expect(html).not.toContain("conflicts");
  });
  it("javascript: url is not a link; html titles are text", () => {
    const html = renderToStaticMarkup(<WebCheckCard stack={stackOf(raw)} desk="insurer" />);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<b>bold");
    expect(html).toContain("&lt;b&gt;bold");
    expect(html).toContain("&lt;img");
  });
  it("citizen strip has no digits; Meterless is unknown, not agentsOk", () => {
    const html = renderToStaticMarkup(<SponsorChips platform={status()} role="citizen" />);
    expect(html.replace(/<[^>]*>/g, " ").replace(/(title|aria-label|href|class|data-sponsor)="[^"]*"/g, (m) => m)).not.toMatch(/\d/);
    expect(html.match(/title="[^"]*"|aria-label="[^"]*"/g)?.join(" ")).not.toMatch(/\d/);
    expect(sponsorChips(status()).find((c) => c.id === "meterless")?.state).toBe("unknown");
  });
  it("poll stops on cleanup and does not overlap", async () => {
    vi.useFakeTimers();
    const { startPlatformPoll, resetPlatform } = await import("./platformStore");
    resetPlatform();
    let calls = 0;
    const stop = startPlatformPoll(async () => ((calls += 1), { status: null }), 1000);
    expect(calls).toBe(1);
    stop();
    vi.advanceTimersByTime(10_000);
    expect(calls).toBe(1);
    vi.useRealTimers();
  });
});

describe("citizen plain agents", () => {
  const model = {
    kind: "replay", runId: "run_f16733274f1c", handoff: null, loops: { revise: 2, repair: 1 }, servedFrom: "cache", chips: {}, played: 3, total: 8,
    still: false, watch: [], watchOpen: false, retryLeft: 30, announce: "",
    nodes: ["scope", "skeptic", "judge"].map((id, i) => ({ id, label: id[0].toUpperCase() + id.slice(1), state: ["done", "active", "idle"][i], runs: 2, latencyMs: 1234, modelId: "m" })),
  } as unknown as AgentsLiveModel;
  it("has agent names, status words and the sentence, and no digits", () => {
    const html = renderToStaticMarkup(<PlainAgents model={model} />);
    expect(html).toContain("double-checking");
    expect(html).toContain("a human approves before anything goes out");
    expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/\d/);
  });
});

describe("Tavily tile and card", () => {
  const run = adoptRunBody({ run_id: "r", served_from: "live", summary: "s", claims: [], web: { ...WEB, items: WEB.results }, usage: { models: [{ lane: "deep", model_id: "m", calls: 1, total_tokens: 10 }], total: { calls: 1, total_tokens: 10 }, cost_usd: 0.002 } }, "r")!;
  it("tile carries real per-call data and the region of the lane", () => {
    const m = buildTechTrace(run, "nebius", { deep: { modelId: "m", pricePerMInput: 1, pricePerMOutput: 2, pricePerMCacheRead: null, rpmLimit: null, tpmLimit: null, region: "us-central1", country: "USA" } });
    const t = m.tiles.find((x) => x.id === "tavily")!;
    expect(t.details.map((d) => `${d.label}=${d.value}`)).toEqual(expect.arrayContaining(["Status=ok", "Results=4", "Latency=310 ms", "Cached=no"]));
    const nb = m.tiles.find((x) => x.id === "nightshift")!;
    expect(nb.details.some((d) => d.value.includes("region US"))).toBe(true);
    expect(nb.details.some((d) => d.label === "Cost")).toBe(true);
  });
  it("card animates only with a live status and Tavily on", () => {
    expect(renderToStaticMarkup(<TavilyCard platform={status()} />)).toContain("stk-search");
    expect(renderToStaticMarkup(<TavilyCard platform={status({ tavily_status: { enabled: false, key_configured: false } })} />)).not.toContain("stk-search");
    expect(renderToStaticMarkup(<TavilyCard platform={null} />)).not.toContain("stk-search");
  });
});
