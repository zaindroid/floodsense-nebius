"""Playbook. Actions for the next 6 / 24 / 72 hours, citing the claims they rest on.

Outbound actions (anything that contacts a person or an authority) are marked
and wait for the human. The deterministic path writes a standard set from the
exposure; the fast lane, when available, writes richer ones and is validated
against the claim ids. A model action that cites no claim of this run is
dropped: every action has to rest on cited evidence (GAMEPLAN v0.6.0). A repair
round, after the Judge flags a claim, stays on the deep lane.

It also owns the repair round: when the Judge flags a claim, the Playbook
rewrites or shortens it to what its evidence shows. Nothing is deleted.
"""

from __future__ import annotations

import logging
import time

from floodsense_agents.models import Claim, Evidence, PlaybookAction
from floodsense_agents.nightshift import parse_json
from floodsense_agents.nodes.investigator import numbers_in
from floodsense_agents.nodes.judge import needs_repair
from floodsense_agents.prompts import PLAYBOOK, REPAIR, rows_block
from floodsense_agents.state import Deps, FloodState, trace

log = logging.getLogger("floodsense.playbook")


def _deterministic(state: FloodState) -> list[PlaybookAction]:
    claims = state["claims"]
    h4 = [c["claim_id"] for c in claims if c.get("hypothesis_id") == "H4"]
    chain = [c["claim_id"] for c in claims if c.get("hypothesis_id") in ("H1", "H2", "H3")][:3]
    if not h4:
        return [
            PlaybookAction(
                action_id="A1",
                horizon_h=24,
                claim_ids=chain,
                text="No insured site is inside the mapped footprint; keep watching the gauges and "
                "the "
                "footprint updates.",
            )
        ]
    return [
        PlaybookAction(
            action_id="A1",
            horizon_h=6,
            outbound=True,
            claim_ids=h4,
            text="Send a safety and claims-readiness message to policyholders at the exposed sites "
            "(largest sum insured first): move stock and vehicles above ground level, document "
            "damage, do not enter flooded basements.",
        ),
        PlaybookAction(
            action_id="A2",
            horizon_h=6,
            claim_ids=h4 + chain,
            text="Open an event file with the exposed policy list and reserve capacity for the sum "
            "insured at risk.",
        ),
        PlaybookAction(
            action_id="A3",
            horizon_h=24,
            outbound=True,
            claim_ids=h4,
            text="Pre-assign loss adjusters to the footprint municipalities and book site access "
            "once "
            "the authority lifts the alert.",
        ),
        PlaybookAction(
            action_id="A4",
            horizon_h=72,
            claim_ids=chain,
            text="Re-run the exposure join when the Copernicus footprint is updated and the gauges "
            "report again; revise reserves.",
        ),
    ]


ACTION_TYPES = (
    "notify-policyholders",
    "dispatch-loss-adjuster",
    "flag-underwriting-review",
    "inform-public",
)
TITLES = {
    "notify-policyholders": "Notify exposed policyholders",
    "dispatch-loss-adjuster": "Dispatch loss adjusters",
    "flag-underwriting-review": "Flag for underwriting review",
    "inform-public": "Inform the public",
}
# Fixed closing line per action type. No number, place or organisation.
STEPS = {
    "notify-policyholders": "Please keep yourself safe and keep records of any damage for your claim.",
    "dispatch-loss-adjuster": "A loss adjuster will contact you to arrange a visit.",
    "flag-underwriting-review": "This is flagged for underwriting review.",
    "inform-public": "Please follow the instructions of the local authorities.",
}
DRAFT_CLAIMS_MAX = 3


def infer_type(text: str) -> str | None:
    """An action type from the action's own words, when the model gave none."""
    t = (text or "").lower()
    if "adjuster" in t:
        return "dispatch-loss-adjuster"
    if "policyholder" in t or "customer" in t:
        return "notify-policyholders"
    if any(w in t for w in ("public", "citizen", "resident", "authority", "authorities")):
        return "inform-public"
    if any(w in t for w in ("reserve", "underwrit", "review", "event file", "exposure join")):
        return "flag-underwriting-review"
    return None


