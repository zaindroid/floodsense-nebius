import { describe, expect, it } from "vitest";
import type { ReplayCitation, ReplayClaim } from "../api/replay";
import answer from "../fixtures/answer.json";
import sampleRun from "../fixtures/run_f16733274f1c.json";
import { adoptRunBody } from "../api/replay";
import type { Answer } from "../types/contract";
import { drawerFields, numberAnswerReferences, numberRunReferences, refById, referenceAnchor } from "./references";

const doc = (id: string, page = 4): ReplayCitation => ({
  id,
  layer: "c",
  title: "NHESS 23-525",
  publisher: "Copernicus Publications",
  licence: "CC BY 4.0",
  attribution: "Mohr et al. 2023",
  quote: "The flood peak at Altenahr exceeded all records.",
  page,
  paragraph: 2,
  queryId: "zq-hydrate-1",
  sourceUrl: "https://nhess.copernicus.org/articles/23/525/2023/",
});
const data = (id: string): ReplayCitation => ({
  id,
  layer: "a",
  title: "floodsense.gauge_levels",
  publisher: null,
  licence: null,
  attribution: null,
  quote: null,
  page: null,
  queryId: "zq-data-9",
});

describe("reference numbering", () => {
  const claims: ReplayClaim[] = [
    { id: "C1", text: "The Ahr rose fast.", citations: [doc("d1"), data("a1")] },
    { id: "C2", text: "Altenahr broke records.", citations: [doc("d1"), doc("d2", 7)] },
    { id: "C3", text: "Uncited.", citations: [] },
  ];

  it("numbers by first appearance and reuses a number for the same source", () => {
    const set = numberRunReferences(claims, { scope: "review", eventId: "EMSR517" });
    expect(set.claims.map((c) => c.refs)).toEqual([[1, 2], [1, 3], []]);
    expect(set.refs.map((r) => [r.n, r.kind])).toEqual([
      [1, "document"],
      [2, "zetaris"],
      [3, "document"],
    ]);
    expect(set.refs[0].anchor).toBe(referenceAnchor("review", 1));
    expect(new Set(set.refs.map((r) => r.anchor)).size).toBe(3);
    expect(refById(set, "d2")?.n).toBe(3);
  });

  it("limits numbering to the requested layers (the retrieval block numbers documents only)", () => {
    const set = numberRunReferences(claims, { scope: "rag", layers: ["c"] });
    expect(set.claims.map((c) => c.refs)).toEqual([[1], [1, 2], []]);
  });

  it("gives the drawer the full document source and the data source's view, query id and upstream link", () => {
    const set = numberRunReferences(claims, { scope: "review", eventId: "EMSR517" });
    const d = set.refs[0];
    expect(drawerFields(d)).toEqual([
      { label: "Title", value: "NHESS 23-525" },
      { label: "Publisher", value: "Copernicus Publications" },
      { label: "Page / paragraph", value: "page 4, paragraph 2" },
      { label: "Licence", value: "CC BY 4.0" },
      { label: "Zetaris hydration query id", value: "zq-hydrate-1" },
    ]);
    expect(d.quote).toMatch(/exceeded all records/);
    expect(d.link?.href).toBe("https://nhess.copernicus.org/articles/23/525/2023/");
    const z = set.refs[1];
    expect(drawerFields(z)).toEqual([
      { label: "View", value: "floodsense.gauge_levels" },
      { label: "Query id", value: "zq-data-9" },
    ]);
    expect(z.link?.href).toBe("https://www.pegelonline.wsv.de/");
  });

  it("numbers the reviewed fixture answer and marks fixture query ids as fixtures", () => {
    const a = answer as unknown as Answer;
    const set = numberAnswerReferences(a, { scope: "review" });
    expect(set.refs.length).toBe(new Set(a.citations.map((c) => c.citation_id)).size);
    expect(set.claims.every((c) => c.refs.length > 0)).toBe(true);
    const first = set.refs[0];
    expect(drawerFields(first).find((f) => f.label === "Query id")?.value).toMatch(/fixture id, not a Zetaris query/);
  });

  it("numbers the recorded run's layer (c) passages so every passage has an [n]", () => {
    const run = adoptRunBody(sampleRun as unknown as Record<string, unknown>, "f16733274f1c");
    expect(run).not.toBeNull();
    const set = numberRunReferences(run!.claims, { scope: "rag", layers: ["c"] });
    const passages = run!.claims.flatMap((c) => c.citations.filter((x) => x.layer === "c"));
    for (const p of passages) expect(refById(set, p.id)).not.toBeNull();
  });
});
