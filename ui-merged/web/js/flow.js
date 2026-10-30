// The live flow: the agents in a row, Nebius (model calls) above, Zetaris (data)
// below. A running question is followed through its own event stream; between
// questions the latest run is replayed from its trace, and says so.
import { get, streamRun } from "./api.js";
import { clock, fill, h, num, s } from "./ui.js";
import { step } from "./views/ask.js";

const ROW = 232, TOP = ROW - 28, BOTTOM = ROW + 28;
const NEB = 30, ZET = 362, RAIL = 40;
const AGENTS = [
  ["scope", "Scope", "Reads the question"],
  ["watch", "Watchers", "Read the sources"],
  ["investigator", "Investigator", "Explains it"],
  ["skeptic", "Skeptic", "Tries to disprove"],
  ["exposure", "Exposure", "Finds what's at risk"],
  ["playbook", "Playbook", "Proposes actions"],
  ["judge", "Judge", "Checks each claim"],
  ["person", "You", "Approve or reject"],
];
const X = Object.fromEntries(AGENTS.map(([id], i) => [id, 200 + i * 120]));
const SAT = { memory: [380, 146, "Memory"], web: [500, 146, "Web news"] };
const SOURCES = [["German gauges", 286], ["River forecasts", 330], ["Rain models", 374]];

// Trace node -> place in the picture.
const MAP = {
  scope: "scope", escalate: "scope", watchers: "watch", live_watch: "watch", forecast_data: "watch", history: "watch",
  memory: "memory", tavily: "web", investigator: "investigator", quick_answer: "investigator", forecast_answer: "investigator",
  revise: "investigator", skeptic: "skeptic", exposure: "exposure", playbook: "playbook",
  judge: "judge", quick_judge: "judge", forecast_judge: "judge", hitl: "person", learn: "memory",
};
const THINKS = new Set(["investigator", "quick_answer", "forecast_answer", "skeptic", "playbook", "judge", "quick_judge", "forecast_judge"]);

const P = {
  up: (id) => `M${X[id]},${TOP} L${X[id]},${NEB + RAIL}`,
  down: (id) => `M${X[id]},${NEB + RAIL} L${X[id]},${TOP}`,
  data: (id) => `M${X[id]},${ZET} L${X[id]},${BOTTOM}`,
  hop: (a, b) => X[b] > X[a]
    ? `M${X[a] + 50},${ROW} L${X[b] - 50},${ROW}`
    : `M${X[a]},${BOTTOM} C${X[a]},${BOTTOM + 46} ${X[b]},${BOTTOM + 46} ${X[b]},${BOTTOM}`,
  memory: `M${SAT.memory[0] + 18},${SAT.memory[1] + 13} Q${X.investigator - 34},${ROW - 52} ${X.investigator - 22},${TOP}`,
  web: `M${SAT.web[0] - 18},${SAT.web[1] + 13} Q${X.investigator + 34},${ROW - 52} ${X.investigator + 22},${TOP}`,
  learn: `M${X.person},${TOP} C${X.person},${NEB + RAIL + 28} ${SAT.memory[0] + 260},${NEB + RAIL + 24} ${SAT.memory[0] + 42},${SAT.memory[1] - 4}`,
  source: (y) => `M128,${y} C142,${y} 140,${ZET + 9} 156,${ZET + 9} L${X.watch},${ZET + 9} L${X.watch},${BOTTOM}`,
};

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const shortModel = (m) => String(m).split(",").pop().split("/").pop();

