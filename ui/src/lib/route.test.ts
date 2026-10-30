import { describe, expect, it } from "vitest";
import { DESK_NAV, insurerHome, pageLabel, parseHash, routeHref, type DeskRoute } from "./route";

describe("parseHash", () => {
  it("opens Approvals when the hash is empty and a decision is pending", () => {
    expect(parseHash("")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#/")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("   ")).toEqual({ role: "insurer", page: "approvals" });
  });

  it("opens Portfolio as the insurer home once nothing is pending", () => {
    expect(parseHash("", false)).toEqual({ role: "insurer", page: "portfolio" });
    expect(parseHash("#/insurer", false)).toEqual({ role: "insurer", page: "portfolio" });
    expect(parseHash("#/insurer/approvals", false)).toEqual({ role: "insurer", page: "approvals" });
    expect(insurerHome(true)).toBe("approvals");
    expect(insurerHome(false)).toBe("portfolio");
  });

  it("parses the Now page on both desks without making it a home", () => {
    expect(parseHash("#/citizen/now")).toEqual({ role: "citizen", page: "now" });
    expect(parseHash("#/insurer/now")).toEqual({ role: "insurer", page: "now" });
    expect(parseHash("#/insurer/now", false)).toEqual({ role: "insurer", page: "now" });
    expect(parseHash("#/citizen")).toEqual({ role: "citizen", page: "overview" });
    expect(parseHash("#/insurer")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#/now")).toEqual({ role: "insurer", page: "approvals" });
    expect(routeHref("citizen", "now")).toBe("#/citizen/now");
    expect(routeHref("insurer", "now")).toBe("#/insurer/now");
    expect(DESK_NAV.citizen[0].page).toBe("now");
    expect(DESK_NAV.insurer[1].page).toBe("now"); // the Control tower is first on the insurer desk
  });

  it("treats a role with no page as that desk's home", () => {
    expect(parseHash("#/insurer")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#/citizen")).toEqual({ role: "citizen", page: "overview" });
    expect(parseHash("#/citizen/")).toEqual({ role: "citizen", page: "overview" });
    expect(parseHash("#citizen")).toEqual({ role: "citizen", page: "overview" });
  });

  it("reads every approved page", () => {
    expect(parseHash("#/citizen/area")).toEqual({ role: "citizen", page: "area" });
    expect(parseHash("#/citizen/actions")).toEqual({ role: "citizen", page: "actions" });
    expect(parseHash("#/citizen/evidence")).toEqual({ role: "citizen", page: "evidence" });
    expect(parseHash("#/citizen/overview")).toEqual({ role: "citizen", page: "overview" });
    expect(parseHash("#/insurer/approvals")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#/insurer/portfolio")).toEqual({ role: "insurer", page: "portfolio" });
    expect(parseHash("#/insurer/sites")).toEqual({ role: "insurer", page: "sites" });
    expect(parseHash("#/insurer/alerts")).toEqual({ role: "insurer", page: "alerts" });
    expect(parseHash("#/insurer/review")).toEqual({ role: "insurer", page: "review" });
  });

  it("sends a #36 hash to the page that now holds its content", () => {
    expect(parseHash("#/citizen/place")).toEqual({ role: "citizen", page: "area" });
    expect(parseHash("#/citizen/rain")).toEqual({ role: "citizen", page: "area" });
    expect(parseHash("#/insurer/overview")).toEqual({ role: "insurer", page: "portfolio" });
    expect(parseHash("#/insurer/map")).toEqual({ role: "insurer", page: "sites" });
    expect(parseHash("#/insurer/point")).toEqual({ role: "insurer", page: "sites" });
    expect(parseHash("#/insurer/book")).toEqual({ role: "insurer", page: "portfolio" });
    expect(parseHash("#/insurer/sources")).toEqual({ role: "insurer", page: "review" });
  });

  it("sends an unknown page back to that desk's home", () => {
    expect(parseHash("#/citizen/map")).toEqual({ role: "citizen", page: "overview" });
    expect(parseHash("#/citizen/nope")).toEqual({ role: "citizen", page: "overview" });
    expect(parseHash("#/insurer/area")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#/insurer/review/extra")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#/citizen/area/more")).toEqual({ role: "citizen", page: "overview" });
    expect(parseHash("#/citizen/constructor")).toEqual({ role: "citizen", page: "overview" });
    expect(parseHash("#/insurer/toString", false)).toEqual({ role: "insurer", page: "portfolio" });
  });

  it("sends an unknown role to the insurer home", () => {
    expect(parseHash("#/other")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#/Citizen")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#/map", false)).toEqual({ role: "insurer", page: "portfolio" });
  });

  it("round-trips every nav item whether or not a decision is pending", () => {
    const routes: DeskRoute[] = [
      ...DESK_NAV.citizen.map((item) => ({ role: "citizen" as const, page: item.page })),
      ...DESK_NAV.insurer.map((item) => ({ role: "insurer" as const, page: item.page })),
    ];
    for (const route of routes) {
      expect(parseHash(routeHref(route.role, route.page))).toEqual(route);
      expect(parseHash(routeHref(route.role, route.page), false)).toEqual(route);
    }
  });
});

describe("Replay page", () => {
  it("parses on both desks, sits right after Now, and is never a home", () => {
    expect(parseHash("#/citizen/replay")).toEqual({ role: "citizen", page: "replay" });
    expect(parseHash("#/insurer/replay", false)).toEqual({ role: "insurer", page: "replay" });
    expect(routeHref("citizen", "replay")).toBe("#/citizen/replay");
    expect(routeHref("insurer", "replay")).toBe("#/insurer/replay");
    expect(DESK_NAV.citizen[1]).toEqual({ page: "replay", label: "Replay" });
    expect(DESK_NAV.insurer[2]).toEqual({ page: "replay", label: "Replay" });
    expect(pageLabel({ role: "insurer", page: "replay" })).toBe("Replay");
    expect(parseHash("#/replay")).toEqual({ role: "insurer", page: "approvals" });
  });
});

describe("DESK_NAV", () => {
  it("matches the approved IA", () => {
    expect(DESK_NAV.citizen.map((item) => item.label)).toEqual(["Now", "Replay", "Overview", "My area", "What to do", "Evidence", "How it works"]);
    expect(DESK_NAV.insurer.map((item) => item.label)).toEqual([
      "Control tower",
      "Now",
      "Replay",
      "Approvals",
      "Portfolio",
      "Sites / map",
      "Alerts",
      "Review",
      "System",
      "How it works",
    ]);
    expect(parseHash("#/insurer/system")).toEqual({ role: "insurer", page: "system" });
    expect(parseHash("#/citizen/system")).toEqual({ role: "citizen", page: "overview" });
  });

  it("labels a route from the nav table", () => {
    expect(pageLabel({ role: "citizen", page: "actions" })).toBe("What to do");
    expect(pageLabel({ role: "insurer", page: "sites" })).toBe("Sites / map");
  });
});

describe("Control tower page", () => {
  it("is first on the insurer desk, reachable by hash on both, and never a home", () => {
    expect(DESK_NAV.insurer[0]).toEqual({ page: "tower", label: "Control tower" });
    expect(parseHash("#/insurer/tower")).toEqual({ role: "insurer", page: "tower" });
    expect(parseHash("#/citizen/tower")).toEqual({ role: "citizen", page: "tower" });
    expect(parseHash("#/insurer")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#/citizen")).toEqual({ role: "citizen", page: "overview" });
    expect(routeHref("citizen", "tower")).toBe("#/citizen/tower");
    // not in the citizen nav (the footer links it), and labelled for each desk
    expect(DESK_NAV.citizen.some((item) => item.page === ("tower" as string))).toBe(false);
    expect(pageLabel({ role: "insurer", page: "tower" })).toBe("Control tower");
    expect(pageLabel({ role: "citizen", page: "tower" })).toBe("How we watch");
  });
});

describe("operator desk", () => {
  it("opens the Situation board at #/operator and reads its pages", () => {
    expect(parseHash("#/operator")).toEqual({ role: "operator", page: "situation" });
    expect(parseHash("#/operator/approvals")).toEqual({ role: "operator", page: "approvals" });
    expect(parseHash("#/operator/how")).toEqual({ role: "operator", page: "how" });
    expect(parseHash("#/operator/nonsense")).toEqual({ role: "operator", page: "situation" });
    expect(parseHash("#/operator/situation/extra")).toEqual({ role: "operator", page: "situation" });
    expect(routeHref("operator", "situation")).toBe("#/operator");
    expect(routeHref("operator", "approvals")).toBe("#/operator/approvals");
    expect(DESK_NAV.operator.map((i) => i.page)).toEqual(["situation", "approvals", "how"]);
    expect(pageLabel({ role: "operator", page: "situation" })).toBe("Situation board");
  });

  it("leaves the other desks homes alone", () => {
    expect(parseHash("")).toEqual({ role: "insurer", page: "approvals" });
    expect(parseHash("#/citizen")).toEqual({ role: "citizen", page: "overview" });
  });
});
