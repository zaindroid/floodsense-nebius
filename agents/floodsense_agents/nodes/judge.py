"""LLM-as-a-Judge. Scores each claim between the Playbook and the human.

It approves, deletes and rewrites nothing. Flagged claims may get one repair
round back to the Playbook; the human sees the scores either way.

Per claim:
  coverage           >= 1 citation                                   deterministic
  citation_faithful  layer (a) query returned rows; layer (c) quote is in that passage   deterministic
  numbers_match      every number in the claim is in its cited rows (relative tolerance NUMERIC_TOLERANCE)   deterministic
  licence_ok         no full text shown from a pointer-only source                               deterministic
  grounding          supported | partial | unsupported — deep lane seeing only the claim and its evidence;
                     a reply that will not parse, or that has no grounding, falls back to the deterministic checks
                     and records model_id deterministic
  score              0.4 grounding + 0.2 coverage + 0.2 faithful + 0.2 numbers

State: judge[] = one JudgeScore per claim (contract); judge_summary = overall, hallucination_rate (unsupported / n),
citation_coverage, numeric_accuracy, passes, flagged ids, model_id (extra).
"""

from __future__ import annotations

import hashlib
import logging
import math
import time

from floodsense_agents.models import Citation, Claim, Evidence, JudgeScore, JudgeSummary
from floodsense_agents.nightshift import map_ordered, parse_json
from floodsense_agents.prompts import JUDGE, rows_block
from floodsense_agents.settings import settings
from floodsense_agents.state import Deps, FloodState, trace

log = logging.getLogger("floodsense.judge")
_G = {"supported": 1.0, "partial": 0.5, "unsupported": 0.0}


def _values(evs: list[Evidence]) -> list[float]:
    vals: list[float] = []
    for e in evs:
        vals.append(float(e.row_count))
        for r in e.rows_sample:
            for v in r.values():
                if isinstance(v, bool):
                    continue
                if isinstance(v, (int, float)):
                    vals.append(float(v))
                elif isinstance(v, str):
                    try:
                        vals.append(float(v.replace(",", ".")))
                    except ValueError:
                        pass
        # sums over a numeric column are legitimate derived numbers (totals in a claim)
        if e.rows_sample:
            for k in e.rows_sample[0]:
                col = [
                    r[k]
                    for r in e.rows_sample
                    if isinstance(r.get(k), (int, float)) and not isinstance(r.get(k), bool)
                ]
                if len(col) == len(e.rows_sample) and col:
                    vals.append(float(sum(col)))
    return vals


def _norm(text: str) -> str:
    return " ".join((text or "").split())


def asserted_excerpt(text: str) -> str:
    """The quoted excerpt a document claim asserts ("..." in its text), whitespace-normalised."""
    import re

    m = re.search(r"[\"\u201c](.+?)[\"\u201d]", text or "", re.S)
    return _norm(m.group(1)) if m else ""


def _quote_numbers(text: str) -> list[float]:
    from floodsense_agents.nodes.investigator import numbers_in

    return numbers_in(text)


def _match(n: float, vals: list[float]) -> bool:
    tol = settings.numeric_tolerance
    return any(math.isclose(n, v, rel_tol=tol, abs_tol=0.5 if abs(n) < 10 else 0.0) for v in vals)


def _passage_rows(citation: Citation, rows: list[dict]) -> list[dict]:
    """The chunk named on the citation, or every row when the sample has no chunk id."""
    chunk_id = citation.chunk_id
    if not isinstance(chunk_id, str) or not chunk_id:
        return rows
    if not any(isinstance(row.get("chunk_id"), str) for row in rows):
        return rows
    return [row for row in rows if row.get("chunk_id") == chunk_id]


