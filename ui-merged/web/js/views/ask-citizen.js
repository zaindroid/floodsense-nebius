// Citizen Ask: a conversation, not a control room. Friendly progress while the
// agents work, then a short answer with the evidence folded away.
import { get, post, streamRun } from "../api.js";
import { ROLES, WHEN } from "../roles.js";
import { fill, h } from "../ui.js";
import { answer } from "./ask.js";

const PROGRESS = {
  scope: "Understanding your question…",
  watchers: "Reading the river data…", live_watch: "Reading the river data…", forecast_data: "Reading the forecast…",
  history: "Looking at past floods here…", tavily: "Checking recent local news…", memory: "Checking what we already know…",
  investigator: "Working out what it means…", quick_answer: "Writing a short answer…", forecast_answer: "Writing a short answer…",
  skeptic: "Double-checking with a second agent…", exposure: "Checking what is nearby…", playbook: "Preparing advice…",
  judge: "Checking every number…", quick_judge: "Checking every number…", forecast_judge: "Checking every number…",
};

export function askCitizen(root, preset) {
  const r = ROLES.citizen;
  const thread = h("ol", { class: "chat", "aria-live": "polite" });
  const input = h("input", { type: "text", "aria-label": "Your question", placeholder: "Ask about a town or river", maxlength: 500 });
  const send = h("button", { class: "btn primary", type: "submit" }, "Ask");
  const chips = h("div", { class: "chips" }, r.questions.map((x) =>
    h("button", { class: "chip", type: "button", onclick: () => ask(x.q, x.when, x.place) }, x.q)));
  let stop = null;

  root.append(
    h("header", { class: "page-head" }, h("h1", { text: "Ask about your area" }), h("p", { text: r.askIntro })),
    h("div", { class: "chat-wrap" },
      thread,
      h("form", { class: "composer", onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) ask(input.value.trim()); } }, input, send),
      chips));

  const bubble = (who, ...children) => {
    const li = h("li", { class: `msg ${who}` }, ...children);
    thread.append(li);
    li.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return li;
  };

  async function ask(q, when = "now", place = null) {
    stop?.();
    input.value = "";
    send.disabled = true;
    bubble("me", h("p", { text: q }));
    const progress = h("p", { class: "typing", text: "Starting…" });
    const reply = bubble("bot", progress);
    const w = WHEN[when] || WHEN.now;
    const body = { question: q, doc_query: q, context: { role: r.api, page: "ask", ...(place ? { place } : {}) } };
    if (w.event_id) Object.assign(body, { event_id: w.event_id, replay_ts: w.replay_ts });
    try {
      const res = await post("/runs?wait=false", body);
      if (res?.kind === "reply" && !res.run_id) {
        send.disabled = false;
        return fill(reply, h("p", { text: res.answer }),
          h("div", { class: "chips" }, (res.suggestions || []).map((s) => h("button", { class: "chip", type: "button", onclick: () => ask(s) }, s))));
      }
      if (res.status && res.status !== "running") return done(res.run_id, reply);
      stop = streamRun(res.run_id, (kind, d) => {
        if (kind === "started" && PROGRESS[d?.node]) progress.textContent = PROGRESS[d.node];
        else if ((kind === "status" && d?.status !== "running") || kind === "error") { stop?.(); done(res.run_id, reply); }
      });
    } catch (e) {
      send.disabled = false;
      fill(reply, h("p", { class: "err", text: e.status === 429
        ? `Many people are asking right now. Try again in ${e.retryAfter || 30} seconds.`
        : "Sorry, that did not work. Try again in a minute." }));
    }
  }

  async function done(runId, reply) {
    for (let i = 0; i < 40; i++) {
      const run = await get(`/runs/${encodeURIComponent(runId)}`).catch(() => null);
      if (run?.status === "failed") break;
      if (run && run.status !== "running" && run.summary) {
        send.disabled = false;
        return fill(reply, h("div", { class: "answer" }, answer(run, false, true).slice(1)));
      }
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    send.disabled = false;
    fill(reply, h("p", { class: "err", text: "I could not finish this answer. Try asking again." }));
  }

  bubble("bot", h("p", { text: "Hello. Ask me about the river in your town, or pick a question below. I'll answer in plain words and show where each number came from." }));
  if (preset) ask(preset);
  return () => stop?.();
}
