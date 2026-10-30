// Insurer home: an exposure desk. Numbers first, the sites on a map, the largest
// exposures, and the actions waiting for sign-off.
import { get } from "../api.js";
import { makeMap, tone } from "../map.js";
import { make3d } from "../map3d.js";
import { titled } from "../places.js";
import { ago, dial, fill, h, loading, num } from "../ui.js";

const euros = (v) => `€${num(v / 1e6, v < 1e7 ? 1 : 0)}M`;
const sum = (list) => list.reduce((n, s) => n + (s.sum_insured_eur || 0), 0);

export function homeInsurer(root) {
  const body = h("div", {}, loading("Loading your insured sites…"));
  root.append(
    h("header", { class: "desk-head" },
      h("div", {}, h("h1", { text: "Flood exposure" }),
        h("p", { class: "muted", text: "Valencia flood, October 2024 (Copernicus EMS EMSR773), against your insured sites." })),
      h("div", { class: "desk-actions" },
        h("a", { class: "btn ghost", href: "#/decide" }, "Review actions"),
        h("a", { class: "btn primary", href: `#/ask/${encodeURIComponent("Why are our Valencia sites at risk?")}` }, "Ask why they are at risk"))),
    body);

  let map = null, m3 = null, gone = false;
  Promise.all([get("/views/exposure_join"), get("/watch/status").catch(() => null)]).then(async ([sites, w]) => {
    const hit = sites.filter((s) => s.in_footprint);
    const segments = [...new Set(sites.map((s) => s.segment))].sort();
    const top = [...hit].sort((a, b) => b.sum_insured_eur - a.sum_insured_eur).slice(0, 8);
    const mapEl = h("div", { class: "map pins-only", role: "img", "aria-label": `Map of ${sites.length} insured sites around Valencia, ${hit.length} inside the flood footprint` });

    fill(body,
      h("div", { class: "widgets" },
        h("div", { class: "widget" }, dial({ value: hit.length, max: sites.length, tone: "high", text: `${num(hit.length)} / ${num(sites.length)}`, label: "sites inside the footprint" })),
        h("div", { class: "widget" }, dial({ value: sum(hit), max: sum(sites), tone: "watch", text: `${Math.round((sum(hit) / sum(sites)) * 100)}%`, label: `of insured value exposed, ${euros(sum(hit))}` })),
        h("div", { class: "widget" }, (() => {
          const ind = sites.filter((s) => s.segment === "industrial"), indHit = ind.filter((s) => s.in_footprint);
          return dial({ value: indHit.length, max: ind.length, tone: "high", text: `${num(indHit.length)} / ${num(ind.length)}`, label: "industrial sites hit" });
        })()),
        tile(num(w?.counts?.awaiting_approval ?? 0), "actions waiting for sign-off", "#/decide")),
      h("div", { class: "desk-grid" },
        h("section", { class: "card flush" }, mapEl,
          h("div", { class: "map-key" },
            h("span", {}, h("i", { class: "k-in" }), "Inside the footprint"),
            h("span", {}, h("i", { class: "k-out" }), "Outside"),
            h("span", { class: "muted", text: "Dot size: sum insured" }))),
        h("section", { class: "card" },
          h("h2", { text: "Largest exposures" }),
          h("table", { class: "tbl" },
            h("thead", {}, h("tr", {}, h("th", { text: "Policy" }), h("th", { text: "Segment" }), h("th", { class: "num", text: "Sum insured" }))),
            h("tbody", {}, top.map((s) => h("tr", {},
              h("td", { text: s.policy_id }), h("td", { text: titled(s.segment) }), h("td", { class: "num", text: euros(s.sum_insured_eur) }))))))),
      h("section", { class: "card section" },
        h("h2", { text: "By segment" }),
        h("div", { class: "pf-rows" }, segments.map((seg) => {
          const own = sites.filter((s) => s.segment === seg);
          const ownHit = own.filter((s) => s.in_footprint);
          return h("div", { class: "pf-row" }, h("span", { text: titled(seg) }),
            h("span", { class: "share" }, h("span", { style: `width:${((ownHit.length / own.length) * 100).toFixed(1)}%` })),
            h("span", { text: `${num(ownHit.length)} of ${num(own.length)}` }), h("span", { text: `${euros(sum(ownHit))} of ${euros(sum(own))}` }));
        }))),
      h("p", { class: "muted small", text: `Synthetic demo sites. River data last checked ${ago(w?.last_cycle?.finished_at) || "recently"}.` }));

    // 3D first; the pin colour is the footprint (observed, Copernicus EMS), amber and never red, grey outside.
    m3 = await make3d(mapEl, (pin) => sites.map((s) => pin(
      { id: s.policy_id, lat: s.lat, lon: s.lon, label: `${s.policy_id}, ${titled(s.segment)}, ${euros(s.sum_insured_eur)}${s.in_footprint ? ", inside the footprint" : ", outside the footprint"}` },
      { band: s.in_footprint ? "peak" : null })), { ariaLabel: `Map of ${sites.length} insured sites around Valencia`, columnDeg: 0.004, attribution: "Copernicus EMS" });
    if (gone) return m3?.map.destroy();
    if (m3) return mapEl.parentElement.querySelector(".map-key").replaceChildren(h("span", { class: "muted", text: "Amber pin: inside the observed flood footprint (Copernicus EMS). Grey: outside. Colour only, not a risk score." }));

    const lats = sites.map((s) => s.lat), lons = sites.map((s) => s.lon);
    const m = await makeMap(mapEl, [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]]).catch(() => null);
    if (!m) return mapEl.replaceChildren(h("p", { class: "muted", style: "padding:1rem", text: "The map could not load." }));
    map = m.map;
    const max = Math.max(...sites.map((s) => s.sum_insured_eur));
    for (const s of [...sites].sort((a, b) => a.in_footprint - b.in_footprint)) {
      m.L.circleMarker([s.lat, s.lon], {
        radius: 3 + 7 * Math.sqrt(s.sum_insured_eur / max), weight: 1,
        color: s.in_footprint ? tone("high") : tone("faint"), fillColor: s.in_footprint ? tone("high") : tone("faint"),
        fillOpacity: s.in_footprint ? 0.55 : 0.25,
      }).bindTooltip(`${s.policy_id}, ${titled(s.segment)}, ${euros(s.sum_insured_eur)}${s.in_footprint ? ", inside the footprint" : ""}`).addTo(map);
    }
  }).catch(() => fill(body, h("p", { class: "err", text: "The insured sites are unavailable right now." })));

  return () => { gone = true; map?.remove(); m3?.map.destroy(); };
}

function tile(value, label, href) {
  const inner = [h("b", { text: value }), h("span", { text: label })];
  return href ? h("a", { class: "tile link", href }, inner) : h("div", { class: "tile" }, inner);
}
