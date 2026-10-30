"""Graph state and the dependency bundle the nodes close over.

Plain dicts cross node boundaries so the checkpointer can serialise them;
the pydantic models in models.py type them at the edges.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, TypedDict

from floodsense_agents.engines import NoWorld, WorldModel, memory_origin
from floodsense_agents.plain import sentence_cut
from floodsense_agents.models import Evidence, TraceEvent
from floodsense_agents.nightshift import LLM
from floodsense_agents.settings import settings
from floodsense_agents.zetaris import Zetaris, now_utc


class Memory(Protocol):
    """Memory behind FF_HMEM. recall() feeds the Investigator; store() runs on approval only."""

    def recall(self, request: dict[str, Any]) -> list[dict[str, Any]]: ...
    def store(
        self,
        run_id: str,
        request: dict[str, Any],
        claims: list[dict[str, Any]],
        approval: dict[str, Any],
    ) -> None: ...


class NoMemory:
    """No memory plugged in. The graph treats plain NoMemory as memory off."""

    def recall(self, request):
        return []

    def store(self, run_id, request, claims, approval):
        return None


@dataclass
class Deps:
    zetaris: Zetaris
    llm: LLM
    memory: Memory
    world: WorldModel = field(default_factory=NoWorld)  # engines sidecar; NoWorld = off
    retrieve_docs: Callable[..., Any] | None = None


class FloodState(TypedDict, total=False):
    # contract fields
    run_id: str
    thread_id: str
    event_id: str
    customer_id: str
    replay_ts: str | None
    anomalies: list[dict[str, Any]]  # Anomaly[]
    hypotheses: list[dict[str, Any]]  # Hypothesis[]
    exposure: dict[str, Any]  # Exposure
    playbook: list[dict[str, Any]]  # PlaybookAction[]
    judge: list[dict[str, Any]]  # JudgeScore[]
    approval: dict[str, Any]  # Approval
    trace: list[dict[str, Any]]  # TraceEvent[]
    # extra
    request: dict[str, Any]  # RunRequest
    event: dict[str, Any]  # EventSpec
    event_route: str  # why this event: events.route_event reason
    evidence: dict[str, dict[str, Any]]  # query_id -> Evidence
    provenance: list[dict[str, Any]]  # rows of the provenance view (layer b)
    claims: list[dict[str, Any]]  # Claim[]
    memories: list[dict[str, Any]]  # H-MEM recall for this run: context, never evidence
    thread: list[dict[str, Any]]  # earlier turns of this conversation: short-term memory
    web: dict[str, Any]  # Tavily call: status, query, latency_ms, cached, items (untrusted data)
    web_check: dict[str, Any]  # Skeptic: one alert-timing claim vs web context (never a verdict)
    summary: str
    judge_summary: dict[str, Any]  # JudgeSummary
    revise_rounds: int
    repair_rounds: int
    live_findings: dict[str, Any]  # live mode: what the Investigator found crossing
    mode: dict[str, Any]  # live.resolve_mode: {mode event|live, explicit, reason}
    scope: dict[str, Any]  # the gate's verdict: can this run honestly answer
    status: str  # running | awaiting_approval | approved | rejected | failed | answered (quick / forecast lane)
    served_from: str  # live | cache | replay. live only for a fresh live-schema read
    cached_at: str | None
    model_ids: list[str]
    error: str
    # forecast lane (nodes/forecast.py): status, model outlook, disclaimer
    forecast: dict[str, Any]
    # quick and forecast lanes (plain.py): the calm, plain-language answer; no model writes it
    plain: dict[str, Any]
    # router.py: which agent path runs (quick | forecast | full), why, and a pending escalation
    lane: str
    router_reason: str
    escalate: str | None


def trace(
    state: FloodState,
    node: str,
    summary: str,
    *,
    lane: str | None = None,
    model_id: str | None = None,
    started: float | None = None,
    evidence_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    prev = state.get("trace", [])
    ms = int((time.time() - started) * 1000) if started else None
    # Named here, not guessed from the id downstream: a Nemotron id answers on
    # Nightshift and on Token Factory alike, and only the backend knows which.
    llm = bool(model_id) and model_id != "deterministic"
    ev = TraceEvent(
        run_id=state.get("run_id", ""),
        seq=len(prev) + 1,
        ts=now_utc(),
        node=node,
        lane=lane,
        model_id=model_id,
        latency_ms=ms,
        duration_ms=ms,
        summary=summary,
        evidence_ids=evidence_ids or [],
        provider=settings.llm_backend if llm else None,
    )
    return [*prev, ev.model_dump()]


def normalise_trace(events: list[dict] | None) -> list[dict]:
    """Trace entries with phase and duration_ms, also for runs recorded before both existed."""
    out = []
    for ev in events or []:
        ev = dict(ev)
        ev.setdefault("phase", "finished")
        if ev.get("duration_ms") is None:
            ev["duration_ms"] = ev.get("latency_ms")
        out.append(ev)
    return out


def _memory_text(content: Any, limit: int = 200) -> str:
    """The recalled text, whole when it fits, else cut at a sentence (never mid-word)."""
    text = str(content or "")
    return text if len(text) <= limit else sentence_cut(text, limit)


def memory_used(memories: list[dict] | None) -> list[dict]:
    """What H-MEM recalled for the Investigator, as provenance.

    Run level only. Memories reach the Investigator's prompt as context and
    claims cite this run's queries, so which claim leaned on which memory is
    not knowable, and is not claimed.
    """
    out = []
    for m in memories or []:
        if not isinstance(m, dict):
            continue
        prov = m.get("provenance") if isinstance(m.get("provenance"), dict) else {}
        seeded, reviewer = memory_origin(m)
        out.append(
            {
                "memory_id": m.get("memory_id"),
                "run_id": m.get("run_id"),
                "claim_id": m.get("claim_id"),
                # H-MEM writes only on approval, so learned_at is the approval time.
                "approved_at": prov.get("learned_at"),
                "text": _memory_text(m.get("content")),
                "relevance": m.get("relevance"),
                "reviewer": reviewer,
                "seeded": seeded,
            }
        )
    return out


def run_model_ids(trace_events: list[dict] | None, recorded: list[str] | None = None) -> list[str]:
    """Every model that answered an LLM node of the run, in node order, once each.

    Read from the trace, so the Skeptic, the Judge and the repair round count
    too (nodes used to append only the Investigator's and the Playbook's id,
    and a fallback appended "deterministic"). The Judge records "a,b" when
    several models scored. With no model answer at all, the recorded list is
    returned deduplicated.
    """
    out: list[str] = []
    for ev in trace_events or []:
        for m in str(ev.get("model_id") or "").split(","):
            m = m.strip()
            if m and m != "deterministic" and m not in out:
                out.append(m)
    return out or list(dict.fromkeys(recorded or []))


def answered(*items: Evidence) -> bool:
    """True when every query came back. An errored query answered nothing.

    Empty rows and a failed call look identical downstream unless someone
    asks. Nodes ask here before stating anything.
    """
    return all(e.error is None for e in items)


def failures(state: FloodState) -> list[str]:
    """Query ids in this run that errored. Empty is the healthy case."""
    return sorted(q for q, e in (state.get("evidence") or {}).items() if e.get("error"))


def add_evidence(state: FloodState, *items: Evidence) -> dict[str, dict[str, Any]]:
    ev = dict(state.get("evidence", {}))
    for e in items:
        ev[e.query_id] = e.model_dump()
    return ev
