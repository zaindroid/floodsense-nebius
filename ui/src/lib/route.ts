import type { RouteId } from "../types/ui";

/** Desk in the hash: the three roles the header switches. */
export type RoleId = RouteId;

export const CITIZEN_PAGES = ["now", "replay", "overview", "area", "actions", "evidence", "how", "tower"] as const;
export const INSURER_PAGES = ["tower", "now", "replay", "approvals", "portfolio", "sites", "alerts", "review", "system", "how"] as const;

/** Civil protection desk. Situation board first; its own approval queue; the shared how-it-works page. */
export const OPERATOR_PAGES = ["situation", "approvals", "how"] as const;

export type CitizenPage = (typeof CITIZEN_PAGES)[number];
export type InsurerPage = (typeof INSURER_PAGES)[number];
export type OperatorPage = (typeof OPERATOR_PAGES)[number];
export type PageId = CitizenPage | InsurerPage | OperatorPage;

export type DeskRoute =
  | { role: "citizen"; page: CitizenPage }
  | { role: "insurer"; page: InsurerPage }
  | { role: "operator"; page: OperatorPage };

export const DESK_NAV: {
  citizen: readonly { page: CitizenPage; label: string }[];
  insurer: readonly { page: InsurerPage; label: string }[];
  operator: readonly { page: OperatorPage; label: string }[];
} = {
  citizen: [
    { page: "now", label: "Now" },
    { page: "replay", label: "Replay" },
    { page: "overview", label: "Overview" },
    { page: "area", label: "My area" },
    { page: "actions", label: "What to do" },
    { page: "evidence", label: "Evidence" },
    { page: "how", label: "How it works" },
  ],
  insurer: [
    { page: "tower", label: "Control tower" },
    { page: "now", label: "Now" },
    { page: "replay", label: "Replay" },
    { page: "approvals", label: "Approvals" },
    { page: "portfolio", label: "Portfolio" },
    { page: "sites", label: "Sites / map" },
    { page: "alerts", label: "Alerts" },
    { page: "review", label: "Review" },
    { page: "system", label: "System" },
    { page: "how", label: "How it works" },
  ],
  operator: [
    { page: "situation", label: "Situation board" },
    { page: "approvals", label: "Approvals" },
    { page: "how", label: "How it works" },
  ],
};

/**
 * #36 hashes, so an old link lands on the page that now holds that content.
 * Insurer Sources has no page of its own. Its content is the Evidence drawer, which Review opens.
 */
const CITIZEN_ALIASES = new Map<string, CitizenPage>([
  ["place", "area"],
  ["rain", "area"],
]);
const INSURER_ALIASES = new Map<string, InsurerPage>([
  ["overview", "portfolio"],
  ["map", "sites"],
  ["point", "sites"],
  ["book", "portfolio"],
  ["sources", "review"],
]);

/** Collapse the left nav at the same width the layout already stacks. */
export const NAV_COLLAPSE_QUERY = "(max-width: 980px)";
/** Under this width the open nav is an overlay drawer, not a column. Matches the CSS breakpoint. */
export const NAV_DRAWER_QUERY = "(max-width: 760px)";

/** The insurer desk opens on Approvals while a decision is pending, else Portfolio. */
export function insurerHome(approvalPending: boolean): InsurerPage {
  return approvalPending ? "approvals" : "portfolio";
}

function hashBody(hash: string): string {
  const trimmed = hash.trim();
  const withoutMark = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return withoutMark.replace(/^\/+/, "").replace(/\/+$/, "");
}

function citizenPage(token: string): CitizenPage | null {
  return CITIZEN_PAGES.find((page) => page === token) ?? CITIZEN_ALIASES.get(token) ?? null;
}

function insurerPage(token: string): InsurerPage | null {
  return INSURER_PAGES.find((page) => page === token) ?? INSURER_ALIASES.get(token) ?? null;
}

/**
 * `#/role/page`. One segment is that desk's home: Overview for the citizen, `insurerHome` for the insurer.
 * An unknown page, or extra segments, is that desk's home. An empty hash or an unknown role is the insurer home.
 * `approvalPending` defaults to true, which is how every session starts: approval state lives in memory
 * (ConsoleContext) and resets on reload. Pass the persisted status here once approvals are persisted.
 */
export function parseHash(hash: string, approvalPending = true): DeskRoute {
  const home: DeskRoute = { role: "insurer", page: insurerHome(approvalPending) };
  const body = hashBody(hash);
  if (!body) return home;
  const parts = body.split("/");
  const role = parts[0];
  const token = parts.length === 2 ? parts[1] : null;
  if (role === "citizen") {
    return { role, page: (token !== null && citizenPage(token)) || "overview" };
  }
  if (role === "insurer") {
    return { role, page: (token !== null && insurerPage(token)) || home.page };
  }
  if (role === "operator") {
    return { role, page: (token !== null && OPERATOR_PAGES.find((page) => page === token)) || "situation" };
  }
  return home;
}

/** Citizen Overview and the operator Situation board keep the short hash. Every other page is `#/role/page`. */
export function routeHref(role: RoleId, page: PageId): string {
  if (role === "citizen" && page === "overview") return "#/citizen";
  if (role === "operator" && page === "situation") return "#/operator";
  return `#/${role}/${page}`;
}

export function pageLabel(route: DeskRoute): string {
  if (route.page === "tower") return route.role === "citizen" ? "How we watch" : "Control tower";
  const items: readonly { page: PageId; label: string }[] = DESK_NAV[route.role];
  return items.find((item) => item.page === route.page)?.label ?? route.page;
}
