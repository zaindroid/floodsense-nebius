"""Project a graph run onto the shared JSON Schema.

The agents keep their own state: extra claim fields, evidence as a dict,
playbook ``text``, and one approval for the run. The UI binds to
``contracts/schemas/floodsense.schema.json``. This module is that projection
at the API boundary. It does not write back into the graph.

``judge_claim.model_id`` accepts the routing names ``meterless/fast`` and
``meterless/deep``, the concrete Nightshift ids a reply may carry, and
``deterministic``. Which model answers a routing name today is the table at
the top of ``docs/architecture/c4.md``. This module does not substitute one
id for another. When the graph id is outside the enum, the judge is omitted.
Lane choice stays in ``settings.lane``.
"""

from __future__ import annotations

import hashlib
import re
import urllib.parse
from typing import Any

_DT = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"
)
_DATE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
# Zetaris returns a timestamp as 2026-10-23 00:00:00.0, so the fraction is
# optional rather than absent. Without it a provenance row's fetched_at does
# not parse and the citation it backs is dropped.
_LOOSE_UTC = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?$")


def _http_url(value: object) -> bool:
    """http or https with a host, parsed the way the UI uses new URL().

    javascript:, a bare scheme, and whitespace are not links. The allowlist
    stays those two schemes.
    """
    if not isinstance(value, str) or not value or any(ch.isspace() for ch in value):
        return False
    try:
        parts = urllib.parse.urlparse(value)
        host = parts.hostname
    except ValueError:
        return False
    return parts.scheme.lower() in {"http", "https"} and bool(host)

# Copied from judge_claim.model_id so a graph id is kept or the judge is
# dropped. Not a map onto these ids. The API image does not ship the schema
# file, so this set is the runtime copy and must match the schema enum.
_SCHEMA_MODEL_IDS = frozenset(
    {
        "meterless/fast",
        "meterless/deep",
        "nvidia/nemotron-3.5-super-vl-120b-a12b",
        "nvidia/nemotron-3.5-lightning-30b-a3b",
        "nvidia/Nemotron-3.5-Super-VL",
        "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
        "deterministic",
    }
)

_APPROVAL = {
    "not_reached": "pending",
    "awaiting": "pending",
    "pending": "pending",
    "approved": "approved",
    "edited": "edited",
    "rejected": "rejected",
}


def _as_dt(value: Any) -> str | None:
    """A timestamp the payload already carried. Never a stand-in epoch."""
    if isinstance(value, str):
        if _DT.match(value):
            return value
        if _DATE.match(value):
            return f"{value}T00:00:00Z"
        match = _LOOSE_UTC.fullmatch(value.strip())
        if match:
            date, hour, minute, second = match.groups()
            return f"{date}T{hour}:{minute}:{second or '00'}Z"
    return None


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _evidence_records(body: dict[str, Any]) -> list[dict[str, Any]]:
    raw = body.get("evidence")
    if isinstance(raw, dict):
        rows = [v for v in raw.values() if isinstance(v, dict)]
    elif isinstance(raw, list):
        rows = [v for v in raw if isinstance(v, dict)]
    else:
        rows = []
    return rows


