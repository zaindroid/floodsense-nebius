// Small DOM and formatting helpers. Text always goes in as text, never as HTML:
// agent output and web snippets are untrusted.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG = "http://www.w3.org/2000/svg";
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) if (c) el.append(c);
  return el;
}

// Zetaris writes "2026-10-30 02:00:00.0", the API ISO; both are UTC.
export function when(value) {
  if (!value) return null;
  const t = Date.parse(String(value).replace(" ", "T").replace(/\.\d+$/, "").replace(/Z?$/, "Z"));
  return Number.isNaN(t) ? null : new Date(t);
}

export function clock(value) {
  const d = value instanceof Date ? value : when(value);
  return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

export function ago(value) {
  const d = value instanceof Date ? value : when(value);
  if (!d) return "";
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `${hours} h ago` : d.toLocaleDateString();
}

export function num(v, digits = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: digits }) : "–";
}

// A place's state: a three-step level and the word. Normal one step, Watch two, High three.
const LEVEL = { ok: 1, watch: 2, high: 3 };
export function status(word, tone) {
  const n = LEVEL[tone] || 0;
  return h("span", { class: `status ${tone}`.trim() },
    h("span", { class: "lv", "aria-hidden": "true" }, [1, 2, 3].map((i) => h("i", { class: i <= n ? "on" : null }))),
    word);
}

export function pill(text, tone = "") {
  return h("span", { class: `pill ${tone}`.trim(), text });
}

export function loading(text = "Loading…") {
  return h("p", { class: "muted", role: "status", text });
}

export function failure(error) {
  return h("p", { class: "err", role: "alert", text: `Could not load this right now. ${error?.message ?? ""}`.trim() });
}

export const WAVE = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 15c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/><path d="M2 20c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/><path d="M12 3v7"/><path d="M9 7l3 3 3-3"/></svg>`;

// replaceChildren that, like h(), flattens arrays and skips empty children.
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

// A level against its usual mark: 0 to twice usual, the usual line at the middle.
export function meter(ratio, tone, title) {
  const k = typeof ratio === "number" && Number.isFinite(ratio) ? Math.max(0.02, Math.min(1, ratio / 2)) : 0;
  return h("span", { class: `meter ${tone}`, title, role: "img", "aria-label": title },
    h("span", { class: "fill", style: `width:${(k * 100).toFixed(1)}%` }), h("span", { class: "usual" }));
}

// A half-circle dial with a needle. `usual` marks a reference value on the scale.
// The element gets set(value, text) so a live widget can move its needle.
export function dial({ value = 0, max = 1, text, label, tone = "water", usual = null }) {
  const R = 48, CX = 60, CY = 60;
  const at = (t) => [CX - R * Math.cos(Math.PI * t), CY - R * Math.sin(Math.PI * t)];
  const arc = (t) => { const [x0, y0] = at(0), [x1, y1] = at(t); return `M${x0},${y0} A${R},${R} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`; };
  const share = (v) => (typeof v === "number" && max > 0 ? Math.max(0, Math.min(1, v / max)) : 0);
  const fillArc = s("path", { class: "value", d: arc(0.001) });
  const needle = s("g", { class: "needle" }, s("line", { x1: CX, y1: CY, x2: CX - R + 14, y2: CY }), s("circle", { class: "hub", cx: CX, cy: CY, r: 4 }));
  const tick = usual == null ? null : (() => {
    const t = share(usual), [x0, y0] = at(t), c = Math.cos(Math.PI * t), sn = Math.sin(Math.PI * t);
    return s("line", { class: "usual", x1: x0 + 7 * c, y1: y0 + 7 * sn, x2: x0 - 7 * c, y2: y0 - 7 * sn });
  })();
  const readout = h("b", { text: text ?? "" });
  const el = h("figure", { class: `dial ${tone}` },
    s("svg", { viewBox: "0 0 120 68", "aria-hidden": "true" }, s("path", { class: "track", d: arc(1) }), fillArc, tick, needle),
    readout, h("figcaption", { text: label }));
  el.set = (v, t) => {
    const k = share(v);
    fillArc.setAttribute("d", arc(Math.max(0.001, k)));
    needle.style.transform = `rotate(${180 * k}deg)`;
    if (t != null) readout.textContent = t;
  };
  requestAnimationFrame(() => requestAnimationFrame(() => el.set(value)));
  return el;
}