def layer_c_matches_passage(citation: Citation, evidence: dict[str, Evidence]) -> bool:
    if not citation.quote or not citation.content_sha256:
        return False
    if hashlib.sha256(citation.quote.encode()).hexdigest() != citation.content_sha256:
        return False
    ev = evidence.get(citation.query_id or "")
    if ev is None or ev.error or not ev.rows_sample:
        return False
    for row in _passage_rows(citation, ev.rows_sample):
        text = row.get("text")
        digest = row.get("text_sha256")
        if not isinstance(text, str) or not isinstance(digest, str):
            continue
        if hashlib.sha256(text.encode()).hexdigest() != digest:
            continue
        if citation.quote in text:
            return True
    return False


def score_claim(c: Claim, evidence: dict[str, Evidence], deps: Deps | None) -> JudgeScore:
    a = [evidence[x.query_id] for x in c.citations if x.layer == "a" and x.query_id in evidence]
    coverage = len(c.citations) > 0
    faithful = bool(a) and all(e.row_count > 0 and not e.error for e in a)
    docs = [x for x in c.citations if x.layer == "c" and x.quote and x.content_sha256]
    # Document-only: no layer-(a) citation at all. A claim whose layer-(a) query
    # ids are missing from the evidence is not document-only; it is unsupported.
    doc_only = bool(docs) and not any(x.layer == "a" for x in c.citations)
    if doc_only:
        # Faithful only when every quote verifies against its chunk and at least one
        # verified quote contains what the claim asserts (its quoted excerpt).
        verified = [x for x in docs if layer_c_matches_passage(x, evidence)]
        asserted = asserted_excerpt(c.text)
        faithful = (
            len(verified) == len(docs)
            and bool(asserted)
            and any(asserted in _norm(x.quote or "") for x in verified)
        )
    else:
        for x in docs:
            faithful = faithful and layer_c_matches_passage(x, evidence)
    licence_ok = all(
        not (x.storage == "pointer" and x.quote and len(x.quote) > 400) for x in c.citations
    )
    vals = _values(a)
    if doc_only:
        # Numbers of a document claim are checked against its quotes.
        vals = [v for x in docs for v in _quote_numbers(x.quote or "")]
    numbers_match = all(_match(n, vals) for n in c.numbers) if (a or doc_only) else not c.numbers
    if not c.numbers and c.numbers_dropped:
        # Every stated number was set aside as a date part, a line or a filter:
        # nothing was checked against the rows, so this is unverified, not a pass.
        numbers_match = False
    grounding, rationale, model_id = None, "", "deterministic"
    if deps is not None and a:
        try:
            text, answered_by = deps.llm.complete(
                "deep",
                JUDGE,
                f"CLAIM {c.claim_id}: {c.text}\nNUMBERS: {c.numbers}\n\nCITED "
                f"EVIDENCE:\n{rows_block(a)}",
            )
            js = parse_json(text)
            if js.get("grounding") in _G:
                grounding, rationale = js["grounding"], str(js.get("rationale", ""))[:300]
                model_id = answered_by
        except Exception as e:
            log.debug("judge: model grounding skipped (%s)", str(e)[:100])
    if grounding is None:
        # The reply did not parse, or it had no grounding. model_id stays deterministic.
        if not coverage or not faithful:
            grounding, rationale = (
                "unsupported",
                "no citation" if not coverage else "cited query returned no rows or failed",
            )
        elif not numbers_match:
            grounding, rationale = "unsupported", f"numbers {c.numbers} not found in the cited rows"
        else:
            grounding, rationale = (
                "supported",
                "citation resolves and every number is in the cited rows",
            )
    if (
        grounding == "supported" and not numbers_match
    ):  # deterministic floor: a number the rows do not hold is never 'supported'
        grounding, rationale = (
            "partial",
            f"model said supported, but numbers {c.numbers} are not in the cited rows",
        )
    if not coverage or not faithful:
        grounding = "unsupported"
    score = round(0.4 * _G[grounding] + 0.2 * coverage + 0.2 * faithful + 0.2 * numbers_match, 3)
    return JudgeScore(
        claim_id=c.claim_id,
        grounding=grounding,
        citation_faithful=faithful,
        numbers_match=numbers_match,
        coverage=coverage,
        licence_ok=licence_ok,
        score=score,
        rationale=rationale,
        model_id=model_id,
    )


