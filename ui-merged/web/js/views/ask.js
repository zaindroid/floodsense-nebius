import { get, post, rememberRun, streamRun } from "../api.js";
import { ROLES, WHEN, role } from "../roles.js";
import { askCitizen } from "./ask-citizen.js";
import { createFlow } from "../flow.js";
import { fill, h, loading, num, pill } from "../ui.js";

// Each step of the agent graph, in plain words.
const STEPS = {
  scope: ["Scope", "Understands the question"],
  memory: ["Memory", "Recalls approved past findings"],
  tavily: ["Web search", "Finds recent news for the place"],
  watchers: ["Watchers", "Reads the live data"],
  live_watch: ["Watchers", "Reads the live data"],
  forecast_data: ["Forecast", "Reads the river forecast"],
  history: ["History", "Looks up past floods here"],
  investigator: ["Investigator", "Builds the explanation"],
  quick_answer: ["Answer", "Writes a short answer"],
  forecast_answer: ["Answer", "Writes a short answer"],
  skeptic: ["Skeptic", "Tries to disprove it"],
  revise: ["Revise", "Fixes what the Skeptic found"],
  exposure: ["Exposure", "Finds what's exposed"],
  playbook: ["Playbook", "Proposes actions"],
  judge: ["Judge", "Checks every claim"],
  quick_judge: ["Judge", "Checks every claim"],
  forecast_judge: ["Judge", "Checks every claim"],
  escalate: ["Escalate", "Hands over to the full team"],
  hitl: ["Human approval", "Waits for a person"],
  learn: ["Learn", "Keeps what was approved"],
};
// Bookkeeping steps, not agents: left out of the pipeline.
const QUIET = new Set(["router", "world_model"]);
export const step = (node) => STEPS[node] || [node.replace(/_/g, " "), ""];
const KIND = { a: "Live data", b: "Record", c: "Document" };
// A Zetaris query is titled by its view ("floodsense.hazard_timeline"); say it in words.
const label = (c) => c.layer === "a" ? `Zetaris query: ${c.title.split(".").pop().replace(/_/g, " ")}` : c.title;
const EVENTS = { EMSR773: "Valencia, Oct 2024", EMSR517: "Ahr valley, Jul 2021" };
// The model writes its own refs ("[C1, C2]") into the summary; the claims already carry them.
export const plainText = (t) => String(t || "").replace(/\s*\[C\d+(?:,\s*C\d+)*\]/g, "").replace(/([.!?])\./g, "$1")
  .replace(/(\d+\.\d)\d{5,}/g, "$1"); // float noise such as 88.2000000000001
const WEB_NOTE = /^Web context, not an official warning\.\s*/;