def _project_evidence(body: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for row in _evidence_records(body):
        # A failed query is not an empty success. Dropping ``error`` and
        # keeping the row would look like the read returned nothing.
        if row.get("error"):
            continue
        query_id = row.get("query_id")
        view = row.get("view")
        sql = row.get("sql")
        executed = _as_dt(row.get("executed_at_utc"))
        if not all(isinstance(v, str) and v for v in (query_id, view, sql, executed)):
            continue
        if not _DT.match(executed):
            continue
        sample = row.get("rows_sample") or []
        if not isinstance(sample, list):
            sample = []
        sample = [r for r in sample if isinstance(r, dict)][:20]
        count = row.get("row_count")
        if not isinstance(count, int) or isinstance(count, bool):
            count = len(sample)
        out.append(
            {
                "query_id": query_id,
                "view": view,
                "sql": sql,
                "rows_sample": sample,
                "row_count": count,
                "executed_at_utc": executed,
            }
        )
    return out


def _provenance_row(view: str, provenance: list[dict[str, Any]]) -> dict[str, Any]:
    dataset = view.split(".")[-1]
    for row in provenance:
        if row.get("dataset") == dataset and row.get("source_url"):
            return row
    for row in provenance:
        if row.get("dataset") == dataset:
            return row
    return {}


def _projected_locator(locator: object) -> dict[str, Any] | None:
    """Copy a page locator. A null section is omitted; page below 1 is not a locator."""
    if not isinstance(locator, dict):
        return None
    page = locator.get("page")
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        return None
    out: dict[str, Any] = {"page": page}
    paragraph = locator.get("paragraph")
    if isinstance(paragraph, int) and not isinstance(paragraph, bool) and paragraph >= 1:
        out["paragraph"] = paragraph
    lines = locator.get("lines")
    if isinstance(lines, str) and lines:
        out["lines"] = lines
    section = locator.get("section")
    if isinstance(section, str) and section:
        out["section"] = section
    return out


def _project_citations(
    claims: list[dict[str, Any]], evidence: list[dict[str, Any]], provenance: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    by_query = {e["query_id"]: e for e in evidence}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for claim in claims:
        claim_id = claim.get("claim_id")
        if not isinstance(claim_id, str) or not claim_id:
            continue
        for raw in claim.get("citations") or []:
            if not isinstance(raw, dict):
                continue
            citation_id = raw.get("citation_id")
            layer = raw.get("layer")
            if (
                not isinstance(citation_id, str)
                or not citation_id
                or layer not in ("a", "b", "c")
                or citation_id in seen
            ):
                continue
            query_id = raw.get("query_id") if isinstance(raw.get("query_id"), str) else None
            ev = by_query.get(query_id or "")
            prov = _provenance_row((ev or {}).get("view") or raw.get("title") or "", provenance)
            source = raw.get("source_url") or prov.get("source_url")
            # http(s) only. A urn: stand-in fails the Vite rule and is not a source.
            if not _http_url(source):
                continue
            accessed = _as_dt(raw.get("accessed_at") or prov.get("fetched_at"))
            if accessed is None:
                continue
            title = raw.get("title") or (ev or {}).get("view") or prov.get("dataset")
            publisher = raw.get("publisher") or prov.get("publisher")
            licence = raw.get("licence") or prov.get("licence")
            attribution = raw.get("attribution") or prov.get("attribution")
            if not all(isinstance(v, str) and v.strip() for v in (title, publisher, licence, attribution)):
                continue
            quote = raw.get("quote") if isinstance(raw.get("quote"), str) else None
            hashed = quote if quote else source
            item: dict[str, Any] = {
                "citation_id": citation_id,
                "claim_id": claim_id,
                "layer": layer,
                "source_url": source,
                "title": title,
                "publisher": publisher,
                "accessed_at": accessed,
                "licence": licence,
                "attribution": attribution,
                "content_sha256": raw.get("content_sha256")
                if isinstance(raw.get("content_sha256"), str)
                and re.fullmatch(r"[a-f0-9]{64}", raw["content_sha256"])
                else _sha(hashed),
                "storage": raw.get("storage") if raw.get("storage") in ("full_text", "pointer") else "pointer",
            }
            if query_id:
                item["query_id"] = query_id
            if quote and len(quote) <= 600:
                item["quote"] = quote
            locator = _projected_locator(raw.get("locator"))
            if locator is not None:
                item["locator"] = locator
            chunk_id = raw.get("chunk_id")
            if isinstance(chunk_id, str) and 1 <= len(chunk_id) <= 128:
                item["chunk_id"] = chunk_id
            seen.add(citation_id)
            out.append(item)
    return out


def _dropped(raw: Any) -> dict[str, Any]:
    """{"numbers_dropped": [...]} with the well-formed entries, or {} when there are none."""
    out = []
    for d in raw or []:
        if not isinstance(d, dict) or not isinstance(d.get("reason"), str):
            continue
        v = d.get("value")
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            continue
        out.append({"value": float(v), "reason": d["reason"]})
    return {"numbers_dropped": out} if out else {}


def _project_judge(body: dict[str, Any]) -> dict[str, Any] | None:
    raw = body.get("judge")
    if not isinstance(raw, list) or not raw:
        return None
    dropped_by_id = {
        c.get("claim_id"): c.get("numbers_dropped")
        for c in body.get("claims") or []
        if isinstance(c, dict) and isinstance(c.get("numbers_dropped"), list)
    }
    claims = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        grounding = row.get("grounding")
        if grounding not in ("supported", "partial", "unsupported"):
            continue
        claim_id = row.get("claim_id")
        rationale = row.get("rationale")
        if not isinstance(claim_id, str) or not claim_id:
            continue
        if not isinstance(rationale, str) or not rationale.strip():
            rationale = "Score recorded from the deterministic checks."
        try:
            score = float(row.get("score"))
        except (TypeError, ValueError):
            continue
        if score < 0 or score > 1:
            continue
        model_id = row.get("model_id")
        # One id outside the enum drops the judge. Rewriting it would claim
        # a lane or a model that did not run.
        if not isinstance(model_id, str) or model_id not in _SCHEMA_MODEL_IDS:
            return None
        claims.append(
            {
                "claim_id": claim_id,
                "grounding": grounding,
                "citation_faithful": bool(row.get("citation_faithful")),
                "numbers_match": bool(row.get("numbers_match")),
                "score": score,
                "rationale": rationale,
                "model_id": model_id,
                **_dropped(dropped_by_id.get(claim_id)),
            }
        )
    if not claims:
        return None
    summary = body.get("judge_summary") or {}
    overall = summary.get("overall") if isinstance(summary, dict) else None
    try:
        overall_score = float(overall)
    except (TypeError, ValueError):
        overall_score = sum(c["score"] for c in claims) / len(claims)
    if overall_score < 0 or overall_score > 1:
        overall_score = max(0.0, min(1.0, overall_score))
    return {"claims": claims, "overall_score": overall_score}


_ACTION_TYPES = frozenset(
    ("notify-policyholders", "dispatch-loss-adjuster", "flag-underwriting-review", "inform-public")
)


def _card_fields(raw: dict[str, Any]) -> dict[str, Any]:
    """Optional approval-card fields, copied only when well typed."""
    out: dict[str, Any] = {}
    if raw.get("action_type") in _ACTION_TYPES:
        out["action_type"] = raw["action_type"]
    for key in ("target_region", "draft_message"):
        if isinstance(raw.get(key), str) and raw[key].strip():
            out[key] = raw[key]
    count = raw.get("affected_site_count")
    if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
        out["affected_site_count"] = count
    for key in ("outbound", "released"):
        if isinstance(raw.get(key), bool):
            out[key] = raw[key]
    return out


def _project_actions(
    body: dict[str, Any], run_id: str, citations: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    by_claim: dict[str, list[str]] = {}
    for cit in citations:
        by_claim.setdefault(cit["claim_id"], []).append(cit["citation_id"])
    out = []
    for raw in body.get("playbook") or []:
        if not isinstance(raw, dict):
            continue
        action_id = raw.get("action_id")
        text = raw.get("text") or raw.get("detail")
        if not isinstance(action_id, str) or not action_id:
            continue
        if not isinstance(text, str) or not text.strip():
            continue
        ids: list[str] = []
        for claim_id in raw.get("claim_ids") or raw.get("citation_ids") or []:
            if claim_id in by_claim:
                ids.extend(by_claim[claim_id])
            elif isinstance(claim_id, str) and any(c["citation_id"] == claim_id for c in citations):
                ids.append(claim_id)
        # Preserve order, drop duplicates.
        seen: list[str] = []
        for cid in ids:
            if cid not in seen:
                seen.append(cid)
        if not seen:
            continue
        horizon = raw.get("horizon_h")
        title = raw.get("title") if isinstance(raw.get("title"), str) and raw.get("title") else text.strip()
        if isinstance(horizon, int):
            title = f"{horizon}h — {title}"
        out.append(
            {
                "action_id": action_id,
                "run_id": run_id,
                "title": title,
                "detail": text.strip(),
                "citation_ids": seen,
                **_card_fields(raw),
            }
        )
    return out


def _project_approvals(
    body: dict[str, Any],
    run_id: str,
    actions: list[dict[str, Any]],
    judge: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    approval = body.get("approval") if isinstance(body.get("approval"), dict) else {}
    status_raw = str(approval.get("status") or "")
    # ``auto`` is FF_HITL off. It is not a human approval, and the schema has
    # no value for it. Do not rewrite it to approved.
    if status_raw == "auto":
        return []
    status = _APPROVAL.get(status_raw, "pending")
    note = approval.get("reviewer_note") or approval.get("note")
    out = []
    for action in actions:
        item: dict[str, Any] = {
            "approval_id": f"{run_id}:{action['action_id']}",
            "run_id": run_id,
            "action_id": action["action_id"],
            "status": status,
        }
        if isinstance(note, str) and note.strip():
            item["note"] = note.strip()
        if judge is not None:
            item["judge"] = judge
        out.append(item)
    return out


def project_run(body: dict[str, Any]) -> dict[str, Any] | None:
    """Schema-shaped ``answer``, ``approvals``, and the pieces inside them.

    Returns None when the payload is not a run (no question and no claims).
    """
    if not isinstance(body, dict):
        return None
    request = body.get("request") if isinstance(body.get("request"), dict) else {}
    question = body.get("question") or request.get("question")
    run_id = body.get("run_id")
    raw_claims = body.get("claims")
    if not isinstance(run_id, str) or not run_id:
        return None
    if not isinstance(question, str) or not question.strip():
        return None
    if not isinstance(raw_claims, list):
        return None

    evidence = _project_evidence(body)
    provenance = body.get("provenance") if isinstance(body.get("provenance"), list) else []
    provenance = [p for p in provenance if isinstance(p, dict)]
    citations = _project_citations(raw_claims, evidence, provenance)
    claims = []
    for raw in raw_claims:
        if not isinstance(raw, dict):
            continue
        claim_id = raw.get("claim_id")
        text = raw.get("text")
        if isinstance(claim_id, str) and claim_id and isinstance(text, str) and text.strip():
            claims.append(
                {"claim_id": claim_id, "text": text.strip(), **_dropped(raw.get("numbers_dropped"))}
            )
    if not claims or not citations:
        return None

    served = body.get("served_from")
    if served not in ("live", "cache", "replay"):
        served = "replay"
    if served == "live":
        cached: str | None = None
    else:
        cached = _as_dt(body.get("cached_at")) or _as_dt(body.get("replay_ts"))
        if cached is None:
            return None

    actions = _project_actions(body, run_id, citations)
    judge = _project_judge(body)
    answer: dict[str, Any] = {
        "run_id": run_id,
        "question": question.strip(),
        "claims": claims,
        "citations": citations,
        "evidence": evidence,
        "served_from": served,
        "cached_at": cached,
    }
    if actions:
        answer["playbook_actions"] = actions
    if judge is not None:
        answer["judge"] = judge
    # Router lane (agents/floodsense_agents/router.py). Older runs carry none.
    if body.get("lane") in ("quick", "forecast", "full"):
        answer["lane"] = body["lane"]
    fc = body.get("forecast")
    if body.get("lane") == "forecast" and isinstance(fc, dict) and fc.get("status") and fc.get("disclaimer"):
        answer["forecast"] = fc
    pl = body.get("plain")
    if (
        body.get("lane") in ("quick", "forecast")
        and isinstance(pl, dict)
        and pl.get("headline")
        and pl.get("one_line")
    ):
        # The calm answer (agents/floodsense_agents/plain.py): passed through as the agents built it.
        answer["plain"] = pl
    if isinstance(body.get("router_reason"), str) and body["router_reason"].strip():
        answer["router_reason"] = body["router_reason"].strip()
    return {
        "answer": answer,
        "approvals": _project_approvals(body, run_id, actions, judge),
        "evidence": evidence,
    }
