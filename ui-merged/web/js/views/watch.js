import { get } from "../api.js";
import { ROLES, role } from "../roles.js";
import { STATE, bySeverity, places, titled } from "../places.js";
import { ago, clock, failure, fill, h, loading, meter, num, status } from "../ui.js";

const GROUPS = { all: "All places", germany: "Germany", europe: "Rest of Europe", valencia: "Valencia" };
const euros = (v) => `€${num(v / 1e6)}M`;

export function watch(root) {
  const who = role();
  const r = ROLES[who];
  const body = h("div", {}, loading("Reading the live sources…"));
  root.append(h("header", { class: "page-head" }, h("h1", { text: r.watchTitle }), h("p", { text: r.watchIntro })), body);

  Promise.all([
    get("/views/gauge_levels"), get("/views/eu_watch"), get("/views/hazard_now"),
    get("/watch/status").catch(() => null), get("/watch/events?limit=8").catch(() => null),
    who === "insurer" ? get("/views/exposure_join").catch(() => null) : null,
  ])
    .then(([gauges, eu, hazard, st, events, sites]) => {
      const all = places(gauges, eu, hazard);
      if (who === "citizen") return citizen(body, all);
      if (who === "insurer") return insurer(body, all, sites || []);
      return civil(body, all, st, events?.events || []);
    })
    .catch((e) => body.replaceChildren(failure(e)));
}

// ---------- citizen: find your place, read it in plain words ----------
function citizen(body, all) {
  const search = h("input", { type: "search", class: "search", placeholder: "Type your town or river", "aria-label": "Find your town or river" });
  const list = h("div", { class: "rows" });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = all.filter((p) => !q || `${p.place} ${p.where}`.toLowerCase().includes(q)).sort(bySeverity);
    list.replaceChildren(...(shown.length ? shown.map(plainRow) : [h("p", { class: "empty", text: "No watched place matches. Try the river's name." })]));
  };
  search.addEventListener("input", draw);
  draw();
  fill(body,
    h("div", { class: "advice" },
      h("b", { text: "FloodSense is not an official warning service." }),
      h("p", {},
        "For official warnings across Europe see ",
        h("a", { href: "https://meteoalarm.org", target: "_blank", rel: "noopener noreferrer", text: "Meteoalarm" }),
        ". In Germany use your Land's flood service and the NINA app; in Spain, AEMET and ES-Alert. In an emergency, call 112.")),
    h("div", { class: "section" }, search, h("div", { style: "height:1rem" }), list));
}

function plainRow(p) {
  const st = STATE[p.state];
  return h("div", { class: "row plain-row" },
    h("div", { class: "place" }, h("b", { text: p.place }), h("span", { text: p.where })),
    h("div", { class: "val" }, h("span", { class: "plain", text: st.plain }),
      p.ratio == null ? null : meter(p.ratio, st.tone, `${num(p.ratio, 1)}× ${p.usual}; the middle line is usual`),
      h("small", { text: `${p.value}, ${p.source.toLowerCase()}, ${ago(p.at)}` })),
    status(st.word, st.tone));
}

// ---------- insurer: the insured sites first ----------
function insurer(body, all, sites) {
  fill(body,
    sites.length ? portfolio(sites) : null,
    h("div", { class: "section" }, h("h2", { text: "Rivers near your sites, then everywhere" }), placeList(all, "valencia")));
}

function portfolio(sites) {
  const hit = sites.filter((s) => s.in_footprint);
  const sum = (list) => list.reduce((n, s) => n + (s.sum_insured_eur || 0), 0);
  const segments = [...new Set(sites.map((s) => s.segment))].sort();
  const bar = (part, whole) => h("span", { class: "share" }, h("span", { style: `width:${((part / (whole || 1)) * 100).toFixed(1)}%` }));
  return h("section", { class: "card portfolio" },
    h("div", { class: "pf-head" },
      h("p", { class: "pf-big" }, h("b", { text: num(hit.length) }), ` of ${num(sites.length)} insured sites sit inside the Valencia 2024 flood footprint.`),
      h("a", { class: "btn primary", href: "#/ask" }, "Ask why they are at risk")),
    h("div", { class: "pf-rows" },
      h("div", { class: "pf-row total" }, h("span", { text: "All sites" }), bar(hit.length, sites.length),
        h("span", { text: `${num(hit.length)} of ${num(sites.length)}` }), h("span", { text: `${euros(sum(hit))} of ${euros(sum(sites))}` })),
      segments.map((seg) => {
        const own = sites.filter((s) => s.segment === seg);
        const ownHit = own.filter((s) => s.in_footprint);
        return h("div", { class: "pf-row" }, h("span", { text: titled(seg) }), bar(ownHit.length, own.length),
          h("span", { text: `${num(ownHit.length)} of ${num(own.length)}` }), h("span", { text: `${euros(sum(ownHit))} of ${euros(sum(own))}` }));
      })),
    h("p", { class: "muted small", style: "margin:1rem 0 0", text: "Synthetic demo sites. The footprint is the Copernicus EMS mapping EMSR773 of the Valencia flood, October 2024." }));
}

