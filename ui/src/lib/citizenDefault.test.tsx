import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlainAgents } from "../components/agents/AgentsLive";
import { SponsorChips } from "../components/SponsorStrip";
import type { AgentsLiveModel } from "../hooks/useAgentsLive";

const text = (html: string) => html.replace(/<[^>]*>/g, " ");

describe("default citizen render (no data yet)", () => {
  it("sponsor strip has no digits", () => {
    const html = renderToStaticMarkup(<SponsorChips platform={null} role="citizen" />);
    expect(html).toContain("Nebius");
    expect(text(html) + (html.match(/(title|aria-label)="[^"]*"/g) ?? []).join(" ")).not.toMatch(/\d/);
  });
  it("agents block is labelled and has no digits when no run exists", () => {
    const html = renderToStaticMarkup(<PlainAgents model={{ kind: "none", nodes: [] } as unknown as AgentsLiveModel} />);
    expect(html).toContain("a human approves before anything goes out");
    expect(html).toContain('data-agents-live="none"');
    expect(text(html)).not.toMatch(/\d/);
  });
});