def affected_sites(state: FloodState) -> int | None:
    """Distinct exposed sites from the Exposure node, or None when not knowable.

    exposure.assets is a sample of at most 20 rows; the count is exact only
    when the sample holds every policy (policies <= len(assets)). A failed
    query or a footprint not published yet is unknown, not zero.
    """
    exp = state.get("exposure") or {}
    qids = exp.get("query_ids") or []
    if not qids:
        return None
    evidence = state.get("evidence") or {}
    if any((evidence.get(q) or {}).get("error") for q in qids):
        return None
    h4 = next((h for h in state.get("hypotheses") or [] if h.get("id") == "H4"), {})
    if "not published" in str(h4.get("statement") or ""):
        return None
    policies = int(exp.get("policies") or 0)
    assets = [a for a in exp.get("assets") or [] if isinstance(a, dict)]
    if policies == 0:
        return 0
    if len(assets) < policies:
        return None
    return len({a.get("site_id") for a in assets if a.get("site_id")})


def draft_for(action: PlaybookAction, state: FloodState) -> str | None:
    """The message an outbound action would send.

    Deterministic only: a fixed template, the event region from the event
    spec, the cited claims' texts verbatim and a fixed step per action type.
    No model text reaches it, so it can state nothing the cited claims do not.
    """
    if not action.outbound:
        return None
    claims = {c["claim_id"]: c for c in state.get("claims") or []}
    facts = [claims[i]["text"] for i in action.claim_ids if i in claims][:DRAFT_CLAIMS_MAX]
    if not facts:
        return None
    # The region only: the event name carries a date, which no claim cites.
    head = (state.get("event") or {}).get("region")
    step = STEPS.get(action.action_type or "", "")
    intro = f"FloodSense EU flood update ({head}). " if head else "FloodSense EU flood update. "
    return intro + " ".join(facts) + (f" {step}" if step else "")


def fill_card(
    action: PlaybookAction,
    state: FloodState,
    raw: dict | None = None,
) -> PlaybookAction:
    """Approval-card fields. The model's values when valid, deterministic otherwise."""
    raw = raw or {}
    kind = raw.get("action_type")
    if kind not in ACTION_TYPES:
        kind = infer_type(action.text)
    title = str(raw.get("title") or "").strip()[:80] or (TITLES.get(kind) if kind else None)
    ev = state.get("event") or {}
    out = action.model_copy(
        update={
            "action_type": kind,
            "title": title or " ".join(action.text.split()[:6]).rstrip(".,;:"),
            "target_region": ev.get("region") or None,
            "affected_site_count": affected_sites(state),
        }
    )
    # A model's draft_message is ignored: the draft is built, never written freely.
    return out.model_copy(update={"draft_message": draft_for(out, state)})


MAX_ACTIONS = 4  # the prompt asks for at most 4; more are cut, not shown
TOP_ASSETS = 5  # largest exposed sites shown to the model


def _prompt(state: FloodState) -> str:
    """The Playbook's user prompt, compact so the call fits the Nightshift gateway.

    The chain, one line per claim, and the exposure as totals, segments and
    the largest sites only: the full asset list is what made the prompt large.
    """
    exp = state.get("exposure") or {}
    assets = sorted(
        (a for a in exp.get("assets") or [] if isinstance(a, dict)),
        key=lambda a: -float(a.get("sum_insured_eur") or 0),
    )[:TOP_ASSETS]
    hyps = "\n".join(
        f"{h['id']} {h['link']} [{h.get('status', 'proposed')}]: {h['statement']}"
        for h in state["hypotheses"]
    )
    return (
        f"CHAIN: {state.get('summary')}\nHYPOTHESES:\n{hyps}\nCLAIMS:\n"
        + "\n".join(f"{c['claim_id']}: {c['text']}" for c in state["claims"])
        + f"\nEXPOSURE: {exp.get('policies', 0)} policies, sum insured "
        f"{float(exp.get('sum_insured_eur') or 0):.0f} EUR; by segment "
        f"{(exp.get('by_segment') or [])[:8]}; largest sites "
        f"{[{k: a.get(k) for k in ('policy_id', 'segment', 'sum_insured_eur') if k in a} for a in assets]}"
    )


