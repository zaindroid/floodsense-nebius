"""The duty desk: events in, a decision, artifacts out.

The graph thinks in runs. A person on the desk thinks in events: a flood
happened, which policies are hit, what do we do in the next six hours.
This module is the translation, plus the four things an approval has to
produce before the app is worth anyone's morning.

  outbound(...)  one message per exposed site, ready to send by hand
  exposure_csv() the exposed policies, for the claims system
  record(...)    everything an auditor needs, in one payload
  dispatch(...)  posts the decision to a endpoint the operator nominated

Nothing here sends anything on its own. dispatch() refuses unless
DECISION_WEBHOOK names a target, and the caller has to ask for it.
"""

from __future__ import annotations

import csv
import io
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from floodsense_agents import labelling
from floodsense_agents.events import EVENTS
from floodsense_agents.governance import DEFINITIONS
from floodsense_agents.zetaris import now_utc

# Set DECISION_WEBHOOK to a URL the operator owns. Unset means dispatch is off,
# which is the default and the only safe default.
WEBHOOK_ENV = "DECISION_WEBHOOK"
DISPATCH_TIMEOUT_S = 10

# The question the desk opens a case with. Anything else on the same event is
# a replay or someone's ad-hoc question, and neither is the case.
DESK_QUESTION = "Which of our sites are at risk, and why?"


def webhook_target() -> str | None:
    v = os.environ.get(WEBHOOK_ENV)
    return v.strip() if v and v.strip() else None


def is_https_url(value: str) -> bool:
    """True for an https URL with a host. Same parse as the UI's new URL().

    http stays refused. javascript: and a scheme with no host are not links.
    """
    if not value or any(ch.isspace() for ch in value):
        return False
    try:
        parts = urllib.parse.urlparse(value)
        host = parts.hostname
    except ValueError:
        return False
    return parts.scheme.lower() == "https" and bool(host)


def _approval(run: dict) -> dict:
    return run.get("approval") or {}


def is_released(run: dict) -> bool:
    """Artifacts exist only after a reviewer let the actions go."""
    return _approval(run).get("status") in ("approved", "edited")


def is_case(row: dict) -> bool:
    """Is this run the case on the desk, or something else on the same event?

    Replays carry a replay timestamp and ad-hoc questions carry their own
    wording. Both belong in the audit list; neither should stand in for the
    case a reviewer has been deciding.
    """
    return row.get("question") == DESK_QUESTION and not row.get("replay_ts")


def events(past: list[dict]) -> list[dict[str, Any]]:
    """What the desk shows: every known event, and the case on it if any."""
    newest: dict[str, dict] = {}
    for row in past:
        eid = row.get("event_id")
        if eid and eid not in newest and is_case(row):  # past() is newest first
            newest[eid] = row
    out = []
    for spec in EVENTS.values():
        row = newest.get(spec.event_id)
        out.append(
            {
                "event_id": spec.event_id,
                "name": spec.name,
                "region": spec.region,
                "river": spec.river,
                "window_from_utc": spec.window_from_utc,
                "window_to_utc": spec.window_to_utc,
                "run_id": (row or {}).get("run_id"),
                "status": (row or {}).get("status"),
                "approval": (row or {}).get("approval"),
                "judge_overall": (row or {}).get("judge_overall"),
                "updated_at": (row or {}).get("updated_at"),
                # A row describes an answer computed earlier, never a live one.
                "label": labelling.label(
                    labelling.CACHE if row else None,
                    (row or {}).get("created_at"),
                    (row or {}).get("run_id"),
                )
                if row
                else None,
            }
        )
    return out


def moment(run: dict) -> dict[str, Any]:
    """What one replay moment knew, small enough to put seven on a screen."""
    hyps = run.get("hypotheses") or []
    exposure = run.get("exposure") or {}
    anomalies = run.get("anomalies") or []
    return {
        "replay_ts": run.get("replay_ts"),
        "links_supported": sum(1 for h in hyps if h.get("status") == "supported"),
        "links": len(hyps),
        "anomalies": len(anomalies),
        "policies": exposure.get("policies", 0),
        "sum_insured_eur": exposure.get("sum_insured_eur", 0.0),
        "actions": len(run.get("playbook") or []),
        "judge_overall": (run.get("judge_summary") or {}).get("overall"),
        "summary": run.get("summary", ""),
        "chain": [{"id": h["id"], "link": h.get("link"), "status": h.get("status")} for h in hyps],
    }


def summarise(run: dict) -> dict[str, Any]:
    """The two or three numbers the desk leads with."""
    exposure = run.get("exposure") or {}
    pb = run.get("playbook") or []
    return {
        "policies": exposure.get("policies", 0),
        "sum_insured_eur": exposure.get("sum_insured_eur", 0.0),
        "sites": len(exposure.get("assets") or []),
        "actions": len(pb),
        "outbound": sum(1 for a in pb if a.get("outbound")),
        "released": sum(1 for a in pb if a.get("released")),
        "judge_overall": (run.get("judge_summary") or {}).get("overall"),
    }


