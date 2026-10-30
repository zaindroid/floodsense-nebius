"""H-MEM in the graph: recall before the Investigator, Learn after the human.

recalling(node, deps) wraps the Investigator. On its first pass (not the
Skeptic's revise edge) it asks memory for past approved findings on the same
flood event, puts them in state["memories"], and adds a `memory` trace event.
Memories are context, never evidence: the Investigator still cites only this
run's query ids, and the reviewer sees what was recalled.

Short-term thread memory needs no flag. A run that continues a thread
(RunRequest.thread_id) arrives with the thread's earlier turns in
state["thread"], put there by Runtime.start; the same `memory` trace event
says how many there are.

make_learn(deps) is the node after hitl. An approved or edited run's claims
go to memory with their Zetaris query ids. A rejected or auto-approved run
writes nothing.

Recall and Learn sit behind FF_HMEM. With the flag off, or with NoMemory, and
no earlier turns, the graph runs as before and the trace gets nothing. A memory that fails becomes a trace
note; the run and the approval stand.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

from floodsense_agents.engines import fold, memory_origin, short
from floodsense_agents.settings import settings
from floodsense_agents.state import Deps, FloodState, NoMemory, trace

log = logging.getLogger("floodsense.memory")

Node = Callable[[FloodState], dict]
REMEMBERED = ("approved", "edited")


def memory_on(deps: Deps) -> bool:
    """FF_HMEM is on and a memory is plugged in. Plain NoMemory means none is."""
    return settings.ff_hmem and type(deps.memory) is not NoMemory


def _same_event(memories: list[dict[str, Any]], event_id: str | None) -> list[dict[str, Any]]:
    """Drop findings tagged with another event.

    An Ahr replay recalled Valencia's "VAL03 reached 471 m3/s" and "91 policies
    in the footprint"; the Investigator then reasoned with them. Untagged
    memories stay.
    """
    if not event_id:
        return memories
    out = []
    for m in memories:
        tags = [t for t in (m.get("tags") or []) if isinstance(t, str) and t.startswith("event:")]
        if tags and f"event:{event_id}" not in tags:
            continue
        out.append(m)
    return out


def recalling(node: Node, deps: Deps) -> Node:
    """Recall past approved findings, then run the Investigator with them in state."""

    def run(state: FloodState) -> dict:
        revising = bool(state.get("hypotheses")) and state.get("revise_rounds", 0) > 0
        turns = state.get("thread") or []
        long_term = memory_on(deps)
        if revising or not (turns or long_term):
            return node(state)
        t = time.time()
        notes = []
        if turns:
            notes.append(f"{len(turns)} earlier turn(s) in thread {state.get('thread_id', '?')}")
        memories: list[dict[str, Any]] = []
        if long_term:
            try:
                memories = _same_event(
                    list(deps.memory.recall(state.get("request") or {})), state.get("event_id")
                )
                seeded = sum(1 for m in memories if memory_origin(m)[0])
                notes.append(
                    f"recalled {len(memories)} past approved finding(s) for the Investigator"
                    + (f" ({seeded} demo seed, not analyst-approved)" if seeded else "")
                )
            except Exception as e:  # noqa: BLE001 - memory never fails a run
                log.warning("memory: recall failed: %s", short(e))
                notes.append(f"recall failed: {short(e)}; the Investigator runs without it")
        before = {
            **state,
            "memories": memories,
            "trace": trace(state, "memory", "; ".join(notes), lane="none", started=t),
        }
        out = node(before)
        return {**out, "memories": memories, "trace": out.get("trace", before["trace"])}

    run.__name__ = getattr(node, "__name__", "investigator")
    return run


def _stored_note(report: Any, status: str) -> str:
    if not isinstance(report, dict):
        return f"{status} run handed to memory"
    stored = len(report.get("stored") or [])
    already = len(report.get("already_stored") or [])
    if report.get("reason"):
        return f"nothing stored: {report['reason']}"
    return f"{status} run: {stored} claim(s) stored in H-MEM, {already} already remembered"


def _tagged(state: FloodState) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The request with the run's event, and claims carrying place, river and doc entities.

    A live run's request has no event_id (the router picked LIVE-EU), so the
    memories were stored untagged and never recalled by place.
    """
    from floodsense_agents.watch import FORECAST_POINTS

    request = state.get("request") or {}
    request = {**request, "event_id": request.get("event_id") or state.get("event_id")}
    asked = fold(str(request.get("question") or ""))
    claims = []
    for c in state.get("claims") or []:
        text = fold(str(c.get("text") or "")) + " " + asked
        found = [n for p in FORECAST_POINTS if fold(p[3]) in text for n in (p[3], p[4])]
        docs = [x["doc_id"] for x in c.get("citations") or [] if x.get("doc_id")]
        claims.append({**c, "entities": list(dict.fromkeys([*found, *docs]))})
    return request, claims


def make_learn(deps: Deps) -> Node:
    def learn(state: FloodState) -> dict:
        if not memory_on(deps):
            return {}
        t = time.time()
        approval = state.get("approval") or {}
        status = str(approval.get("status") or "not_reached")
        if status not in REMEMBERED:
            note = f"nothing stored: approval is {status}; memory keeps a human yes"
        else:
            try:
                request, claims = _tagged(state)
                report = deps.memory.store(state.get("run_id", ""), request, claims, approval)
                note = _stored_note(report, status)
            except Exception as e:  # noqa: BLE001 - the approval stands without memory
                log.warning("memory: store failed: %s", short(e))
                note = f"store failed: {short(e)}; the approval stands"
        return {"trace": trace(state, "learn", note, lane="none", started=t)}

    return learn
