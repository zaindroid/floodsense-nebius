import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoriesPanel } from "../components/AskFloodSense";
import {
  SEEDED_MEMORY_CHIP,
  adoptMemoryUsed,
  adoptPlaybook,
  buildApprovalBody,
  cardStatus,
  decisionStatusLine,
  memoryLine,
  seededMemoryNote,
  DEATH_TOLL_NOTE,
  NO_MEMORIES,
  sitesLine,
  draftLabel,
  sourceChips,
  actionChip,
  reviewEvidence,
  shortTitle,
} from "./hitl";
import type { ReplayCitation } from "../api/replay";
import { initialDrafts, queueFromApproval } from "../components/Approvals";

const cit = (layer: string, extra: Partial<ReplayCitation> = {}): ReplayCitation => ({
  id: `${layer}-${extra.title ?? "t"}`,
  layer,
  title: "t",
  publisher: null,
  licence: null,
  attribution: null,
  quote: null,
  page: null,
  queryId: null,
  ...extra,
});

describe("sourceChips", () => {
  it("one chip per layer source, deduplicated", () => {
    const chips = sourceChips([
      cit("a", { queryId: "1311b644deadbeef" }),
      cit("a", { queryId: "1311b644deadbeef", title: "other" }),
      cit("b"),
      cit("c", { title: "EFAS bulletin" }),
    ]);
    expect(chips.map((c) => c.text)).toEqual(["Zetaris · query 1311b644", "Provenance", "Document · EFAS bulletin"]);
  });
});

describe("memories", () => {
  it("adopts memory_used and writes a run-level line", () => {
    const m = adoptMemoryUsed([{ memory_id: "m1", run_id: "abc", claim_id: "C1", approved_at: "2026-10-26T10:00:00Z", text: "Turia peak", relevance: 0.8 }, { bad: 1 }]);
    expect(m).toHaveLength(1);
    expect(memoryLine(m[0])).toBe("Recalled from approved run abc on 26 Oct 2026: Turia peak");
    expect(adoptMemoryUsed(undefined)).toEqual([]);
    expect(NO_MEMORIES).toMatch(/this run starts fresh/);
    expect(m[0].seeded).toBe(false);
    expect(m[0].reviewer).toBeNull();
  });

  it("keeps seeded and reviewer, and never calls a seed analyst-approved", () => {
    const [seed, real] = adoptMemoryUsed([
      { memory_id: "s1", run_id: "demo-seed-ahr-altenahr", approved_at: "2026-10-27T09:00:00Z", text: "Altenahr 249.61 m3/s", reviewer: "demo-seed", seeded: true },
      { memory_id: "r1", run_id: "abc", text: "Turia peak", reviewer: "ana", seeded: "yes" },
    ]);
    expect(seed.seeded).toBe(true);
    expect(seed.reviewer).toBe("demo-seed");
    expect(real.seeded).toBe(false);
    expect(real.reviewer).toBe("ana");
    expect(memoryLine(seed)).toBe("Seeded for the demo as run demo-seed-ahr-altenahr on 27 Oct 2026: Altenahr 249.61 m3/s");
    expect(memoryLine(seed)).not.toMatch(/approved run/);
    expect(SEEDED_MEMORY_CHIP).toBe("Demo seed — not analyst-approved");
    const html = renderToStaticMarkup(createElement(MemoriesPanel, { memories: [seed, real] }));
    expect(html.match(/Demo seed — not analyst-approved/g)?.length).toBe(1);
    expect(html).toContain('class="chip chip--sample">Demo seed — not analyst-approved</span>');
    expect(html).toContain("Recalled from approved run abc");
  });
});

const PB = [
  { action_id: "A1", horizon_h: 6, text: "Notify", claim_ids: ["C1"], outbound: true, released: false, action_type: "notify-policyholders", title: "Notify holders", target_region: "Valencia", affected_site_count: 3, draft_message: "Dear customer" },
  { action_id: "A2", text: "Review", outbound: false, action_type: "bogus", affected_site_count: null, draft_message: null },
];

