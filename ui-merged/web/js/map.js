// A map for the insurer and civil-protection homes: Leaflet, loaded on first use,
// on OpenStreetMap tiles that the dark theme darkens.
const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/";
let loading = null;

function leaflet() {
  if (window.L) return Promise.resolve(window.L);
  loading ||= new Promise((ok, fail) => {
    const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `${LEAFLET}leaflet.css` });
    const js = Object.assign(document.createElement("script"), { src: `${LEAFLET}leaflet.js`, onload: () => ok(window.L), onerror: fail });
    document.head.append(css, js);
  });
  return loading;
}

/** A map in `el`, fitted to `bounds` ([[lat, lon], [lat, lon]]). */
export async function makeMap(el, bounds) {
  const L = await leaflet();
  const map = L.map(el, { zoomControl: true, scrollWheelZoom: false, attributionControl: true });
  // OpenStreetMap's own tiles need no key; the dark theme darkens them in CSS.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.fitBounds(bounds, { padding: [24, 24] });
  return { L, map };
}

/** The colour behind a token, for Leaflet's circle markers. */
export const tone = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
