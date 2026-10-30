// The 3D map (React + MapLibre, from ui/src/embed/map3d.tsx), loaded on first use.
// Every caller falls back to the Leaflet map when this returns null (no WebGL, script failed).
let loading = null;

function load() {
  if (window.FloodMap3D) return Promise.resolve(window.FloodMap3D);
  loading ||= new Promise((ok, fail) => {
    const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "vendor/style.css" });
    const js = Object.assign(document.createElement("script"), { src: "vendor/map3d.js", onload: () => ok(window.FloodMap3D), onerror: fail });
    document.head.append(css, js);
  });
  return loading;
}

const webgl = () => {
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
};

/** Mounts the 3D map in `el`. Returns {api, map} ({map}: update/destroy) or null to fall back. `points` get built with `api.pin`. */
export async function make3d(el, build, opts) {
  try {
    if (!webgl()) return null;
    const api = await load();
    if (!api) return null;
    return { api, map: api.mount(el, { ...opts, points: build(api.pin) }) };
  } catch { return null; }
}
