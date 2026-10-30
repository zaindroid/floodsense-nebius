// Civil-protection home: an operations board. The situation in one strip, the map,
// the places to act on first, and what the watch noticed, refreshed every minute.
import { get } from "../api.js";
import { makeMap, tone } from "../map.js";
import { make3d } from "../map3d.js";
import { STATE, bySeverity, loadPlaces } from "../places.js";
import { ago, clock, dial, fill, h, loading, num, status } from "../ui.js";

const RADIUS = { high: 10, watch: 8, normal: 5, unknown: 4 };
const COLOUR = { high: "high", watch: "watch", normal: "ok", unknown: "faint" };

export function homeCivil(root) {
  const strip = h("div", { class: "ops-strip" }, loading("Reading the situation…"));
  const queue = h("div", { class: "ops-queue" });
  const feed = h("ol", { class: "ops-feed" });
  const mapEl = h("div", { class: "map tall", role: "img", "aria-label": "Map of every watched place, coloured by state" });
  const highest = h("div", { class: "widget-slot" });
  const countdown = dial({ value: 0, max: 1, text: "–", label: "until the next check" });

  root.append(
    h("header", { class: "ops-head" },
      h("h1", { text: "Situation" }),
      h("span", { class: "ops-clock" })),
    strip,
    h("div", { class: "ops-grid" },
      h("section", { class: "card flush" }, mapEl,
        h("div", { class: "map-key" }, ["high", "watch", "normal"].map((k) =>
          h("span", {}, h("i", { class: `k-${k}` }), STATE[k].word + ({ high: " (measured gauge)", watch: " (or high, river model)" }[k] || ""))))),
      h("div", { class: "ops-side" },
        h("section", { class: "card widget-pair" }, highest, countdown),
        h("section", { class: "card" }, h("div", { class: "section-head" }, h("h2", { text: "Act first" }), h("a", { href: "#/watch", text: "Every place" })), queue),
        h("section", { class: "card" }, h("h2", { text: "What the watch noticed" }), feed))));

  let map = null, L = null, layer = null, stopped = false, m3 = null, tried = false;
  const BAND = { normal: "low", watch: "elevated", high: "peak" };
  // Red only for a live measured gauge above its high water (group "germany"); model places stay amber.
  const pins = (all) => (pin) => all.filter((p) => p.lat != null).map((p) => {
    const base = { id: `${p.group}:${p.place}:${p.where}`, lat: p.lat, lon: p.lon, label: `${p.place}, ${p.where}: ${STATE[p.state].word}, ${p.value}` };
    if (p.group === "germany") return pin(base, { status: { normal: "ok", watch: "near", high: "over" }[p.state] || "unknown", measured: true });
    return pin(base, { band: BAND[p.state] || null });
  });
  let next = null, cycle = 900; // the watch loop's next check, and its interval in seconds
  const tick = () => { root.querySelector(".ops-clock").textContent = `${new Date().toISOString().slice(11, 16)} UTC`; };
  // The countdown to the watch loop's next check, every second.
  const seconds = setInterval(() => {
    if (!next) return;
    const left = Math.max(0, Math.round((next - Date.now()) / 1000));
    countdown.set(1 - left / cycle, left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "now");
  }, 1000);
  tick();

  async function draw() {
    const [all, w, events] = await Promise.all([loadPlaces(), get("/watch/status").catch(() => null), get("/watch/events?limit=10").catch(() => null)]);
    if (stopped) return;
    const count = (k) => all.filter((p) => p.state === k).length;
    fill(strip,
      cell(count("high"), "High", "high"), cell(count("watch"), "Watch", "watch"), cell(count("normal"), "Normal", "ok"),
      cell(num(w?.counts?.awaiting_approval ?? 0), "Notices to sign off", "", "#/decide"),
      cell(ago(w?.last_cycle?.finished_at) || "–", `Last check of ${num(w?.counts?.sources ?? all.length)} sources`));
    const first = all.filter((p) => p.state === "high" || p.state === "watch").sort(bySeverity);
    const top = [...all].filter((p) => p.ratio != null).sort((a, b) => b.ratio - a.ratio)[0];
    if (top) fill(highest, dial({ value: top.ratio, max: 4, usual: 1, tone: STATE[top.state].tone, text: `${num(top.ratio, 1)}×`, label: `highest now: ${top.place}, ${top.where}` }));
    cycle = w?.loop?.interval_s || cycle;
    next = Date.parse(w?.loop?.next_cycle_at || "") || (Date.parse(w?.last_cycle?.finished_at || "") + cycle * 1000) || null;
    fill(queue, first.length
      ? h("ol", { class: "q-list" }, first.map((p) => h("li", {},
        status(STATE[p.state].word, STATE[p.state].tone),
        h("div", {}, h("b", { text: p.place }), h("span", { class: "muted small", text: ` ${p.where}` })),
        h("span", { class: "q-val", text: p.ratio != null ? `${num(p.ratio, 1)}×` : p.value }))))
      : h("p", { class: "muted", text: "Nothing is above its usual level." }));
    fill(feed, (events?.events || []).map((e) => h("li", { class: e.tone || "" }, h("time", { text: clock(e.ts) }), h("span", { text: e.text }))));

    if (!tried) {
      tried = true;
      m3 = await make3d(mapEl, pins(all), { ariaLabel: "Map of every watched place, coloured by state", columnDeg: 0.08, attribution: "Gauges and river models" });
      if (stopped) return m3?.map.destroy();
      // The 3D pins are not the legend's dots: amber and green by band, red only for a live gauge above its usual high water.
      if (m3) mapEl.parentElement.querySelector(".map-key").replaceChildren(h("span", { class: "muted", text: "Pin colour: green normal, amber watch or high from a river model. Red: a live gauge measured above its usual high water." }));
    }
    if (m3) return m3.map.update({ points: pins(all)(m3.api.pin) });
    if (!map) {
      const m = await makeMap(mapEl, [[36, -9], [55, 24]]).catch(() => null);
      if (!m || stopped) return;
      ({ map, L } = m);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    for (const p of [...all].filter((p) => p.lat != null).sort((a, b) => STATE[a.state].rank - STATE[b.state].rank)) {
      // Red only for a measured gauge; a model place at "high" stays amber.
      const c = tone(p.group !== "germany" && p.state === "high" ? "watch" : COLOUR[p.state]);
      L.circleMarker([p.lat, p.lon], { radius: RADIUS[p.state], weight: 1.5, color: c, fillColor: c, fillOpacity: p.state === "normal" ? 0.35 : 0.7 })
        .bindTooltip(`${p.place}, ${p.where}: ${STATE[p.state].word}, ${p.value}`).addTo(layer);
    }
  }
  draw().catch(() => fill(strip, h("p", { class: "err", text: "The situation is unavailable right now." })));
  const timer = setInterval(() => { tick(); draw().catch(() => {}); }, 60000);
  return () => { stopped = true; clearInterval(timer); clearInterval(seconds); map?.remove(); m3?.map.destroy(); };
}

function cell(value, label, toneName = "", href) {
  const inner = [h("b", { class: toneName, text: String(value) }), h("span", { text: label })];
  return href ? h("a", { class: "ops-cell link", href }, inner) : h("div", { class: "ops-cell" }, inner);
}