def evaluate(
    claims: list[Claim], evidence: dict[str, Evidence], deps: Deps | None
) -> tuple[list[JudgeScore], JudgeSummary]:
    if not claims:
        return [], JudgeSummary(
            overall=0.0,
            n_claims=0,
            hallucination_rate=1.0,
            citation_coverage=0.0,
            numeric_accuracy=1.0,
            passes=False,
            flagged_claim_ids=[],
            model_id="deterministic",
        )
    # One grounding call per claim, concurrently; scores keep claim order.
    scores = map_ordered(lambda c: score_claim(c, evidence, deps), claims)
    n = len(scores)
    with_numbers = [s for s, c in zip(scores, claims) if c.numbers]
    h = sum(1 for s in scores if s.grounding == "unsupported") / n
    cov = sum(1 for s in scores if s.coverage) / n
    num = (
        (sum(1 for s in with_numbers if s.numbers_match) / len(with_numbers))
        if with_numbers
        else 1.0
    )
    overall = round(sum(s.score for s in scores) / n, 3)
    # S5: licence_ok was computed per claim and then left out of the flag
    # set, so a claim quoting too much from a pointer-only source passed
    # review silently. The score formula is unchanged, so earlier eval
    # numbers stay comparable; what changes is that it gets flagged.
    flagged = [s.claim_id for s in scores if s.grounding == "unsupported" or not s.licence_ok]
    model_ids = {s.model_id for s in scores}
    return scores, JudgeSummary(
        overall=overall,
        n_claims=n,
        hallucination_rate=round(h, 4),
        citation_coverage=round(cov, 4),
        numeric_accuracy=round(num, 4),
        passes=(h <= 0.05 and cov >= 1.0 and overall >= settings.judge_min_score),
        flagged_claim_ids=flagged,
        model_id=",".join(sorted(model_ids)),
    )


def make(deps: Deps):
    def judge(state: FloodState) -> dict:
        claims = [Claim(**c) for c in state["claims"]]
        evidence = {q: Evidence(**e) for q, e in state["evidence"].items()}
        t = time.time()
        scores, rep = evaluate(claims, evidence, deps)
        return {
            "judge": [s.model_dump() for s in scores],
            "judge_summary": rep.model_dump(),
            "repair_rounds": state.get("repair_rounds", 0),
            "trace": trace(
                state,
                "judge",
                f"{'PASS' if rep.passes else 'FLAG'} overall={rep.overall:.2f} "
                f"coverage={rep.citation_coverage:.0%} numbers={rep.numeric_accuracy:.0%} "
                f"flagged={rep.flagged_claim_ids or '-'}",
                lane="deep" if deps and rep.model_id != "deterministic" else "none",
                model_id=rep.model_id,
                started=t,
            ),
        }

    return judge


def needs_repair(state: FloodState) -> bool:
    """Flagged claims, a repair round left, and (unless configured) a failing run.

    The Judge router and the Playbook both read this, so they never disagree.
    A run that already passes goes to the human with its flags shown.
    """
    rep = state.get("judge_summary") or {}
    if not rep.get("flagged_claim_ids"):
        return False
    if state.get("repair_rounds", 0) >= settings.judge_repair_rounds:
        return False
    return settings.judge_repair_when_passing or not rep.get("passes")


def route_after_judge(state: FloodState) -> str:
    return "repair" if needs_repair(state) else "hitl"


# kept for the skeleton's import surface
def run(state: dict) -> dict:
    """Score the claims in `state` without a model (deterministic checks only)."""
    claims = [Claim(**c) for c in state.get("claims", [])]
    evidence = {q: Evidence(**e) for q, e in state.get("evidence", {}).items()}
    scores, summary = evaluate(claims, evidence, None)
    return {
        "node": "judge",
        "status": "ok",
        "scores": [s.model_dump() for s in scores],
        "summary": summary.model_dump(),
        "run_id": state.get("run_id"),
    }
