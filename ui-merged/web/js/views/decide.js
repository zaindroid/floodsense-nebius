import { get, myRuns, post } from "../api.js";
import { ago, failure, fill, h, loading, num, pill } from "../ui.js";
import { ROLES, role } from "../roles.js";
import { answer, plainText } from "./ask.js";

const DONE = { approved: ["Approved", "ok"], edited: ["Approved with edits", "ok"], auto: ["Approved", "ok"], rejected: ["Rejected", "high"] };
// Actions cite claims by id ("using C1-C3, C7"); the answer already shows them.
const REFS = /\s*(?:using|from|citing|per)?\s*\bC\d+(?:\s*[-–]\s*C\d+)?(?:\s*(?:,|and)\s*C\d+(?:\s*[-–]\s*C\d+)?)*\b/g;
const clean = (t) => plainText(String(t || "").replace(REFS, "")).replace(/\s*\(\s*\)/g, "").replace(/\s+([.,;])/g, "$1").trim();

const ICON = {
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>',
  in: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/></svg>',
};

export function decide(root, go, runId) {
  const body = h("div", { class: "decide" }, loading("Loading decisions…"));
  root.append(body);
  if (!ROLES[role()].decide) {
    return fill(body,
      h("header", { class: "page-head" }, h("h1", { text: "Decide" }),
        h("p", { text: "Insurers and civil protection approve the actions the agents propose. Switch role in the top bar to see their queue." })),
      h("a", { class: "btn primary", href: "#/watch" }, "Back to my area"));
  }
  (runId ? detail(body, runId) : queue(body)).catch((e) => body.replaceChildren(failure(e)));
}

// ---------- the list ----------
async function queue(body) {
  const status = await get("/watch/status").catch(() => null);
  const ids = [...new Set([...(status?.awaiting_run_ids || []), ...myRuns().map((r) => r.id)])].slice(0, 12);
  // Each role sees the runs asked in its own role, plus older ones that carry no role.
  const mine = ROLES[role()].api;
  const runs = (await Promise.all(ids.map((id) => get(`/runs/${encodeURIComponent(id)}`).catch(() => null))))
    .filter((r) => r?.summary && [undefined, null, mine].includes(r.request?.context?.role));
  const groups = {
    waiting: runs.filter((r) => r.status === "awaiting_approval"),
    decided: runs.filter((r) => DONE[r.approval?.status]),
  };
  let tab = groups.waiting.length || !groups.decided.length ? "waiting" : "decided";
  const seg = h("div", { class: "seg", role: "tablist", "aria-label": "Decisions" });
  const list = h("div", { class: "rows" });

  const draw = () => {
    seg.replaceChildren(...[["waiting", "Waiting"], ["decided", "Decided"]].map(([k, label]) =>
      h("button", { type: "button", role: "tab", "aria-selected": String(k === tab), onclick: () => { tab = k; draw(); } },
        label, h("span", { class: "count", text: String(groups[k].length) }))));
    const shown = groups[tab];
    if (shown.length) return list.replaceChildren(...shown.map(rowOf));
    list.replaceChildren(tab === "waiting"
      ? h("div", { class: "empty" }, h("p", { style: "margin:0 0 1rem", text: "Nothing is waiting for you." }),
        h("a", { class: "btn primary", href: "#/ask" }, "Ask the agents"))
      : h("div", { class: "empty" }, h("p", { style: "margin:0", text: "No decisions yet." })));
  };
  draw();

  fill(body,
    h("header", { class: "page-head" },
      h("h1", { text: ROLES[role()].decideTitle }),
      h("p", { text: `${ROLES[role()].decideIntro} Nothing is sent until a person approves it.` })),
    seg, list);
}

function rowOf(run) {
  const [word, tone] = run.status === "awaiting_approval" ? ["Waiting", "watch"] : DONE[run.approval?.status] || [run.status, ""];
  const n = (run.playbook || []).length;
  const score = run.judge_summary?.overall;
  return h("a", { class: "row link-row", href: `#/decide/${encodeURIComponent(run.run_id)}` },
    h("div", { class: "place" }, h("b", { text: run.request?.question || clean(run.summary).slice(0, 90) }),
      h("span", { text: ago(run.trace?.[0]?.ts || run.cached_at) })),
    h("div", { class: "src", text: `${n} ${n === 1 ? "action" : "actions"}` }),
    h("div", { class: "src", text: score != null ? `Judge ${Math.round(score * 100)}%` : "" }),
    pill(word, tone));
}