describe("approval card logic", () => {
  const items = adoptPlaybook(PB);
  it("adopts playbook items", () => {
    expect(items[0]).toMatchObject({ actionType: "notify-policyholders", affectedSiteCount: 3, draftMessage: "Dear customer" });
    expect(items[1].actionType).toBeNull();
    expect(actionChip(items[0].actionType)).toBe("Notify policyholders");
    expect(actionChip("inform-public")).toBe("Inform public");
    expect(sitesLine(3)).toBe("3 insured sites in the affected area");
    expect(sitesLine(1)).toBe("1 insured site in the affected area");
    expect(sitesLine(null)).toBe("Site count not reported by the Exposure step");
    expect(sitesLine(0, "EMSR773")).toBe("0 insured sites in the affected area");
    expect(sitesLine(0, "LIVE-EU")).toBe("0 insured sites · the demo book covers Valencia only");
    expect(draftLabel(true)).toBe("Draft message (sent only after approval)");
    expect(draftLabel(false)).toBe("Internal note — nothing is sent");
  });
  it("builds approve and edit bodies, refusing what would be a 422", () => {
    expect(buildApprovalBody("approve", " ok ", {}, items)).toEqual({ ok: true, body: { action: "approve", reviewer: "insurer-desk", reviewer_note: "ok" } });
    expect(buildApprovalBody("edit", "n", { A1: "Dear customer" }, items)).toMatchObject({ ok: false });
    expect(buildApprovalBody("edit", "n", { A1: "   " }, items)).toMatchObject({ ok: false, message: expect.stringMatching(/empty/) });
    expect(buildApprovalBody("edit", "n", { A2: "x" }, items)).toMatchObject({ ok: false });
    expect(buildApprovalBody("edit", "n", { A1: "New text" }, items)).toMatchObject({ ok: true, body: { action: "edit", draft_messages: { A1: "New text" } } });
  });
  it("a reject or an edit needs a reviewer note", () => {
    expect(buildApprovalBody("reject", "  ", {}, items)).toEqual({ ok: false, message: "A note is required to reject." });
    expect(buildApprovalBody("reject", "wrong area", {}, items)).toEqual({ ok: true, body: { action: "reject", reviewer: "insurer-desk", reviewer_note: "wrong area" } });
    expect(buildApprovalBody("edit", "", { A1: "New" }, items)).toMatchObject({ ok: false });
  });
  it("an edit sends every changed outbound draft, and only those", () => {
    const three = adoptPlaybook([
      ...PB,
      { action_id: "A3", text: "Adjuster", outbound: true, action_type: "dispatch-loss-adjuster", draft_message: "Go" },
      { action_id: "A4", text: "Public", outbound: true, action_type: "inform-public", draft_message: "Info" },
    ]);
    const r = buildApprovalBody("edit", "tone", { A1: "Dear customer, updated", A3: "Go now", A4: "Info" }, three);
    expect(r).toMatchObject({ ok: true, body: { draft_messages: { A1: "Dear customer, updated", A3: "Go now" } } });
    expect((r as { body: { draft_messages: Record<string, string> } }).body.draft_messages).not.toHaveProperty("A4");
  });
  it("an edit to one draft saves even when another outbound draft is blank", () => {
    const mixed = adoptPlaybook([
      ...PB,
      { action_id: "A5", text: "Blank", outbound: true, draft_message: null },
    ]);
    const drafts: Record<string, string> = { ...initialDrafts(mixed), A1: "Dear customer, revised" };
    expect(drafts.A5).toBe("");
    expect(buildApprovalBody("edit", "n", drafts, mixed)).toMatchObject({ ok: true, body: { draft_messages: { A1: "Dear customer, revised" } } });
    expect(buildApprovalBody("edit", "n", { A1: "  " }, mixed)).toMatchObject({ ok: false, message: expect.stringMatching(/empty/) });
  });
  it("falls back to a short title and a Proposed action chip", () => {
    const long = "x ".repeat(100).trim();
    const [item] = adoptPlaybook([{ action_id: "A9", text: long }]);
    expect(item.title.length).toBeLessThanOrEqual(81);
    expect(item.title.endsWith("…")).toBe(true);
    expect(actionChip(item.actionType)).toBe("Proposed action");
    expect(shortTitle("short")).toBe("short");
  });
  it("collects review evidence with grounding per claim", () => {
    const ev = reviewEvidence({
      claims: [{ claim_id: "C1", text: "a", citations: [{}, {}] }, { claim_id: "C2", text: "b", citations: [{}] }],
      judge: [{ claim_id: "C1", grounding: "supported", score: 0.9 }],
    });
    expect(ev).toMatchObject({ supported: 1, scored: 1, citations: 3 });
    expect(ev.claims[1].grounding).toBeNull();
  });
  it("initial drafts cover every outbound action", () => {
    expect(initialDrafts(items)).toEqual({ A1: "Dear customer" });
  });
  it("status lines keep the nothing-was-sent honesty", () => {
    expect(decisionStatusLine("approved")).toBe("Approved — finding saved to H-MEM memory; nothing was sent (demo).");
    expect(decisionStatusLine("rejected")).toBe("Rejected — the run ends without sending anything.");
    expect(decisionStatusLine("pending")).toBeNull();
    expect(cardStatus("awaiting_approval", null)).toBe("pending");
    expect(cardStatus("approved", "edited")).toBe("edited");
  });
  it("queues an approval payload", () => {
    const q = queueFromApproval("r1", { summary: "S", playbook: PB, judge_summary: { overall: 0.82, passes: true }, status: "awaiting_approval" });
    expect(q).toMatchObject({ runId: "r1", judgeScore: 0.82, judgePasses: true, status: "pending" });
    expect(q.items).toHaveLength(2);
  });
});

describe("seededMemoryNote", () => {
  it("flags a seeded memory that states a death toll, and nothing else", () => {
    expect(seededMemoryNote({ seeded: true, text: "In 2021 about 241 people died along the Ahr." })).toBe(DEATH_TOLL_NOTE);
    expect(seededMemoryNote({ seeded: true, text: "62 people were killed" })).toBe(DEATH_TOLL_NOTE);
    expect(seededMemoryNote({ seeded: true, text: "Deaths were reported" })).toBe(DEATH_TOLL_NOTE);
    for (const w of ["lives lost", "fatalities", "fatality", "victims", "casualties", "casualty", "dead", "killing"]) {
      expect(seededMemoryNote({ seeded: true, text: `Reports of ${w} in the flood` })).toBe(DEATH_TOLL_NOTE);
    }
    expect(seededMemoryNote({ seeded: true, text: "Altenahr 249.61 m3/s" })).toBeNull();
    expect(seededMemoryNote({ seeded: false, text: "62 people died" })).toBeNull();
    expect(DEATH_TOLL_NOTE).toBe("[source text, verify before quoting]");
  });
});
