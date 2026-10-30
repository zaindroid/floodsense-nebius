import type { PlatformStatus } from "../api/platform";
import type { WebContext } from "../types/contract";
import { modelDisplay } from "./techTrace";

export const WEB_NOT_WARNING = "Web context, not an official warning";

/** One line per sponsor, each backed by the repo (docs/architecture/technical-highlights.md). */
export const WHY_SPONSOR: readonly (readonly [string, string])[] = [
  ["Nebius Token Factory", "one API for every model lane; swapping a model is a setting, not a code change."],
  ["NVIDIA Nemotron", "model sizes are mapped to lanes: a small one for fast answers, a larger one for deep reasoning."],
  ["Tavily", "live web evidence the Skeptic checks an answer against, shown as web context and never as a warning."],
  ["Zetaris", "governed SQL: agents read sensor and portfolio data only through Zetaris views and cite the query id."],
  ["Meterless", "memory (H-MEM) that learns only from approved answers; the World Model tracks which hypotheses the evidence still supports."],
];

export type ChipState = "on" | "off" | "unavailable" | "unknown";
export interface SponsorChip {
  id: "nebius" | "nemotron" | "tavily" | "zetaris" | "meterless";
  label: string;
  /** Second line: model ids, call count... Only what the status states. */
  detail: string | null;
  state: ChipState;
  title: string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const short = (id: string | undefined): string | null => (id ? modelDisplay(id).replace(/^Nemotron\s*/i, "") : null);

/** Pure: the global sponsor strip. `platform` null = /platform/status not reachable: every dot is "unavailable", never a guess. */
export function sponsorChips(platform: PlatformStatus | null, plain = false): SponsorChip[] {
  const chips = detailedChips(platform);
  if (!plain) return chips;
  // Citizen: plain names, no counts, model ids or sizes in text or tooltips.
  const PLAIN: Record<SponsorChip["id"], [string, string]> = {
    nebius: ["Nebius", "Runs the AI models."],
    nemotron: ["NVIDIA Nemotron", "The AI models that write the answers."],
    tavily: ["Tavily web check", "A web search that double-checks answers. Web context, not an official warning."],
    zetaris: ["Zetaris", "Reads the measurements and data."],
    meterless: ["Meterless", "Memory that learns only from approved answers."],
  };
  return chips.map((c) => ({ ...c, label: PLAIN[c.id][0], title: PLAIN[c.id][1], detail: null }));
}

function detailedChips(platform: PlatformStatus | null): SponsorChip[] {
  const down = (on: boolean): ChipState => (!platform ? "unavailable" : on ? "on" : "off");
  const t = platform?.tavilyStatus ?? null;
  const tavilyOn = t ? t.enabled : platform?.tavily === true;
  const fast = short(platform?.lanes.fast);
  const deep = short(platform?.lanes.deep);
  const models = [fast && `fast ${fast}`, deep && `deep ${deep}`].filter(Boolean).join(" · ");
  const nebius = platform?.llmBackend === "nebius";
  return [
    {
      id: "nebius",
      label: "Nebius Token Factory",
      detail: platform?.llmBackend && !nebius ? `backend: ${platform.llmBackend}` : null,
      state: down(nebius),
      title: "One API for every model lane. Swapping a model is a setting.",
    },
    {
      id: "nemotron",
      label: "NVIDIA Nemotron",
      detail: models || null,
      state: down(Object.keys(platform?.lanes ?? {}).length > 0),
      title: "Nemotron model sizes mapped to the fast and deep lanes.",
    },
    {
      id: "tavily",
      label: "Tavily",
      detail: !platform ? null : !tavilyOn ? "off" : t ? `${t.calls} ${t.calls === 1 ? "call" : "calls"}` : "on",
      state: down(tavilyOn),
      title: "Live web evidence checked by the Skeptic. Complements Zetaris, which runs SQL on sensor and portfolio data. Web context, not an official warning.",
    },
    {
      id: "zetaris",
      label: "Zetaris",
      detail: platform ? platform.dataBackend : null,
      state: down(platform?.dataBackend === "zetaris"),
      title: "Governed SQL over sensor and portfolio data.",
    },
    {
      id: "meterless",
      label: "Meterless H-MEM / World Model",
      detail: null,
      // /platform/status carries no memory or engine status, so the dot is honest grey (unknown), never the agents flag.
      state: platform ? "unknown" : "unavailable",
      title: "Memory that learns only from approved answers. Its status is not part of /platform/status.",
    },
  ];
}

export { regionBadge } from "./lanes";

/** Pure: lower case, German umlauts as ae/oe/ue/ss, other diacritics dropped ("Köln", "Koeln", "KOLN" -> koeln, koeln, koln). */
export const foldPlace = (s: string): string =>
  s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Pure: a plain, number-free phrase for how long ago an ISO time was; null when unparsable. */
export function agoPhrase(iso: string | null | undefined, now = Date.now()): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const min = (now - t) / 60_000;
  return min < 2 ? "just now" : min < 90 ? "a few minutes ago" : min < 24 * 60 ? "earlier today" : "a while ago";
}