// ---------- civil protection: where to act first ----------
function civil(body, all, st, events) {
  const first = all.filter((p) => p.state === "high" || p.state === "watch").sort(bySeverity);
  fill(body,
    h("section", {},
      h("h2", { text: first.length ? `Act first (${first.length})` : "Nothing above its usual level" }),
      first.length ? h("div", { class: "act-first" }, first.map(card)) : null),
    h("div", { class: "section" }, spread(all)),
    h("div", { class: "section" }, h("h2", { text: "Every place" }), placeList(all, "all")),
    events.length ? h("section", { class: "section card" },
      h("h2", { text: "What the watch noticed" }),
      h("div", { class: "feed" }, events.slice(0, 8).map((e) =>
        h("div", { class: "feed-item" }, h("time", { text: clock(e.ts) }), h("div", {}, h("span", { text: e.text })))))) : null,
    st?.counts ? h("p", { class: "muted small", style: "margin-top:1rem" },
      `The watch checks ${st.counts.sources} sources every 15 minutes; last run ${ago(st.last_cycle?.finished_at)}.`) : null);
}

function card(p) {
  const st = STATE[p.state];
  return h("div", { class: `pcard ${st.tone}` },
    h("div", { class: "pcard-top" }, h("b", { text: p.place }), status(st.word, st.tone)),
    h("span", { class: "muted small", text: p.where }),
    h("div", { class: "pcard-val" }, p.value, h("small", { text: p.ratio != null ? ` ${num(p.ratio, 1)}× ${p.usual}` : "" })),
    p.ratio == null ? null : meter(p.ratio, st.tone, `${num(p.ratio, 1)}× ${p.usual}; the middle line is usual`),
    h("span", { class: "faint small", text: `${p.source}, ${ago(p.at)}` }));
}

// ---------- shared ----------
function placeList(all, start) {
  let group = start;
  const list = h("div", { class: "rows" });
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter places" });
  const draw = () => {
    chips.replaceChildren(...Object.entries(GROUPS).map(([k, label]) =>
      h("button", { class: "chip", type: "button", "aria-pressed": String(k === group), onclick: () => { group = k; draw(); } },
        `${label} (${k === "all" ? all.length : all.filter((p) => p.group === k).length})`)));
    list.replaceChildren(...all.filter((p) => group === "all" || p.group === group).sort(bySeverity).map(row));
  };
  draw();
  return h("div", {}, chips, h("div", { style: "height:1rem" }), list);
}

function row(p) {
  const st = STATE[p.state];
  const trend = p.trend === null ? null : p.trend > 0 ? `rising ${num(p.trend)} cm/h` : p.trend < 0 ? `falling ${num(-p.trend)} cm/h` : "steady";
  return h("div", { class: "row" },
    h("div", { class: "place" }, h("b", { text: p.place }), h("span", { text: p.where })),
    h("div", { class: "val" }, p.value, " ", h("small", { text: [p.detail, trend].filter(Boolean).join(", ") }),
      p.ratio == null ? null : meter(p.ratio, st.tone, `${num(p.ratio, 1)}× ${p.usual}; the middle line is usual`)),
    h("div", { class: "src", text: p.source }),
    status(st.word, st.tone));
}

// How the places split across Normal, Watch and High, as one bar.
function spread(all) {
  const parts = ["normal", "watch", "high"].map((k) => [k, all.filter((p) => p.state === k).length]);
  return h("div", { class: "card spread" },
    h("div", { class: "bar", role: "img", "aria-label": parts.map(([k, n]) => `${n} ${STATE[k].word}`).join(", ") },
      parts.filter(([, n]) => n).map(([k, n]) => h("span", { class: STATE[k].tone, style: `flex:${n}` }))),
    h("div", { class: "bar-key" }, parts.map(([k, n]) =>
      h("span", { class: STATE[k].tone }, h("b", { text: String(n) }), STATE[k].word))));
}