// ---------- one run ----------
async function detail(body, runId) {
  const run = await get(`/runs/${encodeURIComponent(runId)}`);
  const waiting = run.status === "awaiting_approval";
  const actions = run.playbook || [];
  const outbound = actions.filter((a) => a.outbound).length;
  const score = run.judge_summary?.overall;
  const sources = new Set((run.claims || []).flatMap((c) => (c.citations || []).map((x) => x.query_id || x.source_url || x.title))).size;
  const [word, tone] = waiting ? ["Waiting for you", "watch"] : DONE[run.approval?.status] || [run.status, ""];

  fill(body,
    h("a", { class: "back", href: "#/decide", text: "All decisions" }),

    h("header", { class: "d-head" },
      pill(word, tone),
      h("h1", { text: run.request?.question || "Proposed actions" }),
      h("div", { class: "facts" },
        fact(score != null ? `${Math.round(score * 100)}%` : "–", "Judge score", score != null && run.judge_summary?.passes !== false ? "ok" : "watch"),
        fact(num(actions.length), actions.length === 1 ? "action" : "actions"),
        fact(num(outbound), outbound === 1 ? "message to send" : "messages to send"),
        fact(num(sources), "sources"))),

    run.approval?.status && !waiting ? outcome(run) : null,

    h("section", { class: "d-block" },
      h("h2", { text: "What the agents found" }),
      h("p", { class: "summary", text: plainText(run.plain?.one_line || run.summary) }),
      h("details", { class: "more" },
        h("summary", {}, `Evidence: ${num((run.claims || []).length)} claims, ${num(sources)} sources`),
        h("div", { class: "more-body answer" }, answer(run, false).slice(3)))),

    h("section", { class: "d-block" },
      h("h2", { text: "What they propose" }),
      actions.length ? h("ol", { class: "acts" }, actions.map(act))
        : h("p", { class: "muted", text: "This answer proposed no actions." })),

    waiting ? decisionBar(body, runId, outbound) : null,
  );
}

function fact(value, label, tone = "") {
  return h("div", { class: `fact ${tone}` }, h("b", { text: value }), h("span", { text: label }));
}

function act(a) {
  const where = [a.target_region, a.affected_site_count != null ? `${num(a.affected_site_count)} insured sites` : null,
    a.horizon_h != null ? `within ${a.horizon_h} h` : null].filter(Boolean).join(", ");
  const icon = h("span", { class: `act-icon ${a.outbound ? "out" : ""}`, "aria-hidden": "true" });
  icon.innerHTML = a.outbound ? ICON.out : ICON.in;
  const text = clean(a.text);
  return h("li", { class: "act" },
    icon,
    h("div", {},
      h("div", { class: "act-top" },
        h("b", { text: a.title || text }),
        h("span", { class: "act-kind", text: a.released ? "Sent" : a.outbound ? "Sends a message" : "Internal" })),
      a.title && text && text !== a.title ? h("p", { text }) : null,
      where ? h("p", { class: "where", text: where }) : null,
      a.draft_message ? h("details", { class: "more" }, h("summary", {}, "Message draft"),
        h("div", { class: "draft", text: a.draft_message })) : null));
}

function outcome(run) {
  const [word, tone] = DONE[run.approval.status] || [run.approval.status, ""];
  return h("div", { class: `outcome ${tone}` },
    h("b", { text: word }),
    h("span", { text: run.approval.reviewer_note ? `Note: ${run.approval.reviewer_note}` : "No note was left." }));
}

function decisionBar(body, runId, outbound) {
  const note = h("input", { type: "text", "aria-label": "Note for the record", placeholder: "Add a note (needed to reject)", maxlength: 300 });
  const msg = h("p", { class: "bar-msg", role: "status" });
  const approve = h("button", { class: "btn primary", type: "button", onclick: () => send("approve") },
    outbound ? `Approve and send ${outbound}` : "Approve");
  const reject = h("button", { class: "btn danger", type: "button", onclick: () => send("reject") }, "Reject");

  async function send(action) {
    if (action === "reject" && !note.value.trim()) {
      msg.className = "bar-msg err";
      msg.textContent = "Add a short note to say why.";
      note.focus();
      return;
    }
    approve.disabled = reject.disabled = true;
    msg.className = "bar-msg";
    msg.textContent = action === "approve" ? "Approving…" : "Rejecting…";
    try {
      await post(`/runs/${encodeURIComponent(runId)}/approval`, { action, reviewer: ROLES[role()].reviewer, reviewer_note: note.value.trim() || null });
      body.replaceChildren(loading("Saved."));
      await detail(body, runId);
    } catch (e) {
      approve.disabled = reject.disabled = false;
      msg.className = "bar-msg err";
      msg.textContent = e.status === 409 ? "Someone already decided this." : `Not saved. ${e.message}`;
    }
  }

  return h("div", { class: "decision-bar" },
    h("div", { class: "bar-in-row" }, note, reject, approve), msg);
}