export function ask(root, go, preset) {
  const r = ROLES[role()];
  if (!r.decide) return askCitizen(root, preset);
  let when = "now";
  let place = "";
  const text = h("textarea", { "aria-label": "Your question", placeholder: r.questions[0].q, maxlength: 500 });
  if (preset) text.value = preset;
  const whenChips = h("div", { class: "chips", role: "group", "aria-label": "Data from" });
  const drawWhen = () => whenChips.replaceChildren(...Object.entries(WHEN).map(([k, w]) =>
    h("button", { class: "chip", type: "button", "aria-pressed": String(k === when), onclick: () => { when = k; drawWhen(); } }, w.label)));
  drawWhen();

  const send = h("button", { class: "btn primary", type: "submit" }, "Ask the agents");
  const out = h("div", { "aria-live": "polite" });
  const form = h("form", { class: "ask-box card", onsubmit: (e) => { e.preventDefault(); start(); } },
    text,
    h("div", { class: "chips" }, r.questions.map((x) =>
      h("button", { class: "chip", type: "button", onclick: () => { text.value = x.q; when = x.when; place = x.place || ""; drawWhen(); text.focus(); } }, x.q))),
    h("div", { class: "ask-row" },
      h("div", { style: "display:flex;gap:.6rem;align-items:center;flex-wrap:wrap" }, h("span", { class: "label", text: "Data from" }), whenChips),
      send));

  // The live flow, docked at the bottom: the latest question until you ask, then yours.
  const flow = createFlow();
  const hint = h("span", { class: "dock-hint", text: "Show" });
  const bar = h("button", { class: "dock-bar", type: "button", "aria-expanded": "false", onclick: () => dock(bar.getAttribute("aria-expanded") !== "true") },
    h("span", { class: "dock-title" }, h("span", { class: "dock-dot" }), "How it works, live"), hint);
  const panel = h("aside", { class: "dock", "aria-label": "How it works, live" }, bar, h("div", { class: "dock-body" }, flow.el));
  const dock = (open) => {
    bar.setAttribute("aria-expanded", String(open));
    panel.classList.toggle("open", open);
    root.classList.toggle("docked-open", open);
    hint.textContent = open ? "Hide" : "Show";
  };

  root.classList.add("docked");
  root.append(
    h("header", { class: "page-head" },
      h("h1", { text: "Ask the agents" }),
      h("p", { text: r.askIntro })),
    form, out, panel);

  let stop = null;
  async function start() {
    const q = text.value.trim() || text.placeholder;
    text.value = q;
    const w = WHEN[when];
    const body = { question: q, doc_query: q };
    if (w.event_id) Object.assign(body, { event_id: w.event_id, replay_ts: w.replay_ts });
    // The role shapes the wording: plain words and what to do, exposure first, or a briefing.
    body.context = { role: r.api, page: "ask", ...(place ? { place } : {}) };
    stop?.();
    send.disabled = true;
    out.replaceChildren(loading("Starting the agents…"));
    try {
      const res = await post("/runs?wait=false", body);
      if (res?.kind === "reply" && !res.run_id) {
        send.disabled = false;
        out.replaceChildren(h("div", { class: "card section" }, h("p", { class: "summary", text: res.answer }),
          h("div", { class: "chips" }, (res.suggestions || []).map((s) =>
            h("button", { class: "chip", type: "button", onclick: () => { text.value = s; start(); } }, s)))));
        return;
      }
      rememberRun({ id: res.run_id, q, at: new Date().toISOString() });
      flow.follow({ run_id: res.run_id, question: q });
      dock(true);
      if (res.status && res.status !== "running") return finish(res.run_id);
      follow(res.run_id);
    } catch (e) {
      send.disabled = false;
      out.replaceChildren(h("p", { class: "err", role: "alert", text: e.status === 429
        ? `Many people are asking right now. Try again in ${e.retryAfter || 30} seconds.`
        : `The agents could not start. ${e.message}` }));
    }
  }

  function follow(runId) {
    const list = h("ol", { class: "pipeline" });
    const main = h("div", { class: "answer card" }, h("p", { class: "muted", text: "The answer appears here once the Judge has checked it." }));
    out.replaceChildren(h("div", { class: "run" }, h("div", { class: "card" }, h("h2", { text: "The agents at work" }), list), main));
    const seen = new Set();
    const rows = new Map(); // one row per agent; a second round updates the same row

    const row = (node) => {
      const [name, what] = step(node);
      if (!rows.has(name)) {
        const li = h("li", { class: "waiting" }, h("span", { class: "dot" }), h("b", { text: name }), what ? h("div", { class: "what", text: what }) : null,
          h("div", { class: "said" }), h("div", { class: "meta" }));
        li.rounds = 0;
        list.append(li);
        rows.set(name, li);
      }
      return rows.get(name);
    };
    stop = streamRun(runId, (kind, d) => {
      if (QUIET.has(d?.node)) return;
      if (kind === "started" && d?.node) {
        for (const li of rows.values()) li.classList.remove("now");
        const li = row(d.node);
        li.classList.remove("waiting");
        li.classList.add("now");
      } else if (kind === "trace" && d?.node && !seen.has(d.seq)) {
        seen.add(d.seq);
        const li = row(d.node);
        li.className = "done";
        if (d.model_id || !li.rounds) li.rounds += 1;
        if (d.summary) li.querySelector(".said").textContent = d.summary.length > 140 ? `${d.summary.slice(0, 139)}…` : d.summary;
        const meta = li.querySelector(".meta");
        if (d.model_id) {
          fill(meta, 
            d.provider === "nebius" ? h("span", { class: "nebius-tag", text: "Nebius" }) : null,
            h("span", { text: d.model_id.split("/").pop() }),
            typeof d.latency_ms === "number" && d.latency_ms > 0 ? h("span", { text: `${num(d.latency_ms / 1000, 1)} s` }) : null);
        }
        meta.querySelector(".round")?.remove();
        if (li.rounds > 1) meta.append(h("span", { class: "round", text: `round ${li.rounds}` }));
      } else if (kind === "status") {
        for (const li of rows.values()) li.classList.remove("now");
        finish(runId, main);
      } else if (kind === "error") {
        stop?.();
        setTimeout(() => finish(runId, main), 3000);
      }
    });
  }

  async function finish(runId, main) {
    if (!main) {
      main = h("div", { class: "answer card section" });
      out.replaceChildren(main);
    }
    for (let i = 0; i < 40; i++) {
      const run = await get(`/runs/${encodeURIComponent(runId)}`).catch(() => null);
      if (run?.status === "failed") break;
      if (run && run.status !== "running" && run.summary) {
        send.disabled = false;
        fill(main, answer(run, r.decide, !r.decide));
        setTimeout(() => dock(false), 4000); // make room for the answer
        return;
      }
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    send.disabled = false;
    main.replaceChildren(h("p", { class: "err", text: "This run did not finish with an answer. Try asking again." }));
  }

  return () => {
    stop?.();
    flow.stop();
    root.classList.remove("docked", "docked-open");
  };
}

// The answer card: summary, numbered claims with source refs, the Judge's score, sources.
// simple: the short answer first, the claims and sources folded away (citizens).
export function answer(run, withNext = true, simple = false) {
  const sources = [];
  const cite = (c) => {
    const key = c.query_id || c.source_url || c.title;
    let i = sources.findIndex((s) => s.key === key);
    if (i < 0) i = sources.push({ key, c }) - 1;
    return i + 1;
  };
  const flagged = new Set(run.judge_summary?.flagged_claim_ids || []);
  const claims = (run.claims || []).map((cl) =>
    h("li", {}, WEB_NOTE.test(cl.text) ? [pill("Web, not official", "plain"), " ", cl.text.replace(WEB_NOTE, "")] : plainText(cl.text), [...new Set((cl.citations || []).map(cite))].map((n) =>
      h("span", { class: "ref", title: label(sources[n - 1].c), text: String(n) })),
      flagged.has(cl.claim_id) ? h("span", { style: "margin-left:.5rem" }, pill("Judge flagged", "watch")) : null));
  const score = run.judge_summary?.overall;
  const passes = run.judge_summary?.passes;
  const actions = (run.playbook || []).length;

  const head = [
    h("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem" },
      pill(run.served_from === "live" ? "Live answer" : run.served_from === "cache" ? "Recent answer" : "Recorded answer", "info"),
      run.event_id && EVENTS[run.event_id] ? pill(EVENTS[run.event_id], "plain") : null),
    h("h2", { text: run.plain?.headline || "Answer" }),
    h("p", { class: "summary", text: plainText(run.plain?.one_line || run.summary) }),
  ];
  const evidence = [
    claims.length ? h("ol", { class: "claims" }, claims) : null,
    typeof score === "number" ? h("div", { class: `verdict${passes === false ? " flag" : ""}`, style: "margin-top:1.2rem" },
      h("b", { text: `${Math.round(score * 100)}%` }),
      h("span", { text: passes === false ? "The Judge found claims that need a closer look." : "The Judge checked each claim against its evidence." })) : null,
    sources.length ? h("div", { style: "margin-top:1.4rem" }, h("h2", { text: "Sources" }),
      h("ol", { class: "sources" }, sources.map(({ c }, i) => {
        const web = String(c.query_id || "").startsWith("web-");
        return h("li", {}, h("span", { class: "k", text: String(i + 1) }),
          h("div", {},
            h("div", { class: "t" }, c.source_url ? h("a", { href: c.source_url, target: "_blank", rel: "noopener noreferrer", text: label(c) }) : label(c)),
            h("div", { class: "m", text: [web ? "Web" : KIND[c.layer] || "Source", c.publisher].filter(Boolean).join(", ") })));
      }))) : null,
  ];
  return [
    ...head,
    simple ? h("details", { class: "more" }, h("summary", {}, `Show the evidence: ${claims.length} claims, ${sources.length} sources`),
      h("div", { class: "more-body" }, evidence)) : evidence,
    withNext && run.status === "awaiting_approval" ? h("p", { class: "note", style: "margin-top:1.4rem" },
      `${actions} proposed ${actions === 1 ? "action is" : "actions are"} waiting for a person. `,
      h("a", { href: `#/decide/${encodeURIComponent(run.run_id)}`, text: "Review and decide" })) : null,
  ];
}