def outbound(run: dict) -> list[dict[str, Any]]:
    """One message per exposed site, largest sum insured first.

    The wording is the approved action text, not a paraphrase of it, so what
    the reviewer approved is what the policyholder reads.
    """
    actions = [a for a in run.get("playbook") or [] if a.get("outbound") and a.get("released")]
    if not actions:
        return []
    assets = sorted(
        (run.get("exposure") or {}).get("assets") or [],
        key=lambda a: a.get("sum_insured_eur") or 0,
        reverse=True,
    )
    event = run.get("event") or {}
    body = "\n\n".join(a["text"] for a in actions)
    return [
        {
            "policy_id": a.get("policy_id"),
            "site_id": a.get("site_id"),
            "segment": a.get("segment"),
            "sum_insured_eur": a.get("sum_insured_eur"),
            "subject": f"Flood affecting your site — {event.get('name', run.get('event_id', ''))}",
            "body": body,
            "action_ids": [a["action_id"] for a in actions],
        }
        for a in assets
    ]


def exposure_csv(run: dict) -> str:
    """The exposed policies, in the shape a claims system can swallow."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(
        [
            "event_id",
            "run_id",
            "policy_id",
            "site_id",
            "segment",
            "sum_insured_eur",
            "lat",
            "lon",
            "in_footprint",
            "decided_by",
            "decided_at_utc",
        ]
    )
    ap = _approval(run)
    for a in (run.get("exposure") or {}).get("assets") or []:
        w.writerow(
            [
                run.get("event_id", ""),
                run.get("run_id", ""),
                a.get("policy_id", ""),
                a.get("site_id", ""),
                a.get("segment", ""),
                a.get("sum_insured_eur", ""),
                a.get("lat", ""),
                a.get("lon", ""),
                1,
                ap.get("reviewer", ""),
                ap.get("decided_at_utc", ""),
            ]
        )
    return buf.getvalue()


def record(run: dict) -> dict[str, Any]:
    """Everything needed to defend the decision later, in one payload."""
    ap = _approval(run)
    claims = run.get("claims") or []
    sources = []
    seen = set()
    for c in claims:
        for ct in c.get("citations") or []:
            key = (ct.get("publisher"), ct.get("licence"), ct.get("source_url"))
            if ct.get("layer") == "b" and key not in seen:
                seen.add(key)
                sources.append(
                    {
                        "publisher": ct.get("publisher"),
                        "licence": ct.get("licence"),
                        "source_url": ct.get("source_url"),
                        "title": ct.get("title"),
                    }
                )
    return {
        "event_id": run.get("event_id"),
        "event": run.get("event"),
        "run_id": run.get("run_id"),
        "served_from": run.get("served_from"),
        "cached_at": run.get("cached_at"),
        "question": (run.get("request") or {}).get("question"),
        "summary": run.get("summary"),
        "figures": summarise(run),
        "claims": claims,
        "hypotheses": run.get("hypotheses") or [],
        "playbook": run.get("playbook") or [],
        "judge_summary": run.get("judge_summary") or {},
        "approval": ap,
        "sources": sources,
        "definitions": [
            {"term": d.term, "value": d.value, "unit": d.unit, "wording": d.wording}
            for d in DEFINITIONS.values()
        ],
        "generated_at": now_utc(),
    }


def dispatch_payload(run: dict) -> dict[str, Any]:
    """What would be posted. Readable before anything is sent."""
    ap = _approval(run)
    return {
        "event_id": run.get("event_id"),
        "run_id": run.get("run_id"),
        "decision": ap.get("decision"),
        "reviewer": ap.get("reviewer"),
        "decided_at_utc": ap.get("decided_at_utc"),
        "policies": [a.get("policy_id") for a in (run.get("exposure") or {}).get("assets") or []],
        "sum_insured_eur": (run.get("exposure") or {}).get("sum_insured_eur"),
        "actions": [
            {"action_id": a["action_id"], "text": a["text"], "outbound": a.get("outbound", False)}
            for a in run.get("playbook") or []
            if a.get("released")
        ],
        "judge_overall": (run.get("judge_summary") or {}).get("overall"),
    }


def dispatch(run: dict) -> dict[str, Any]:
    """Post the decision to the nominated endpoint. Off unless one is set."""
    target = webhook_target()
    if not target:
        return {
            "sent": False,
            "reason": f"no endpoint nominated; set {WEBHOOK_ENV} to switch this on",
            "payload": dispatch_payload(run),
        }
    if not is_https_url(target):
        return {
            "sent": False,
            "reason": f"{WEBHOOK_ENV} must be an https URL",
            "payload": dispatch_payload(run),
        }
    payload = dispatch_payload(run)
    body = json.dumps(payload).encode()
    req = urllib.request.Request(  # noqa: S310 - scheme checked above
        target,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=DISPATCH_TIMEOUT_S) as res:  # noqa: S310
            return {"sent": True, "status": res.status, "target": target, "payload": payload}
    except urllib.error.HTTPError as e:
        return {"sent": False, "reason": f"endpoint answered {e.code}", "payload": payload}
    except Exception as e:  # noqa: BLE001 - the desk reports, it does not crash
        return {"sent": False, "reason": f"{type(e).__name__}: {e}", "payload": payload}