export const usd = (v: number | null | undefined): string =>
  v === null || v === undefined ? "n/a" : v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(6).replace(/0+$/, "")}` : `$${v.toFixed(v < 1 ? 4 : 2)}`;

export const perM = (v: number | null | undefined): string => (v === null || v === undefined ? "n/a" : `$${v}`);

/** Pure: the Web check of a run. Reads the projected answer.web_context, else the raw agents body (web + web_check). */
export function webContextOf(raw: unknown): WebContext | null {
  const b = obj(raw);
  const direct = obj(obj(b.answer).web_context);
  const w = Object.keys(direct).length ? direct : obj(b.web);
  const status = w.status;
  if (status !== "ok" && status !== "empty" && status !== "unavailable") return null;
  const items = Array.isArray(w.results) ? w.results : Array.isArray(w.items) ? w.items : [];
  const results = items.flatMap((i) => {
    const o = obj(i);
    const url = text(o.url);
    return url ? [{ url, title: text(o.title) ?? url, retrieved_at: text(o.retrieved_at) ?? text(w.retrieved_at) }] : [];
  });
  const wcRaw = obj(direct.web_check ?? b.web_check);
  const v = wcRaw.verdict;
  return {
    status,
    query: text(w.query) ?? "",
    n_results: num(w.n_results) ?? results.length,
    latency_ms: num(w.latency_ms) ?? 0,
    cached: w.cached === true,
    retrieved_at: text(w.retrieved_at),
    results,
    ...(v === "supports" || v === "contradicts" || v === "neutral"
      ? { web_check: { claim_id: text(wcRaw.claim_id) ?? "", verdict: v, url: text(wcRaw.url) ?? "", note: text(wcRaw.note) ?? undefined } }
      : {}),
  };
}

export const VERDICT_WORD = { supports: "confirmed", contradicts: "conflicts", neutral: "not confirmed" } as const;

export interface WebCheckView {
  headline: string;
  /** Detail line for insurer/operator; the citizen desk never shows it. */
  detail: string | null;
  verdict: string | null;
  links: { url: string; title: string }[];
  retrievedAt: string | null;
}

/** Pure: the Web check row. `null` run data -> the honest empty state. */
export function webCheckView(web: WebContext | null): WebCheckView {
  if (!web) return { headline: "No web check in the run shown.", detail: null, verdict: null, links: [], retrievedAt: null };
  const verdict = web.web_check ? VERDICT_WORD[web.web_check.verdict] : null;
  const headline =
    web.status === "unavailable"
      ? "The web search was not available for this run."
      : web.status === "empty"
        ? "The web search found nothing for this run."
        : verdict
          ? { confirmed: "A web report supports this.", conflicts: "A web report conflicts with this.", "not confirmed": "No clear web confirmation." }[verdict]
          : "A web search ran for this run.";
  const lat = web.latency_ms > 0 ? `${web.latency_ms} ms` : "latency n/a";
  return {
    headline,
    detail: `${web.status} · ${web.n_results} ${web.n_results === 1 ? "result" : "results"} · ${lat}${web.cached ? " · cached" : ""}`,
    verdict,
    links: web.results.slice(0, 3).map((r) => ({ url: r.url, title: r.title })),
    retrievedAt: web.retrieved_at ?? null,
  };
}
