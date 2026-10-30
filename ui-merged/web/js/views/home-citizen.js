// Citizen home: one question, "is the river near me safe?", answered for one place
// in plain words, with what to do. No dashboards.
import { makeMap, tone } from "../map.js";
import { make3d } from "../map3d.js";
import { hydrograph } from "../hydro.js";
import { STATE, bySeverity, loadPlaces } from "../places.js";
import { ago, dial, fill, h, num, status } from "../ui.js";

const TODO = {
  normal: ["Nothing to do right now.", "Check again if heavy rain is forecast."],
  watch: ["Keep an eye on local news and official warnings.", "Know how you would leave if water rises.", "Move valuables up from cellars and ground floors."],
  high: ["Follow the official warnings for your area now.", "Keep away from riverbanks, underpasses and cellars.", "If you are told to leave, leave. In an emergency call 112."],
  unknown: ["Follow the official warnings for your area."],
};
const PICKS = ["Köln", "Dresden", "Paiporta", "Paris", "Budapest"];

export function homeCitizen(root) {
  const input = h("input", { type: "search", class: "big-search", placeholder: "Your town or river", "aria-label": "Your town or river", autocomplete: "off" });
  const suggest = h("ul", { class: "suggest", role: "listbox", hidden: true });
  const result = h("div", { "aria-live": "polite" });
  const elevated = h("div");
  const picks = h("div", { class: "picks" });
  let all = [];

  root.append(
    h("section", { class: "c-hero" },
      hydrograph(),
      h("div", { class: "c-hero-in" },
        h("h1", { text: "Is the river near you safe?" }),
        h("p", { text: "Type your town or river. You get a plain answer, what to do, and where the number came from." }),
        h("div", { class: "search-wrap" }, input, suggest),
        picks)),
    result,
    h("section", { class: "section" }, elevated),
    h("aside", { class: "help-strip" },
      h("b", { text: "In an emergency, call 112." }),
      h("span", {}, "FloodSense is not an official warning service. Official warnings across Europe: ",
        h("a", { href: "https://meteoalarm.org", target: "_blank", rel: "noopener noreferrer", text: "Meteoalarm" }),
        ". Germany: your Land's flood service and the NINA app. Spain: AEMET and ES-Alert.")));

  let m3 = null;
  const choose = async (p) => {
    input.value = p.place;
    suggest.hidden = true;
    m3?.map.destroy();
    m3 = null;
    const card = placeCard(p);
    fill(result, card);
    const slot = card.querySelector(".c-map");
    if (slot) {
      const made = await make3d(slot, (pin) => [placePin(pin, p)], { ariaLabel: `Map of ${p.place}`, columnDeg: 0.004, attribution: "FloodSense", focusIds: [] });
      if (made && result.contains(slot)) m3 = made; else if (made) made.map.destroy();
      if (!made) {
        // No WebGL or bundle: the same place on a plain Leaflet map.
        const m = await makeMap(slot, [[p.lat - 0.05, p.lon - 0.05], [p.lat + 0.05, p.lon + 0.05]]).catch(() => null);
        if (!m) return slot.remove();
        if (!result.contains(slot)) return m.map.remove();
        const c = tone({ normal: "ok", watch: "watch", high: "watch" }[p.state] || "faint");
        m.L.circleMarker([p.lat, p.lon], { radius: 8, weight: 1.5, color: c, fillColor: c, fillOpacity: 0.7 }).bindTooltip(`${p.place}: ${STATE[p.state].word}`).addTo(m.map);
        m3 = { map: { destroy: () => m.map.remove() } };
      }
    }
    result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const match = (q) => all.filter((p) => `${p.place} ${p.where}`.toLowerCase().includes(q.toLowerCase())).sort(bySeverity);
  input.addEventListener("input", () => {
    const q = input.value.trim();
    const found = q ? match(q).slice(0, 6) : [];
    suggest.hidden = !found.length;
    suggest.replaceChildren(...found.map((p) => h("li", {},
      h("button", { type: "button", onclick: () => choose(p) }, h("b", { text: p.place }), h("span", { text: p.where })))));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const first = match(input.value.trim())[0];
    if (first) choose(first);
  });

  loadPlaces().then((list) => {
    all = list;
    picks.replaceChildren(h("span", { class: "muted small", text: "Or try" }),
      ...PICKS.map((n) => list.find((p) => p.place === n)).filter(Boolean).map((p) =>
        h("button", { class: "chip", type: "button", onclick: () => choose(p) }, p.place)));
    const up = list.filter((p) => p.state === "watch" || p.state === "high").sort(bySeverity);
    fill(elevated, up.length
      ? [h("h2", { text: "Higher than usual right now" }),
        h("div", { class: "c-list" }, up.map((p) => h("button", { class: "c-item", type: "button", onclick: () => choose(p) },
          status(STATE[p.state].word, STATE[p.state].tone), h("b", { text: p.place }), h("span", { text: p.where }))))]
      : h("p", { class: "muted", text: "Every watched river is at its usual level right now." }));
  }).catch(() => fill(elevated, h("p", { class: "err", text: "The river data is unavailable right now. Try again in a minute." })));
  return () => m3?.map.destroy();
}

// One calm pin: colour = state band. The Citizen view never shows the red alert pin.
function placePin(pin, p) {
  const base = { id: p.place, lat: p.lat, lon: p.lon, label: `${p.place}: ${STATE[p.state].word}, ${p.value}` };
  // Calm: always the amber band path, never the red alert pin.
  return pin(base, { band: { normal: "low", watch: "elevated", high: "peak" }[p.state] || null });
}

function placeCard(p) {
  const st = STATE[p.state];
  const ask = `Is ${p.place} at risk of flooding right now?`;
  return h("section", { class: `c-card ${st.tone}` },
    h("div", { class: "c-card-head" },
      h("div", {}, h("h2", { text: p.place }), h("span", { class: "muted", text: p.where })),
      status(st.word, st.tone)),
    h("p", { class: "c-say", text: st.plain }),
    p.ratio == null ? null : h("div", { class: "c-dial" },
      dial({ value: p.ratio, max: 3, usual: 1, tone: st.tone, text: `${num(p.ratio, 1)}×`, label: `compared with ${p.usual} (the mark)` })),
    p.lat == null ? null : h("div", { class: "c-map map", style: "height:16rem;border-radius:12px;overflow:hidden;margin-top:1rem" }),
    h("h3", { text: "What to do" }),
    h("ul", { class: "todo" }, TODO[p.state].map((t) => h("li", { text: t }))),
    h("p", { class: "c-source" }, `${p.value} from ${p.source.toLowerCase()}, ${ago(p.at)}. `,
      h("a", { href: `#/ask/${encodeURIComponent(ask)}`, text: "Ask about this place" })));
}