def make(deps: Deps):
    def playbook(state: FloodState) -> dict:
        t = time.time()
        # S6: this used to stop at 1 while the Judge routed back while
        # repair_rounds < JUDGE_REPAIR_ROUNDS. With the knob at 2 the two
        # disagreed and the graph hit its recursion limit. One bound, read
        # from the same setting.
        if needs_repair(state):
            return _repair(state, deps, t)
        actions = [fill_card(a, state) for a in _deterministic(state)]
        model_id = "deterministic"
        lane = "none"
        uncited = 0
        try:
            text, model_id = deps.llm.complete(
                "fast",
                PLAYBOOK.replace("{lang}", state["request"].get("lang", "en")),
                _prompt(state),
            )
            js = parse_json(text)
            ids = {c["claim_id"] for c in state["claims"]}
            drafted = [
                fill_card(
                    PlaybookAction(
                        action_id=str(a["action_id"]),
                        horizon_h=a["horizon_h"] if a.get("horizon_h") in (6, 24, 72) else 24,
                        text=str(a["text"]),
                        claim_ids=[i for i in a.get("claim_ids", []) if i in ids],
                        outbound=bool(a.get("outbound", False)),
                    ),
                    state,
                    a,
                )
                for a in js.get("actions", [])[:MAX_ACTIONS]
            ]
            # An action that cites nothing (or only claim ids this run does not
            # have) rests on no evidence. It is dropped rather than shown.
            got = [a for a in drafted if a.claim_ids]
            uncited = len(drafted) - len(got)
            if got:
                actions, lane = got, "fast"
        except Exception as e:
            log.warning("playbook: model step skipped (%s)", str(e)[:120])
        return {
            "playbook": [a.model_dump() for a in actions],
            "model_ids": [*state.get("model_ids", []), model_id],
            "trace": trace(
                state,
                "playbook",
                f"{len(actions)} actions, {sum(a.outbound for a in actions)} outbound (await "
                f"approval)" + (f"; {uncited} uncited draft(s) dropped" if uncited else ""),
                lane=lane,
                model_id=model_id,
                started=t,
            ),
        }

    return playbook


def _repair(state: FloodState, deps: Deps, t: float) -> dict:
    flagged = set(state["judge_summary"]["flagged_claim_ids"])
    claims = [Claim(**c) for c in state["claims"]]
    ev = {q: Evidence(**e) for q, e in state["evidence"].items()}
    fixed: dict[str, dict] = {}
    model_id = "deterministic"
    try:
        user = (
            "FLAGGED CLAIMS:\n"
            + "\n".join(f"{c.claim_id}: {c.text}" for c in claims if c.claim_id in flagged)
            + "\n\nEVIDENCE THEY CITE:\n"
            + rows_block(
                [
                    ev[x.query_id]
                    for c in claims
                    if c.claim_id in flagged
                    for x in c.citations
                    if x.layer == "a" and x.query_id in ev
                ]
            )
        )
        text, model_id = deps.llm.complete("deep", REPAIR, user)
        for c in parse_json(text).get("claims", []):
            if c.get("claim_id") in flagged and c.get("text"):
                fixed[c["claim_id"]] = c
    except Exception as e:
        log.warning("repair: model step skipped (%s)", str(e)[:120])
    for c in claims:
        if c.claim_id not in flagged:
            continue
        if c.claim_id in fixed:
            c.text = str(fixed[c.claim_id]["text"])
            c.numbers = [float(x) for x in fixed[c.claim_id].get("numbers", [])] or numbers_in(
                c.text
            )
        else:  # deterministic: shorten to the cited evidence, keep it visible
            src = next(
                (ev[x.query_id] for x in c.citations if x.layer == "a" and x.query_id in ev), None
            )
            c.text = (
                f"[repaired] The cited query ({src.view}, {src.row_count} rows) does not support "
                f"the earlier wording; see evidence {src.query_id[:8]}."
                if src
                else "[repaired] This claim cited no evidence with rows and is withdrawn pending data."
            )
            c.numbers = []
    # A draft that quoted a rewritten claim is rebuilt from the new wording.
    repaired = {**state, "claims": [c.model_dump() for c in claims]}
    playbook = []
    for a in state.get("playbook") or []:
        if flagged & set(a.get("claim_ids") or []):
            act = PlaybookAction(**a)
            a = {**a, "draft_message": draft_for(act, repaired)}
        playbook.append(a)
    return {
        "playbook": playbook,
        "claims": repaired["claims"],
        "repair_rounds": state.get("repair_rounds", 0) + 1,
        "trace": trace(
            state,
            "playbook",
            f"repair round 1: {len(flagged)} flagged claim(s) rewritten to their evidence",
            lane="deep" if fixed else "none",
            model_id=model_id,
            started=t,
        ),
    }
