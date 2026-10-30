import { describe, expect, it } from "vitest";
import { buildRunRequest } from "../api/ask";
import { adoptRunBody } from "../api/replay";
import { greetingFor, switchEventLabel, switchTarget } from "./chatGreeting";

describe("greetingFor", () => {
  it("greets a citizen on Overview with live 48 h and Köln suggestions", () => {
    const g = greetingFor({ role: "citizen", page: "overview" });
    expect(g.text).toMatch(/^Hi! I'm FloodSense\./);
    expect(g.text).toMatch(/cites its sources/);
    expect(g.suggestions).toHaveLength(3);
    expect(g.suggestions[0]).toMatch(/next 48 hours/);
    expect(g.suggestions[1]).toMatch(/Köln/);
    expect(g.suggestions.join(" ")).not.toMatch(/Valencia|Paiporta/);
  });

  it("gives Past flood suggestions about the chosen flood only", () => {
    expect(greetingFor({ role: "citizen", page: "overview" }, "past", "EMSR517").suggestions.join(" ")).not.toMatch(/Valencia/);
    expect(greetingFor({ role: "citizen", page: "overview" }, "past", "EMSR773").suggestions.join(" ")).not.toMatch(/Ahr/);
  });

  it("gives an insurer exposure questions", () => {
    const g = greetingFor({ role: "insurer", page: "portfolio" }, "past", "EMSR773");
    expect(g.suggestions).toHaveLength(3);
    expect(g.suggestions.join(" ")).toMatch(/expos|insured/i);
    expect(g.text).toMatch(/exposure/);
  });

  it("has three suggestions on every citizen page", () => {
    for (const page of ["now", "replay", "overview", "area", "actions", "evidence"] as const) {
      expect(greetingFor({ role: "citizen", page }).suggestions).toHaveLength(3);
    }
  });
});

describe("greeting follows the event the page shows", () => {
  it("never suggests a Valencia question on an Ahr insurer page", () => {
    for (const page of ["replay", "sites"] as const) {
      const g = greetingFor({ role: "insurer", page }, "past", "EMSR517");
      expect(g.suggestions.join(" ")).not.toMatch(/Valencia/);
      expect(g.suggestions.join(" ")).toMatch(/Ahr/);
    }
    expect(greetingFor({ role: "insurer", page: "portfolio" }, "past", "EMSR773").suggestions.join(" ")).toMatch(/Valencia/);
  });
});

describe("switch-button wiring", () => {
  it("shows only for a declined run that names a known event", () => {
    expect(switchTarget({ status: "out_of_scope", elsewhere: "EMSR517" })).toBe("EMSR517");
    expect(switchTarget({ status: "out_of_scope", elsewhere: null })).toBeNull();
    expect(switchTarget({ status: "out_of_scope", elsewhere: "EMSR000" })).toBeNull();
    expect(switchTarget({ status: "done", elsewhere: "EMSR517" })).toBeNull();
  });

  it("re-sends the same question with the target event_id", () => {
    const target = switchTarget({ status: "out_of_scope", elsewhere: "EMSR517" });
    const body = buildRunRequest({
      question: "What is the water level near Ahr Valley?",
      eventId: target ?? undefined,
    });
    expect(body.event_id).toBe("EMSR517");
    expect(body.question).toBe("What is the water level near Ahr Valley?");
  });
});

describe("switching a declined question to its event", () => {
  it("labels the button by the event", () => {
    expect(switchEventLabel("EMSR517")).toBe("Ask about Ahr 2021 instead");
    expect(switchEventLabel("EMSR773")).toBe("Ask about Valencia 2024 instead");
    expect(switchEventLabel("EMSR000")).toBeNull();
  });

  it("reads scope.elsewhere from a declined run body", () => {
    const run = adoptRunBody(
      {
        served_from: "live",
        status: "out_of_scope",
        summary: "That's about the Ahr valley flood (July 2021), case EMSR517.",
        claims: [],
        scope: { in_scope: false, elsewhere: "EMSR517" },
      },
      "r1",
    );
    expect(run?.elsewhere).toBe("EMSR517");
    expect(run?.status).toBe("out_of_scope");
  });
});

describe("operator greeting", () => {
  it("gives the Civil protection desk its own three questions", () => {
    for (const page of ["situation", "approvals", "how"] as const) {
      const g = greetingFor({ role: "operator", page });
      expect(g.suggestions).toEqual([
        "Which gauges on the Elbe are above normal?",
        "Brief me on the Rhine at Köln",
        "What does the 48 h outlook show along the Danube?",
      ]);
      expect(g.text).toMatch(/script for callers/);
      expect(g.text).toMatch(/cites its sources/);
    }
  });
});
