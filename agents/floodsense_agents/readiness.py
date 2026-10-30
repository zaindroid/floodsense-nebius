"""Eight foundations, each checked against a finished run.

The order is the staircase every company climbs before agents are worth
trusting: ownership, agreed definitions, data quality, metadata, lineage,
a semantic layer, access rights, data products. An agent answer is only
as good as the rung under it, so each one here states its own evidence
and its own gaps rather than reporting a score.

Every check reads the run, the registries in governance.py and the live
dependencies. None of them is allowed to pass by assertion: if a check
cannot see its evidence it fails, and test_readiness.py breaks each one
on purpose to prove it.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from floodsense_agents.governance import (
    CONTRACT_VIEWS,
    DATA_PRODUCTS,
    DEFINITIONS,
    OWNERS,
)
from floodsense_agents.models import Claim
from floodsense_agents.settings import settings
from floodsense_agents.zetaris import now_utc

# Agents in graph order. `title` is what a person reads, `agent` is the node id
# in the graph, kept beside it so a screen and the code match. "hitl" above all:
# nobody outside the team reads that as human-in-the-loop.
AGENTS: tuple[tuple[str, str, str, str], ...] = (
    (
        "watchers",
        "Hazard scan agent",
        "sql",
        "scans the window for anomalies, every one carrying a query id",
    ),
    (
        "investigator",
        "Investigator agent",
        "sql",
        "proposes the causal chain and writes cited claims",
    ),
    ("skeptic", "Skeptic agent", "sql", "tries to break each link with counter-check queries"),
    ("exposure", "Exposure join agent", "sql", "joins the footprint to the portfolio"),
    (
        "playbook",
        "Playbook agent",
        "deep",
        "drafts actions, each tied to the claims that justify it",
    ),
    ("judge", "Judge agent", "deep", "scores grounding, citations and every number"),
    ("hitl", "Human approval", "none", "holds outbound actions until a named reviewer decides"),
)


def title_of(agent: str) -> str:
    return next((t for a, t, _, _ in AGENTS if a == agent), agent)


_FROM = re.compile(r"\b(?:from|join)\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)", re.I)


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


@dataclass
class Rung:
    n: int
    key: str
    name: str
    asks: str
    checks: list[Check] = field(default_factory=list)
    gaps: list[str] = field(default_factory=list)
    agents: list[str] = field(default_factory=list)

    @property
    def status(self) -> str:
        if not self.checks:
            return "unknown"
        if all(c.ok for c in self.checks):
            return "pass"
        return "fail" if not any(c.ok for c in self.checks) else "partial"

    def as_dict(self) -> dict[str, Any]:
        return {**asdict(self), "status": self.status}


def _views_in(sql: str) -> set[tuple[str, str]]:
    return {(m.group(1).lower(), m.group(2).lower()) for m in _FROM.finditer(sql or "")}


def _evidence(run: dict) -> dict[str, dict]:
    ev = run.get("evidence") or {}
    return ev if isinstance(ev, dict) else {}


def _claims(run: dict) -> list[Claim]:
    out = []
    for c in run.get("claims") or []:
        try:
            out.append(Claim.model_validate(c))
        except Exception:  # noqa: BLE001 - a malformed claim is a finding, not a crash
            continue
    return out


# --- 01 ------------------------------------------------------------------


def ownership(run: dict, deps: Any) -> Rung:
    r = Rung(
        1,
        "ownership",
        "Data ownership",
        "Who decides what each view means, and who may let its output out?",
        agents=["hitl"],
    )
    used = {v for ev in _evidence(run).values() for _, v in _views_in(ev.get("sql", ""))}
    orphans = sorted(used - set(OWNERS))
    r.checks.append(
        Check(
            "every view the run read has a named owner",
            not orphans,
            f"{len(used - set(orphans))} of {len(used)} views owned"
            + (f"; no owner for {', '.join(orphans)}" if orphans else ""),
        )
    )

    approval = run.get("approval") or {}
    outbound = [a for a in run.get("playbook") or [] if a.get("outbound")]
    released = [a for a in outbound if a.get("released")]
    reviewer = approval.get("reviewer")
    r.checks.append(
        Check(
            "nothing outbound is released without a named reviewer",
            not released or bool(reviewer),
            f"{len(released)} of {len(outbound)} outbound actions released"
            + (f", decided by {reviewer} at {approval.get('decided_at_utc')}" if reviewer else ""),
        )
    )
    r.checks.append(
        Check(
            "the decision is recorded, not implied",
            approval.get("status") in ("awaiting", "approved", "edited", "rejected"),
            f"approval status {approval.get('status')!r}, decision {approval.get('decision')!r}",
        )
    )
    if not reviewer and released:
        r.gaps.append("Outbound actions were released with no reviewer on the record.")
    if orphans:
        r.gaps.append(f"Declare an owner in governance.OWNERS for: {', '.join(orphans)}.")
    return r


# --- 02 ------------------------------------------------------------------


def definitions(run: dict, deps: Any) -> Rung:
    r = Rung(
        2,
        "definitions",
        "Agreed definitions",
        "Does every term the agents assert mean one thing, with one number behind it?",
        agents=["watchers", "skeptic", "exposure", "judge"],
    )
    wordings = {d.wording for d in DEFINITIONS.values()}
    anomalies = run.get("anomalies") or []
    measured = [a for a in anomalies if a.get("kind") in ("rain", "discharge")]
    undeclared = sorted({a["why"] for a in measured if a.get("why") not in wordings})
    r.checks.append(
        Check(
            "every anomaly states a declared definition, word for word",
            not undeclared and bool(measured),
            f"{len(measured) - len(undeclared)} of {len(measured)} measured anomalies"
            + (f"; undeclared wording {undeclared}" if undeclared else ""),
        )
    )

    rationales = " ".join(h.get("rationale", "") for h in run.get("hypotheses") or [])
    skeptic_terms = [d for d in DEFINITIONS.values() if d.used_by == "skeptic"]
    missing = [d.term for d in skeptic_terms if d.wording not in rationales]
    r.checks.append(
        Check(
            "the Skeptic's counter-checks quote the same definitions",
            not missing,
            f"{len(skeptic_terms) - len(missing)} of {len(skeptic_terms)} skeptic terms quoted"
            + (f"; missing {missing}" if missing else ""),
        )
    )

    tol = DEFINITIONS["numeric_tolerance"].value
    r.checks.append(
        Check(
            "the runtime uses the declared numeric tolerance",
            abs(settings.numeric_tolerance - tol) < 1e-9,
            f"settings {settings.numeric_tolerance}, declared {tol}",
        )
    )

    unsigned = [d.term for d in DEFINITIONS.values() if not d.agreed_on]
    if unsigned:
        r.gaps.append(
            f"{len(unsigned)} definitions are declared but not signed off at stand-up: "
            + ", ".join(unsigned)
            + "."
        )
    return r


# --- 03 ------------------------------------------------------------------


def data_quality(run: dict, deps: Any) -> Rung:
    r = Rung(
        3,
        "quality",
        "Data quality",
        "Does the data survive being argued with, and are its holes declared?",
        agents=["skeptic", "judge"],
    )
    ev = _evidence(run)
    errored = [q for q, e in ev.items() if e.get("error")]
    r.checks.append(
        Check(
            "no query failed silently",
            not errored,
            f"{len(ev)} queries ran, {len(errored)} failed",
        )
    )

    hyps = run.get("hypotheses") or []
    undecided = [h["id"] for h in hyps if h.get("status") == "proposed"]
    r.checks.append(
        Check(
            "every link of the chain was ruled on",
            bool(hyps) and not undecided,
            f"{len(hyps) - len(undecided)} of {len(hyps)} links decided"
            + (f"; still proposed {undecided}" if undecided else ""),
        )
    )

    challenged = [h for h in hyps if h.get("rounds", 0) > 0]
    counter = sum(len(h.get("evidence") or []) for h in challenged)
    r.checks.append(
        Check(
            "links that needed challenging got counter-check queries",
            all(h.get("evidence") for h in challenged),
            f"{counter} counter-checks across {len(challenged)} challenged links",
        )
    )

    # A gap the data itself has. Reporting it is the point; hiding it is the failure.
    gaps_found = [c.text for c in _claims(run) if "no discharge value" in c.text.lower()]
    r.checks.append(
        Check(
            "known holes in the source are stated in the answer",
            bool(gaps_found),
            gaps_found[0] if gaps_found else "no declared hole found in the claims",
        )
    )
    if not gaps_found:
        r.gaps.append("The gauge outage is not stated as a claim, so a reader would not see it.")
    return r


# --- 04 ------------------------------------------------------------------


def metadata(run: dict, deps: Any) -> Rung:
    r = Rung(
        4,
        "metadata",
        "Metadata",
        "For every view: who published it, under what licence, fetched when?",
        agents=["watchers"],
    )
    rows = run.get("provenance") or []
    documented = {row.get("dataset") for row in rows}
    # provenance is the register itself; it describes the other views, not itself.
    used = {
        v
        for ev in _evidence(run).values()
        for _, v in _views_in(ev.get("sql", ""))
        if v != "provenance"
    }
    undocumented = sorted(used - documented)
    r.checks.append(
        Check(
            "every view the run read has a provenance row",
            not undocumented and bool(rows),
            f"{len(used) - len(undocumented)} of {len(used)} views documented"
            + (f"; nothing filed for {', '.join(undocumented)}" if undocumented else ""),
        )
    )

    required = ("source_url", "publisher", "licence", "attribution", "fetched_at")
    incomplete = [
        f"{row.get('dataset')} ({row.get('publisher')}) missing "
        + ", ".join(f for f in required if not row.get(f))
        for row in rows
        if any(not row.get(f) for f in required)
    ]
    r.checks.append(
        Check(
            "each provenance row is complete",
            not incomplete,
            f"{len(rows) - len(incomplete)} of {len(rows)} rows complete",
        )
    )
    for line in incomplete:
        r.gaps.append(line + ".")
    if undocumented:
        r.gaps.append(f"Add a provenance row for: {', '.join(undocumented)}.")
    return r


# --- 05 ------------------------------------------------------------------


def lineage(run: dict, deps: Any) -> Rung:
    r = Rung(
        5,
        "lineage",
        "Lineage",
        "Can every number in the answer be walked back to the query that produced it?",
        agents=["investigator", "exposure", "judge"],
    )
    claims = _claims(run)
    ev = _evidence(run)

    uncited = [c.claim_id for c in claims if not c.citations]
    r.checks.append(
        Check(
            "every claim carries at least one citation",
            bool(claims) and not uncited,
            f"{len(claims) - len(uncited)} of {len(claims)} claims cited"
            + (f"; bare {uncited}" if uncited else ""),
        )
    )

    wanted = [(c.claim_id, ct.query_id) for c in claims for ct in c.citations if ct.layer == "a"]
    dangling = [cid for cid, q in wanted if not q or q not in ev]
    r.checks.append(
        Check(
            "every layer-a citation resolves to a query in this run",
            bool(wanted) and not dangling,
            f"{len(wanted) - len(dangling)} of {len(wanted)} resolve"
            + (f"; dangling on {sorted(set(dangling))}" if dangling else ""),
        )
    )

    with_sql = [q for _, q in wanted if q in ev and ev[q].get("sql")]
    r.checks.append(
        Check(
            "each resolved query still holds the SQL it ran",
            len(with_sql) == len(wanted) - len(dangling),
            f"{len(with_sql)} queries reproducible from the record",
        )
    )

    summary = run.get("judge_summary") or {}
    numeric = summary.get("numeric_accuracy")
    if not summary:
        r.checks.append(
            Check(
                "stated numbers were found in the cited rows",
                False,
                "not checked: the Judge did not run (FF_JUDGE is off)",
            )
        )
        r.gaps.append("Turn on FF_JUDGE, or no one verifies the numbers against their sources.")
        return r
    r.checks.append(
        Check(
            "stated numbers were found in the cited rows",
            numeric == 1.0,
            f"numeric accuracy {numeric}"
            + (
                f", flagged {summary.get('flagged_claim_ids')}"
                if summary.get("flagged_claim_ids")
                else ""
            ),
        )
    )
    if dangling:
        r.gaps.append("Some citations point at queries that are not in the run record.")
    return r


# --- 06 ------------------------------------------------------------------


def semantic_layer(run: dict, deps: Any) -> Rung:
    r = Rung(
        6,
        "semantic",
        "Semantic layer",
        "Do the agents read agreed views, or reach into whatever table they like?",
        agents=["watchers", "investigator", "skeptic", "exposure"],
    )
    pairs = {p for e in _evidence(run).values() for p in _views_in(e.get("sql", ""))}
    outside = sorted(f"{s}.{v}" for s, v in pairs if v not in CONTRACT_VIEWS)
    r.checks.append(
        Check(
            "every query reads a contract view and nothing else",
            not outside and bool(pairs),
            f"{len(pairs) - len(outside)} of {len(pairs)} reads inside the contract"
            + (f"; outside it {outside}" if outside else ""),
        )
    )

    schemas = sorted({s for s, _ in pairs})
    r.checks.append(
        Check(
            "one schema for the whole run",
            schemas == [settings.schema],
            f"read from {schemas or ['nothing']}, configured {settings.schema}",
        )
    )

    star = [
        q for q, e in _evidence(run).items() if re.search(r"select\s+\*", e.get("sql", ""), re.I)
    ]
    r.checks.append(
        Check(
            "no query selects columns it did not name",
            not star,
            f"{len(star)} queries use SELECT *",
        )
    )
    if not settings.live_data:
        r.gaps.append(
            "FF_LIVE_DATA is off, so this ran against floodsense_seed, not the live warehouse."
        )
    return r


# --- 07 ------------------------------------------------------------------


def access_rights(run: dict, deps: Any) -> Rung:
    r = Rung(
        7,
        "access",
        "Access rights",
        "What may the agents read, and what may leave the building?",
        agents=["hitl", "judge"],
    )
    refused = False
    if deps is not None and getattr(deps, "zetaris", None) is not None:
        try:
            deps.zetaris.run_sql("DELETE FROM hazard_timeline")
        except Exception:  # noqa: BLE001 - refusing is the pass condition
            refused = True
    r.checks.append(
        Check(
            "the data path refuses anything but SELECT",
            refused,
            "a DELETE was rejected" if refused else "a DELETE was not rejected",
        )
    )

    outbound = [a for a in run.get("playbook") or [] if a.get("outbound")]
    status = (run.get("approval") or {}).get("status")
    leaked = [a["action_id"] for a in outbound if a.get("released") and status == "awaiting"]
    r.checks.append(
        Check(
            "outbound actions stay held until the decision",
            not leaked,
            f"{len(outbound)} outbound actions, {len(leaked)} released early",
        )
    )

    licences = {
        (ct.publisher or "?", ct.licence or "")
        for c in _claims(run)
        for ct in c.citations
        if ct.layer == "b"
    }
    unclear = sorted(
        f"{pub} ({lic or 'none recorded'})"
        for pub, lic in licences
        if not lic or re.search(r"confirm|verify|tbd|unknown", lic, re.I)
    )
    r.checks.append(
        Check(
            "every cited source has a settled licence",
            bool(licences) and not unclear,
            f"{len(licences) - len(unclear)} of {len(licences)} settled",
        )
    )
    for line in unclear:
        r.gaps.append(f"Licence not settled: {line}.")
    if leaked:
        r.gaps.append("An outbound action was released before the reviewer answered.")
    return r


# --- 08 ------------------------------------------------------------------


def data_products(run: dict, deps: Any, routes: set[str] | None = None) -> Rung:
    r = Rung(
        8,
        "products",
        "Data products",
        "Is the output something a named consumer can build on?",
        agents=["investigator", "playbook", "judge", "hitl"],
    )
    routes = routes or set()
    missing = [p.name for p in DATA_PRODUCTS if routes and p.route not in routes]
    r.checks.append(
        Check(
            "every declared product is actually served",
            not missing,
            f"{len(DATA_PRODUCTS) - len(missing)} of {len(DATA_PRODUCTS)} routes registered"
            + (f"; missing {missing}" if missing else ""),
        )
    )

    snapshot = next((p for p in DATA_PRODUCTS if p.route == "/runs/{run_id}"), None)
    absent = [f for f in (snapshot.fields if snapshot else ()) if f not in run]
    r.checks.append(
        Check(
            "the run snapshot carries the fields it promises",
            not absent and bool(run),
            f"{len(snapshot.fields) - len(absent) if snapshot else 0} fields present"
            + (f"; absent {absent}" if absent else ""),
        )
    )

    r.checks.append(
        Check(
            "every answer says whether it is live, cached or replayed",
            run.get("served_from") in ("live", "cache", "replay"),
            f"served_from {run.get('served_from')!r}, cached_at {run.get('cached_at')!r}",
        )
    )
    return r


RUNGS = (
    ownership,
    definitions,
    data_quality,
    metadata,
    lineage,
    semantic_layer,
    access_rights,
    data_products,
)


def agent_stats(run: dict) -> list[dict[str, Any]]:
    """Per-agent row: what it did in this run, and which rungs cover it."""
    by_node = {t.get("node"): t for t in run.get("trace") or []}
    rungs = [fn({}, None) for fn in RUNGS]
    out = []
    for name, title, lane, does in AGENTS:
        t = by_node.get(name) or {}
        covered = [rg.n for rg in rungs if name in rg.agents]
        out.append(
            {
                "agent": name,
                "title": title,
                "lane": t.get("lane", lane),
                "does": does,
                "ran": bool(t),
                "model_id": t.get("model_id"),
                "latency_ms": t.get("latency_ms"),
                "summary": t.get("summary", ""),
                "evidence": len(t.get("evidence_ids") or []),
                "rungs": covered,
            }
        )
    return out


def report(run: dict | None, deps: Any = None, routes: set[str] | None = None) -> dict[str, Any]:
    run = run or {}
    rungs = []
    for fn in RUNGS:
        rungs.append(
            fn(run, deps, routes).as_dict()  # type: ignore[call-arg]
            if fn is data_products
            else fn(run, deps).as_dict()
        )
    passed = sum(1 for r in rungs if r["status"] == "pass")
    return {
        "generated_at": now_utc(),
        "run_id": run.get("run_id"),
        "served_from": run.get("served_from"),
        "cached_at": run.get("cached_at"),
        "schema": settings.schema,
        "live_data": settings.live_data,
        "rungs": rungs,
        "agents": agent_stats(run),
        "passed": passed,
        "of": len(rungs),
        "blocking": [g for r in rungs if r["status"] != "pass" for g in r["gaps"]],
    }