export function createFlow({ log = false } = {}) {
  const nodes = {};
  const fx = s("g", {});
  const timers = new Set();
  let gen = 0, last = null, live = null, stopStream = null, busyTimer = null, alive = true;
  let pinned = false; // following one chosen run: no replays, no switching to other runs

  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (alive) fn(); }, ms); timers.add(t); };
  const clearTimers = () => { for (const t of timers) clearTimeout(t); timers.clear(); };

  function travel(d, ms, cls) {
    if (reduce || !alive) return;
    const path = s("path", { d, class: `trail ${cls}` });
    const dot = s("circle", { r: 4, class: `dot ${cls}` });
    fx.append(path, dot);
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const p = path.getPointAtLength(e * len);
      dot.setAttribute("cx", p.x);
      dot.setAttribute("cy", p.y);
      path.style.strokeDashoffset = `${len * (1 - e)}`;
      if (k < 1 && alive) return requestAnimationFrame(tick);
      dot.remove();
      path.classList.add("gone");
      setTimeout(() => path.remove(), 700);
    };
    requestAnimationFrame(tick);
  }

  // ---------- the picture ----------
  const node = (id, x, y, w, ht, title, sub, cls) => (nodes[id] = s("g", { class: cls },
    s("rect", { x: x - w / 2, y: y - ht / 2, width: w, height: ht, rx: ht > 30 ? 12 : ht / 2 }),
    s("text", { x, y: sub ? y - 3 : y + 4, class: "t", "text-anchor": "middle" }, title),
    sub ? s("text", { x, y: y + 14, class: "u", "text-anchor": "middle" }, sub) : null));
  const lanes = s("text", { x: 1074, y: NEB + 25, class: "sub", "text-anchor": "end" }, "NVIDIA Nemotron");
  const rail = (y, cls, name, sub) => s("g", { class: `rail ${cls}` },
    s("rect", { x: 150, y, width: 940, height: RAIL, rx: 10 }),
    s("text", { x: 166, y: y + (cls === "zetaris" ? 31 : 25), class: "name" }, name),
    sub);

  const svg = s("svg", { viewBox: "0 0 1110 420", role: "img",
    "aria-label": "How a question flows through FloodSense: live sources, Zetaris, the agents, Nebius and the person who decides" },
    s("defs", {}, s("marker", { id: "arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto" },
      s("path", { d: "M0,0 L8,4 L0,8 z", class: "arrowhead" }))),
    rail(NEB, "nebius", "Nebius Token Factory", lanes),
    rail(ZET, "zetaris", "Zetaris", s("text", { x: 1074, y: ZET + 31, class: "sub", "text-anchor": "end" }, "one SQL layer over every live source")),
    ...AGENTS.map(([id]) => s("line", { class: "tick", x1: X[id], y1: NEB + RAIL, x2: X[id], y2: TOP })),
    ...AGENTS.filter(([id]) => id !== "person").map(([id]) => s("line", { class: "tick", x1: X[id], y1: BOTTOM, x2: X[id], y2: ZET })),
    ...AGENTS.slice(1).map(([id], i) => s("path", { class: "guide", d: P.hop(AGENTS[i][0], id), "marker-end": "url(#arrow)" })),
    s("path", { class: "guide dash", d: P.memory }), s("path", { class: "guide dash", d: P.web }), s("path", { class: "guide dash", d: P.learn }),
    s("text", { x: 760, y: NEB + RAIL + 30, class: "cap", "text-anchor": "middle" }, "Approved findings become memory"),
    s("text", { x: 18, y: 262, class: "cap" }, "Live sources"),
    ...SOURCES.map(([, y]) => s("path", { class: "guide", d: P.source(y) })),
    ...SOURCES.map(([name, y]) => s("g", { class: "source" },
      s("rect", { x: 18, y: y - 14, width: 110, height: 28, rx: 14 }), s("text", { x: 73, y: y + 4, "text-anchor": "middle" }, name))),
    ...AGENTS.map(([id, title, sub]) => node(id, X[id], ROW, 100, 56, title, sub, id === "person" ? "node person" : "node")),
    ...Object.entries(SAT).map(([id, [x, y, title]]) => node(id, x, y, 84, 26, title, "", "node sat")),
    fx);

  const mode = h("span", { class: "mode" });
  const question = h("span", { class: "q" });
  const caption = h("p", { class: "caption", "aria-live": "polite" });
  const list = log ? h("ol", { class: "flow-log" }) : null;
  const legend = h("ul", { class: "legend" },
    [["data", "Data query, Zetaris"], ["model", "Model call, Nebius"], ["web", "Web search, Tavily"], ["mem", "Memory"]]
      .map(([cls, text]) => h("li", {}, h("i", { class: cls }), text)));
  const el = h("div", { class: "flow" },
    h("div", { class: "flow-head" }, mode, question),
    h("div", { class: "flow-canvas" }, svg),
    h("div", { class: "flow-foot" }, caption, legend),
    list);

  // ---------- states ----------
  function setMode(kind, q) {
    mode.className = `mode ${kind}`;
    mode.textContent = { live: "Live now", replay: "Replay of the latest question", idle: "Waiting for a question" }[kind];
    question.textContent = q ? `“${q}”` : "";
  }
  function stopBusy() { clearInterval(busyTimer); busyTimer = null; }
  function reset() {
    stopBusy();
    for (const g of Object.values(nodes)) g.classList.remove("on", "done", "busy", "wait");
    last = null;
    list?.replaceChildren();
    caption.replaceChildren();
  }
  function light(id) {
    for (const g of Object.values(nodes)) g.classList.remove("on", "busy");
    nodes[id]?.classList.add("on", "done");
  }
  function hopTo(id) {
    if (X[id] && last && last !== id) travel(P.hop(last, id), 650, "hop");
    if (X[id]) last = id;
  }

  function say(e, working = false) {
    const [name, what] = step(e.node);
    const model = e.model_id ? shortModel(e.model_id) : null;
    const meta = h("span", { class: "meta" },
      model ? h("span", { class: "model-name", text: model }) : null,
      e.latency_ms > 0 ? h("span", { text: `${num(e.latency_ms / 1000, 1)} s` }) : null,
      working ? h("span", { class: "working", text: "working" }) : null);
    fill(caption, h("b", { text: name }), h("span", { text: what }), meta);
    if (!list || working) return;
    list.prepend(h("li", {}, h("time", { text: clock(e.ts) }), h("b", { text: name }), h("span", { text: what }), meta.cloneNode(true)));
    while (list.children.length > 6) list.lastChild.remove();
  }

  // One finished step of a run: where it happened, and what moved.
  function play(e, ms) {
    const id = MAP[e.node];
    if (!id || e.latency_ms == null) return; // no timing: a routing note, not a step
    stopBusy();
    hopTo(id);
    light(id);
    if (id === "person") nodes.person.classList.add("wait");
    if (e.node === "tavily") travel(P.web, 900, "web");
    if (e.node === "memory") travel(P.memory, 900, "mem");
    if (e.node === "learn") travel(P.learn, 1400, "mem");
    const model = Boolean(e.model_id), data = e.lane === "sql" || id === "watch";
    for (let i = 0; i < Math.max(1, Math.round(ms / 700)); i++) later(() => {
      if (data && X[id]) travel(P.data(id), 650, "data");
      if (model && X[id]) { travel(P.up(id), 550, "model"); later(() => travel(P.down(id), 550, "model"), 320); }
    }, 400 + i * 700);
    say(e);
  }

  // A step that has started and not finished yet (live runs only).
  function busy(nodeName) {
    const id = MAP[nodeName];
    if (!id) return;
    stopBusy();
    hopTo(id);
    light(id);
    nodes[id]?.classList.add("busy");
    say({ node: nodeName }, true);
    if (!X[id]) return;
    const pulse = () => {
      if (!THINKS.has(nodeName)) return travel(P.data(id), 650, "data");
      travel(P.up(id), 550, "model");
      later(() => travel(P.down(id), 550, "model"), 650);
    };
    pulse();
    busyTimer = setInterval(pulse, 1400);
  }

  function final(status) {
    stopBusy();
    for (const g of Object.values(nodes)) g.classList.remove("on", "busy");
    if (status === "awaiting_approval") {
      hopTo("person");
      nodes.person.classList.add("on", "done", "wait");
      fill(caption, h("b", { text: "You" }), h("span", { text: "The proposed actions wait for a person to approve or reject them." }),
        h("a", { href: "#/decide", text: "Open Decide" }));
    } else {
      const failed = status === "failed";
      fill(caption, h("b", { text: failed ? "Stopped" : "Answered" }),
        h("span", { text: failed ? "This run did not finish." : "Every claim was checked by the Judge." }));
    }
  }

  // ---------- following real runs ----------
  async function replay(my) {
    while (my === gen) {
      const runs = (await get("/runs/past").catch(() => null))?.runs || [];
      if (my !== gen) return;
      const running = runs.find((r) => r.status === "running");
      if (running) return follow(running);
      const recent = runs.find((r) => r.status !== "failed");
      const run = recent ? await get(`/runs/${encodeURIComponent(recent.run_id)}`).catch(() => null) : null;
      if (my !== gen) return;
      if (!run?.trace?.length) {
        reset();
        setMode("idle");
        fill(caption, h("span", { text: "Ask a question and follow it here as the agents work." }), h("a", { href: "#/ask", text: "Ask the agents" }));
        await sleep(6000);
        continue;
      }
      reset();
      setMode("replay", recent.question);
      for (const e of run.trace) {
        if (my !== gen) return;
        if (!MAP[e.node] || e.latency_ms == null) continue;
        const ms = Math.min(3200, Math.max(1000, (e.latency_ms || 0) * 0.2));
        play(e, ms);
        await sleep(ms);
      }
      if (my !== gen) return;
      final(run.status);
      await sleep(7000);
    }
  }

  function follow(r) {
    const my = ++gen;
    live = r.run_id;
    clearTimers();
    reset();
    setMode("live", r.question);
    const queue = [], seen = new Set();
    stopStream?.();
    stopStream = streamRun(r.run_id, (kind, d) => {
      if (my !== gen) return;
      if (kind === "started") busy(d?.node);
      else if (kind === "trace" && d && !seen.has(d.seq)) { seen.add(d.seq); queue.push(d); }
      else if ((kind === "status" && d?.status !== "running") || kind === "error") queue.push({ end: true });
    });
    (async () => {
      while (my === gen) {
        const e = queue.shift();
        if (!e) { await sleep(150); continue; }
        if (!e.end) {
          if (MAP[e.node]) { play(e, 1100); await sleep(1100); }
          continue;
        }
        stopStream?.();
        const run = await get(`/runs/${encodeURIComponent(r.run_id)}`).catch(() => null);
        if (my !== gen) return;
        final(run?.status);
        live = null;
        if (pinned) return;
        await sleep(8000);
        if (my === gen) replay(++gen);
        return;
      }
    })();
  }

  // The watch loop reading its sources, in the background.
  const ambient = setInterval(() => {
    const [, y] = SOURCES[Math.floor(Math.random() * SOURCES.length)];
    travel(P.source(y), 1800, "data faint");
  }, 2400);
  const poll = setInterval(async () => {
    if (live || pinned) return;
    const runs = (await get("/runs/past").catch(() => null))?.runs || [];
    const running = runs.find((r) => r.status === "running");
    if (running && alive && !live) follow(running);
  }, 4000);

  get("/platform/status").then((p) => {
    const names = Object.values(p?.lanes || {}).filter(Boolean).map(shortModel);
    if (names.length) lanes.textContent = names.join(" and ");
  }).catch(() => {});
  replay(++gen);

  return {
    el,
    /** Follow this run only, from now on. */
    follow(run) {
      pinned = true;
      follow(run);
    },
    stop() {
      alive = false;
      gen++;
      clearTimers();
      stopBusy();
      clearInterval(ambient);
      clearInterval(poll);
      stopStream?.();
    },
  };
}
