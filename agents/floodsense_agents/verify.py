"""Did each agent actually do what it claims, step by step?

readiness.py asks whether the foundations under the agents hold. This asks
a narrower question of each agent in turn: it says it produced this, does
the run's own record bear that out?

Every check reads the finished run. Several recompute the agent's output
from its inputs and compare, which is the only way to catch an agent that
reports a number it did not derive. The Judge's own summary is recomputed
from its per-claim scores for exactly that reason.

The data path block answers a separate question: whether any of this
reached Zetaris, or ran against the offline stand-in.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from floodsense_agents.governance import DEFINITIONS
from floodsense_agents.readiness import Check, _evidence, _views_in, title_of
from floodsense_agents.settings import settings
from floodsense_agents.zetaris import now_utc

LIVE_SOURCE = "zetaris"
FAKE_SOURCE = "zetaris-fake"


@dataclass
class Step:
    agent: str
    title: str
    lane: str
    does: str
    ran: bool = False
    summary: str = ""
    latency_ms: int | None = None
    model_id: str | None = None
    produced: dict[str, Any] = field(default_factory=dict)
    queries: list[dict[str, Any]] = field(default_factory=list)
    checks: list[Check] = field(default_factory=list)

    @property
    def status(self) -> str:
        if not self.ran:
            return "not reached"
        if not self.checks:
            return "unknown"
        if all(c.ok for c in self.checks):
            return "verified"
        return "failed" if not any(c.ok for c in self.checks) else "partial"

    def as_dict(self) -> dict[str, Any]:
        return {**asdict(self), "status": self.status}


def _trace(run: dict, node: str) -> dict:
    return next((t for t in run.get("trace") or [] if t.get("node") == node), {})


def _queries(run: dict, ids: list[str]) -> list[dict[str, Any]]:
    ev = _evidence(run)
    out = []
    for q in ids:
        e = ev.get(q)
        if not e:
            out.append({"query_id": q, "resolved": False})
            continue
        views = sorted(f"{s}.{v}" for s, v in _views_in(e.get("sql", "")))
        out.append(
            {
                "query_id": q,
                "resolved": True,
                "view": e.get("view"),
                "views": views,
                "rows": e.get("row_count", 0),
                "source": e.get("source"),
                "error": e.get("error"),
                "sql": e.get("sql", ""),
                "executed_at_utc": e.get("executed_at_utc"),
            }
        )
    return out


def _step(run: dict, agent: str, lane: str, does: str) -> Step:
    t = _trace(run, agent)
    return Step(
        agent=agent,
        title=title_of(agent),
        lane=t.get("lane") or lane,
        does=does,
        ran=bool(t),
        summary=t.get("summary", ""),
        latency_ms=t.get("latency_ms"),
        model_id=t.get("model_id"),
        queries=_queries(run, list(t.get("evidence_ids") or [])),
    )


# --- one function per agent ------------------------------------------------


def watchers(run: dict) -> Step:
    s = _step(run, "watchers", "sql", "scans the window for anomalies")
    if not s.ran:
        return s
    ev = _evidence(run)
    anomalies = run.get("anomalies") or []
    s.produced = {"anomalies": len(anomalies), "provenance_rows": len(run.get("provenance") or [])}

    dangling = [a["id"] for a in anomalies if a.get("query_id") not in ev]
    s.checks.append(
        Check(
            "every anomaly names a query that is in the record",
            bool(anomalies) and not dangling,
            f"{len(anomalies) - len(dangling)} of {len(anomalies)} resolve"
            + (f"; dangling {dangling}" if dangling else ""),
        )
    )

    wordings = {d.wording for d in DEFINITIONS.values() if d.used_by == "watchers"}
    measured = [a for a in anomalies if a.get("kind") in ("rain", "discharge")]
    drifted = [a["id"] for a in measured if a.get("why") not in wordings]
    s.checks.append(
        Check(
            "each threshold it applied is the declared one",
            not drifted,
            f"{len(measured) - len(drifted)} of {len(measured)} quote governance.DEFINITIONS",
        )
    )

    # Every value it flagged has to clear the number it says it used.
    by_term = {d.wording: d.value for d in DEFINITIONS.values()}
    under = [
        a["id"]
        for a in measured
        if a.get("value") is not None and a.get("value") < by_term.get(a.get("why"), 0)
    ]
    s.checks.append(
        Check(
            "every flagged value actually clears that threshold",
            not under,
            f"{len(measured) - len(under)} of {len(measured)} clear it"
            + (f"; below it {under}" if under else ""),
        )
    )

    window = (run.get("event") or {}).get("window_from_utc")
    scoped = [q for q in s.queries if q.get("sql") and window and window in q["sql"]]
    s.checks.append(
        Check(
            "it queried inside the event window",
            bool(window) and len(scoped) == len([q for q in s.queries if q.get("sql")]),
            f"{len(scoped)} of {len(s.queries)} queries carry the window {window}",
        )
    )
    return s


def investigator(run: dict) -> Step:
    s = _step(run, "investigator", "sql", "proposes the chain and writes cited claims")
    if not s.ran:
        return s
    claims = run.get("claims") or []
    hyps = run.get("hypotheses") or []
    s.produced = {"hypotheses": len(hyps), "claims": len(claims)}

    bare = [c["claim_id"] for c in claims if not c.get("citations")]
    s.checks.append(
        Check(
            "every claim it wrote carries a citation",
            bool(claims) and not bare,
            f"{len(claims) - len(bare)} of {len(claims)} cited"
            + (f"; bare {bare}" if bare else ""),
        )
    )

    ids = {c["claim_id"] for c in claims}
    missing = sorted({c for h in hyps for c in h.get("citations") or []} - ids)
    s.checks.append(
        Check(
            "every claim a hypothesis leans on exists",
            not missing,
            f"{len(ids)} claims written"
            + (f"; hypotheses point at missing {missing}" if missing else ""),
        )
    )

    numbered = [c for c in claims if c.get("kind") == "number"]
    without = [c["claim_id"] for c in numbered if not c.get("numbers")]
    s.checks.append(
        Check(
            "every number claim states the numbers it asserts",
            not without,
            f"{len(numbered) - len(without)} of {len(numbered)} carry a numbers list",
        )
    )
    return s


def skeptic(run: dict) -> Step:
    s = _step(run, "skeptic", "sql", "tries to break each link with counter-checks")
    if not s.ran:
        return s
    ev = _evidence(run)
    hyps = run.get("hypotheses") or []
    challenged = [h for h in hyps if h.get("rounds", 0) > 0]
    s.produced = {
        "links": len(hyps),
        "challenged": len(challenged),
        "counter_checks": sum(len(h.get("evidence") or []) for h in hyps),
        "supported": sum(1 for h in hyps if h.get("status") == "supported"),
        "not_supported": sum(1 for h in hyps if h.get("status") == "not_supported"),
    }

    undecided = [h["id"] for h in hyps if h.get("status") == "proposed"]
    s.checks.append(
        Check(
            "it ruled on every link",
            bool(hyps) and not undecided,
            f"{len(hyps) - len(undecided)} of {len(hyps)} decided"
            + (f"; still proposed {undecided}" if undecided else ""),
        )
    )

    unbacked = [h["id"] for h in challenged if not h.get("evidence")]
    s.checks.append(
        Check(
            "every link it challenged has counter-check queries behind it",
            not unbacked,
            f"{len(challenged)} links challenged, {len(unbacked)} with nothing behind them",
        )
    )

    dangling = sorted({q for h in hyps for q in h.get("evidence") or []} - set(ev))
    s.checks.append(
        Check(
            "each counter-check query is in the record",
            not dangling,
            f"{s.produced['counter_checks']} counter-checks"
            + (f"; {len(dangling)} missing" if dangling else ""),
        )
    )

    over = [h["id"] for h in hyps if h.get("rounds", 0) > settings.skeptic_max_rounds]
    s.checks.append(
        Check(
            "it stayed inside its round limit",
            not over,
            f"limit {settings.skeptic_max_rounds}"
            + (f"; over it {over}" if over else ", nothing over it"),
        )
    )
    return s


def _aggregate_totals(run: dict, exp: dict) -> tuple[int | None, float | None]:
    """COUNT(*) and SUM from the exposure node's portfolio query.

    ``rows_sample`` is capped at 20. The totals the node states come from the
    query that is ``COUNT(*)`` plus ``SUM(sum_insured_eur)`` with no GROUP BY.
    """
    evidence = run.get("evidence") or {}
    if not isinstance(evidence, dict):
        return None, None
    for qid in exp.get("query_ids") or []:
        row = evidence.get(qid)
        if not isinstance(row, dict) or row.get("error"):
            continue
        sql = " ".join((row.get("sql") or "").split()).upper()
        if "COUNT(" not in sql or "SUM(" not in sql or "GROUP BY" in sql:
            continue
        sample = row.get("rows_sample") or [{}]
        first = sample[0] if sample else {}
        if not isinstance(first, dict):
            return None, None
        try:
            return int(first.get("policies")), float(first.get("sum_insured_eur") or 0)
        except (TypeError, ValueError):
            return None, None
    return None, None


def exposure(run: dict) -> Step:
    s = _step(run, "exposure", "sql", "joins the footprint to the portfolio")
    if not s.ran:
        return s
    exp = run.get("exposure") or {}
    assets = exp.get("assets") or []
    s.produced = {
        "assets": len(assets),
        "policies": exp.get("policies"),
        "sum_insured_eur": exp.get("sum_insured_eur"),
        "segments": len(exp.get("by_segment") or []),
    }

    counted, summed = _aggregate_totals(run, exp)
    if counted is None:
        count_ok = exp.get("policies") in (0, None) and not assets
        count_detail = "no COUNT query in the record"
    else:
        count_ok = exp.get("policies") == counted
        count_detail = (
            f"reports {exp.get('policies')}, COUNT(*) is {counted}, sample lists {len(assets)}"
        )
    s.checks.append(
        Check(
            "the policy count matches the aggregate COUNT",
            count_ok,
            count_detail,
        )
    )

    stated = exp.get("sum_insured_eur")
    if summed is None:
        sum_ok = stated in (0, None, 0.0) and not assets
        sum_detail = "no SUM query in the record"
    elif stated is None:
        sum_ok = False
        sum_detail = "no total reported"
    else:
        sum_ok = abs(float(stated) - summed) < 0.01
        sum_detail = f"reports {stated:,.0f}, SUM is {summed:,.0f}"
    s.checks.append(
        Check(
            "the sum insured matches the aggregate SUM",
            sum_ok,
            sum_detail,
        )
    )

    target = float(stated or 0)
    seg_total = sum(g.get("sum_insured_eur") or 0 for g in exp.get("by_segment") or [])
    s.checks.append(
        Check(
            "the segment breakdown adds to the aggregate total",
            abs(seg_total - target) < 0.01,
            f"segments add to {seg_total:,.0f}, aggregate {target:,.0f}",
        )
    )

    nameless = [a for a in assets if not a.get("policy_id")]
    s.checks.append(
        Check(
            "every exposed site names its policy",
            not nameless,
            f"{len(assets) - len(nameless)} of {len(assets)} named",
        )
    )
    return s


def playbook(run: dict) -> Step:
    s = _step(run, "playbook", "deep", "drafts actions tied to the claims that justify them")
    if not s.ran:
        return s
    actions = run.get("playbook") or []
    ids = {c["claim_id"] for c in run.get("claims") or []}
    s.produced = {
        "actions": len(actions),
        "outbound": sum(1 for a in actions if a.get("outbound")),
        "released": sum(1 for a in actions if a.get("released")),
    }

    orphan = [a["action_id"] for a in actions if not a.get("claim_ids")]
    s.checks.append(
        Check(
            "every action names the claims that justify it",
            bool(actions) and not orphan,
            f"{len(actions) - len(orphan)} of {len(actions)} justified"
            + (f"; unjustified {orphan}" if orphan else ""),
        )
    )

    bad = sorted({c for a in actions for c in a.get("claim_ids") or []} - ids)
    s.checks.append(
        Check(
            "each claim it points at exists",
            not bad,
            f"{len(ids)} claims available" + (f"; actions cite missing {bad}" if bad else ""),
        )
    )

    status = (run.get("approval") or {}).get("status")
    early = [a["action_id"] for a in actions if a.get("released") and status == "awaiting"]
    s.checks.append(
        Check(
            "nothing is released while the decision is open",
            not early,
            f"approval {status!r}, {len(early)} released early",
        )
    )
    return s


def judge(run: dict) -> Step:
    s = _step(run, "judge", "deep", "scores grounding, citations and every number")
    if not s.ran:
        return s
    scores = run.get("judge") or []
    summary = run.get("judge_summary") or {}
    claims = run.get("claims") or []
    s.produced = {
        "scored": len(scores),
        "overall": summary.get("overall"),
        "flagged": summary.get("flagged_claim_ids"),
    }

    scored = {x.get("claim_id") for x in scores}
    unscored = sorted({c["claim_id"] for c in claims} - scored)
    s.checks.append(
        Check(
            "it scored every claim",
            bool(claims) and not unscored,
            f"{len(scored)} of {len(claims)} scored"
            + (f"; skipped {unscored}" if unscored else ""),
        )
    )

    # Recompute its own aggregate. An agent that misreports its summary is
    # exactly what this step exists to catch.
    if scores:
        mean = round(sum(x.get("score", 0) for x in scores) / len(scores), 3)
        s.checks.append(
            Check(
                "its overall score is the mean of its own per-claim scores",
                abs(mean - (summary.get("overall") or 0)) < 0.005,
                f"reports {summary.get('overall')}, per-claim scores average {mean}",
            )
        )
        unsupported = sum(1 for x in scores if x.get("grounding") == "unsupported")
        rate = round(unsupported / len(scores), 3)
        s.checks.append(
            Check(
                "its hallucination rate matches its own verdicts",
                abs(rate - (summary.get("hallucination_rate") or 0)) < 0.005,
                f"reports {summary.get('hallucination_rate')}, {unsupported} unsupported of "
                f"{len(scores)} is {rate}",
            )
        )
        flagged = sorted(x["claim_id"] for x in scores if x.get("grounding") == "unsupported")
        s.checks.append(
            Check(
                "it flagged exactly the claims it called unsupported",
                flagged == sorted(summary.get("flagged_claim_ids") or []),
                f"flagged {summary.get('flagged_claim_ids')}, unsupported {flagged}",
            )
        )
    return s


def hitl(run: dict) -> Step:
    s = _step(run, "hitl", "none", "holds outbound actions until a named reviewer decides")
    ap = run.get("approval") or {}
    actions = run.get("playbook") or []
    released = [a for a in actions if a.get("released")]
    # hitl leaves no trace event until it is resumed, so the approval record
    # is what says whether it ran.
    s.ran = ap.get("status") in ("approved", "edited", "rejected")
    s.produced = {"status": ap.get("status"), "released": len(released)}
    if not s.ran:
        s.summary = f"waiting: {len(actions)} actions held, approval {ap.get('status')!r}"
        return s

    s.summary = f"{ap.get('decision')} by {ap.get('reviewer')}, {len(released)} released"
    s.checks.append(
        Check(
            "a reviewer is named on the decision",
            bool(ap.get("reviewer")),
            f"reviewer {ap.get('reviewer')!r}",
        )
    )
    s.checks.append(
        Check(
            "the decision is timestamped",
            bool(ap.get("decided_at_utc")),
            f"decided at {ap.get('decided_at_utc')!r}",
        )
    )
    should_release = ap.get("status") in ("approved", "edited")
    s.checks.append(
        Check(
            "what was released matches the decision",
            bool(released) == should_release,
            f"{ap.get('status')} with {len(released)} of {len(actions)} released",
        )
    )
    return s


STEPS = (watchers, investigator, skeptic, exposure, playbook, judge, hitl)


def handoffs(run: dict) -> list[dict[str, Any]]:
    """What each agent actually passed to the next, counted from the run.

    The graph has two back edges: the Skeptic can send a link back to the
    Investigator to argue again, and the Judge can send the playbook back for
    one repair round. Both are reported with the number of times they fired,
    so a chain that needed three attempts does not read like one that did not.
    """
    exp = run.get("exposure") or {}
    hyps = run.get("hypotheses") or []
    claims = run.get("claims") or []
    actions = run.get("playbook") or []
    summary = run.get("judge_summary") or {}
    ap = run.get("approval") or {}
    ev = _evidence(run)

    def carried(*pairs):
        return [{"what": w, "n": n} for w, n in pairs if n not in (None, "")]

    out = [
        {
            "frm": "watchers",
            "to": "investigator",
            "kind": "forward",
            "carried": carried(
                ("anomalies", len(run.get("anomalies") or [])),
                ("evidence queries", len(ev)),
                ("provenance rows", len(run.get("provenance") or [])),
            ),
        },
        {
            "frm": "investigator",
            "to": "skeptic",
            "kind": "forward",
            "carried": carried(("hypotheses", len(hyps)), ("cited claims", len(claims))),
        },
        {
            "frm": "skeptic",
            "to": "investigator",
            "kind": "loop",
            "fired": run.get("revise_rounds", 0),
            "carried": carried(("links sent back to argue again", run.get("revise_rounds", 0))),
        },
        {
            "frm": "skeptic",
            "to": "exposure",
            "kind": "forward",
            "carried": carried(
                ("links supported", sum(1 for h in hyps if h.get("status") == "supported")),
                ("links not supported", sum(1 for h in hyps if h.get("status") == "not_supported")),
                ("counter-checks run", sum(len(h.get("evidence") or []) for h in hyps)),
            ),
        },
        {
            "frm": "exposure",
            "to": "playbook",
            "kind": "forward",
            "carried": carried(
                ("exposed policies", exp.get("policies")),
                ("sum insured EUR", exp.get("sum_insured_eur")),
            ),
        },
        {
            "frm": "playbook",
            "to": "judge",
            "kind": "forward",
            "carried": carried(
                ("actions drafted", len(actions)),
                ("claims to score", len(claims)),
            ),
        },
        {
            "frm": "judge",
            "to": "playbook",
            "kind": "loop",
            "fired": run.get("repair_rounds", 0),
            "carried": carried(("repair rounds asked for", run.get("repair_rounds", 0))),
        },
        {
            "frm": "judge",
            "to": "hitl",
            "kind": "forward",
            "carried": carried(
                (
                    "overall",
                    None if summary.get("overall") is None else f"{summary['overall']:.2f}",
                ),
                ("claims flagged", len(summary.get("flagged_claim_ids") or [])),
                ("outbound awaiting a decision", sum(1 for a in actions if a.get("outbound"))),
            ),
        },
        {
            "frm": "hitl",
            "to": "released",
            "kind": "forward",
            "carried": carried(
                ("decision", ap.get("decision") or "none yet"),
                ("actions released", sum(1 for a in actions if a.get("released"))),
            ),
        },
    ]
    # A back edge that never fired is noise on a diagram, not information.
    return [h for h in out if h["kind"] == "forward" or h.get("fired")]


def data_path(run: dict) -> dict[str, Any]:
    """Which data path this run actually used. Not which one is configured."""
    ev = _evidence(run)
    sources: dict[str, int] = {}
    for e in ev.values():
        sources[e.get("source") or "unknown"] = sources.get(e.get("source") or "unknown", 0) + 1
    live = sources.get(LIVE_SOURCE, 0)
    fake = sources.get(FAKE_SOURCE, 0)
    return {
        "configured_mode": settings.zetaris_mode,
        "rest_url_set": bool(settings.zetaris_rest_url),
        "schema": settings.schema,
        "live_data_flag": settings.live_data,
        "queries": len(ev),
        "by_source": sources,
        "reached_zetaris": live > 0 and fake == 0,
        "errors": sum(1 for e in ev.values() if e.get("error")),
        "rows": sum(e.get("row_count", 0) for e in ev.values()),
        "verdict": (
            "every query went to Zetaris"
            if live and not fake
            else "no query reached Zetaris; this ran on the offline stand-in"
            if fake and not live
            else "mixed: some queries reached Zetaris and some did not"
            if live and fake
            else "no query ran"
        ),
    }


def report(run: dict | None) -> dict[str, Any]:
    run = run or {}
    steps = [fn(run).as_dict() for fn in STEPS]
    checks = [c for s in steps for c in s["checks"]]
    return {
        "generated_at": now_utc(),
        "run_id": run.get("run_id"),
        "event_id": run.get("event_id"),
        # A report over a stored run is only as live as the run under it.
        "served_from": run.get("served_from"),
        "cached_at": run.get("cached_at"),
        "steps": steps,
        "handoffs": handoffs(run),
        "loops": {
            "revise_rounds": run.get("revise_rounds", 0),
            "repair_rounds": run.get("repair_rounds", 0),
        },
        "data_path": data_path(run),
        "verified": sum(1 for s in steps if s["status"] == "verified"),
        "of": len(steps),
        "checks_passed": sum(1 for c in checks if c["ok"]),
        "checks_run": len(checks),
        "failures": [
            {"agent": s["agent"], "check": c["name"], "detail": c["detail"]}
            for s in steps
            for c in s["checks"]
            if not c["ok"]
        ],
    }
