// The hydrograph behind the overview: rain hanging from the top, the river
// answering after a lag with a steep rise and a slow recession.
import { s } from "./ui.js";

export function hydrograph() {
  const W = 1440, H = 900, N = 60, STEP = W / N;
  const rain = s("g", { class: "rain" });
  for (let i = 0; i < N; i++) {
    let hgt = 14 + 260 * Math.exp(-(((i - 21) / 5.5) ** 2)) + 110 * Math.exp(-(((i - 28) / 2.6) ** 2));
    hgt += 5 * (1 + Math.sin(i * 1.7));
    rain.append(s("rect", { x: (i * STEP + 5).toFixed(1), y: 0, width: (STEP - 10).toFixed(1), height: hgt.toFixed(1), rx: 3 }));
  }
  const pts = [];
  for (let k = 0; k <= N * 4; k++) {
    const i = k / 4;
    const width = i < 35 ? 4.2 : 10.5;
    const q = 46 + 520 * Math.exp(-(((i - 35) / width) ** 2));
    pts.push([i * STEP, H - 60 - q]);
  }
  const d = "M" + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L");
  const alertY = H - 60 - 300;
  const grad = s("linearGradient", { id: "flow", x1: 0, y1: 0, x2: 0, y2: 1 },
    s("stop", { offset: 0, "stop-color": "#4aa3ff", "stop-opacity": 0.26 }),
    s("stop", { offset: 1, "stop-color": "#4aa3ff", "stop-opacity": 0 }));
  return s("svg", { class: "hydro", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" },
    s("defs", {}, grad),
    rain,
    s("line", { class: "alert", x1: 0, y1: alertY, x2: W, y2: alertY }),
    s("path", { class: "area", d: `${d} L${W},${H} L0,${H} Z` }),
    s("path", { class: "river", d, pathLength: 1 }));
}
