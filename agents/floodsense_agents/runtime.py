"""Run lifecycle on top of the compiled graph.

start() runs until the HITL interrupt, snapshot() reads a run, resume()
applies a decision. Used by the service and the eval runner.

start_async() returns the run id at once and runs the graph on a daemon
thread. While it runs, snapshot() reads each node's checkpoint as it lands,
and started() lists the nodes that have begun (LangGraph debug stream), so
GET /runs/{id}/events is a live feed.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

from langgraph.types import Command

from floodsense_agents import labelling, router
from floodsense_agents.checkpoints import build_checkpointer
from floodsense_agents.events import route_event, spec
from floodsense_agents.graph import build_deps, build_graph
from floodsense_agents.hitl import approval_payload
from floodsense_agents.models import ApprovalDecision, RunRequest
from floodsense_agents.nightshift import UsageMeter, run_meter
from floodsense_agents.state import memory_used, normalise_trace, run_model_ids, trace
from floodsense_agents.zetaris import now_utc

log = logging.getLogger("floodsense.runtime")
# Short-term thread memory: how much of a conversation a follow-up carries.
THREAD_TURNS_MAX = 3
LIVE_MAX = 64  # runs kept in Runtime.live; the oldest finished ones are dropped first
TURN_SUMMARY_MAX = 600
STATE_KEYS = (
    "run_id",
    "thread_id",
    "event_id",
    "customer_id",
    "replay_ts",
    "anomalies",
    "hypotheses",
    "exposure",
    "playbook",
    "judge",
    "approval",
    "trace",
    "request",
    "event",
    "claims",
    "memories",
    "thread",
    "summary",
    "judge_summary",
    "evidence",
    "provenance",
    "revise_rounds",
    "repair_rounds",
    "scope",
    "mode",
    "live_findings",
    "model_ids",
    "error",
    "lane",
    "router_reason",
    "forecast",
    "plain",
)


class RunNotFound(KeyError):
    pass


class NotAwaitingApproval(RuntimeError):
    pass


class ThreadNotFound(KeyError):
    pass


def started_at(state: dict[str, Any]) -> str | None:
    """When a run started: its first trace event. Survives a restart, unlike a clock read."""
    trace = state.get("trace") or []
    return trace[0].get("ts") if trace else None


def turn_of(s: dict[str, Any]) -> dict[str, Any]:
    """One earlier turn of a thread, as a follow-up sees it."""
    approval = (s.get("approval") or {}).get("status")
    return {
        "run_id": s.get("run_id"),
        "question": (s.get("request") or {}).get("question"),
        "event_id": s.get("event_id"),
        "status": s.get("status"),
        "approval": approval,
        "summary": (s.get("summary") or "")[:TURN_SUMMARY_MAX],
        "at": started_at(s),
    }


class Runtime:
    def __init__(self, graph=None, deps=None) -> None:
        self.deps = deps if deps is not None else (None if graph is not None else build_deps())
        self.graph = graph if graph is not None else build_graph(self.deps, build_checkpointer())
        self.index: dict[
            str, dict[str, Any]
        ] = {}  # run_id -> row for /runs/past (this process; state lives in the checkpointer)
        # Background runs of this process: run_id -> {"started": [...], "done": bool}.
        self.live: dict[str, dict[str, Any]] = {}
        # Token usage per run, this process only (not in the checkpoint).
        self.meters: dict[str, UsageMeter] = {}
        self._live_lock = threading.Lock()
        # Observers of the run lifecycle: fn(kind, run_id) with kind "paused" (a run left the
        # graph call: awaiting approval, answered or failed) or "resumed" (a decision landed).
        # The control tower listens; an observer never changes or blocks a run.
        self.observers: list[Callable[[str, str], None]] = []

    def _notify(self, kind: str, run_id: str) -> None:
        for fn in list(self.observers):
            try:
                fn(kind, run_id)
            except Exception as e:  # noqa: BLE001 - an observer must not break a run
                log.warning("run observer failed: %s", str(e)[:120])

    @staticmethod
    def cfg(run_id: str) -> dict:
        return {"configurable": {"thread_id": run_id}}

    def is_running(self, run_id: str) -> bool:
        """A background run of this process that has not finished its graph call."""
        entry = self.live.get(run_id)
        return bool(entry) and not entry["done"]

    def started(self, run_id: str) -> list[dict[str, Any]]:
        """Nodes of a background run that have begun, in order (phase "started")."""
        with self._live_lock:
            return list((self.live.get(run_id) or {}).get("started") or [])

    def snapshot(self, run_id: str) -> dict[str, Any]:
        snap = self.graph.get_state(self.cfg(run_id))
        error = (self.live.get(run_id) or {}).get("error")
        if not snap or not snap.values:
            if error:
                v, paused = {"run_id": run_id, "status": "failed", "error": error}, False
            elif self.is_running(run_id):
                # Accepted, no checkpoint yet: the first node is still working.
                v, paused = {"run_id": run_id, "status": "running"}, False
            else:
                raise RunNotFound(run_id)
        else:
            v = dict(snap.values)
            paused = bool(snap.tasks and any(getattr(t, "interrupts", None) for t in snap.tasks))
            if error and v.get("status") != "failed":
                v.update(status="failed", error=error)
                paused = False
        out = {k: v.get(k) for k in STATE_KEYS}
        for k, empty in (
            ("anomalies", []),
            ("hypotheses", []),
            ("playbook", []),
            ("judge", []),
            ("trace", []),
            ("claims", []),
            ("memories", []),
            ("thread", []),
            ("model_ids", []),
            ("evidence", {}),
            ("exposure", {}),
            ("provenance", []),
        ):
            out[k] = out[k] if out[k] is not None else empty
        # Runs recorded before the router took the full lane.
        out["lane"] = out["lane"] or router.FULL
        out["trace"] = normalise_trace(out["trace"])
        out["model_ids"] = run_model_ids(out["trace"], out["model_ids"])
        # H-MEM provenance, run level: which approved past findings the
        # Investigator saw. Not linked per claim (see state.memory_used).
        out["memory_used"] = memory_used(out["memories"])
        out["approval"] = out["approval"] or {
            "status": "awaiting" if paused else "not_reached",
            "decision": None,
            "edits": None,
            "reviewer_note": None,
        }
        out["status"] = "awaiting_approval" if paused else v.get("status", "running")
        kind, at = labelling.computation_label(v.get("replay_ts"), live=self._answers_are_live())
        # A clocked replay stays replay. A stored "cache" mark must not hide
        # the clock on the way out of the checkpointer.
        stored = v.get("served_from")
        if v.get("replay_ts"):
            pass
        elif stored == labelling.CACHE and v.get("cached_at"):
            kind, at = labelling.CACHE, v.get("cached_at")
        elif stored in labelling.KINDS and stored != labelling.LIVE:
            kind = stored
            at = v.get("cached_at") or at
        out["served_from"] = kind
        out["cached_at"] = at
        # Queries that errored. An answer resting on one of these is standing
        # on a hole, and the reviewer has to be told before deciding.
        m = self.meters.get(run_id)
        out["usage"] = m.as_dict() if m else None
        out["failures"] = [
            {"query_id": q, "view": e.get("view"), "error": e.get("error")}
            for q, e in (out.get("evidence") or {}).items()
            if e.get("error")
        ]
        return out

    def approval(self, run_id: str) -> dict[str, Any]:
        s = self.snapshot(run_id)
        if s["status"] != "awaiting_approval":
            raise NotAwaitingApproval(f"run {run_id} is {s['status']}")
        return approval_payload(s)

    def citations(self, run_id: str) -> dict[str, Any]:
        s = self.snapshot(run_id)
        cits = [c for claim in s["claims"] for c in claim.get("citations", [])]
        return {
            "run_id": run_id,
            "citations": cits,
            "evidence": s["evidence"],
            "provenance": s["provenance"],
            "served_from": s["served_from"],
            "cached_at": s["cached_at"],
        }

    def _remember(self, run_id: str, snap: dict[str, Any]) -> dict[str, Any]:
        """Record one snapshot in the process index. Does not read the checkpointer."""
        now = now_utc()
        # created_at comes from the run's own trace, so a rebuilt index after a
        # restart keeps the real start time (cached_at labels read it).
        row = self.index.get(run_id, {"run_id": run_id, "created_at": started_at(snap) or now})
        row.update(
            status=snap["status"],
            thread_id=snap.get("thread_id") or run_id,
            question=(snap.get("request") or {}).get("question"),
            event_id=snap.get("event_id"),
            customer_id=snap.get("customer_id"),
            replay_ts=snap.get("replay_ts"),
            mode=(snap.get("mode") or {}).get("mode"),
            updated_at=now,
            judge_overall=(snap.get("judge_summary") or {}).get("overall"),
            approval=(snap.get("approval") or {}).get("status"),
            served_from=snap["served_from"],
            cached_at=snap["cached_at"],
            lane=snap.get("lane"),
        )
        self.index[run_id] = row
        return row

    def _index_row(self, run_id: str) -> None:
        self._remember(run_id, self.snapshot(run_id))

    def _answers_are_live(self) -> bool:
        """True only for the live schema read through live Zetaris."""
        zetaris = getattr(self.deps, "zetaris", None) if self.deps else None
        return labelling.data_plane_is_live(zetaris)

    def thread(self, thread_id: str) -> list[dict[str, Any]]:
        """The last THREAD_TURNS_MAX turns of a conversation, oldest first.

        A thread is the runs that share a thread_id; the first run's id names
        it. An unknown thread is an error rather than a silent new thread, so
        a client continuing a conversation hears when it is not.
        """
        self._rebuild_index()
        rows = [r for r in list(self.index.values()) if r.get("thread_id") == thread_id]
        if not rows:
            raise ThreadNotFound(thread_id)
        rows.sort(key=lambda r: r.get("created_at") or "")
        return [turn_of(self.snapshot(r["run_id"])) for r in rows[-THREAD_TURNS_MAX:]]

    def start(self, req: RunRequest) -> dict[str, Any]:
        run_id, inputs = self._prepare(req)
        self._execute(run_id, inputs)
        return self.snapshot(run_id)

    def start_async(self, req: RunRequest) -> dict[str, Any]:
        """Accept a run and return its id now. The graph runs on a daemon thread.

        Request errors (unknown event, unknown thread) still raise here, before
        anything is accepted.
        """
        run_id, inputs = self._prepare(req)
        self._track(run_id)
        threading.Thread(
            target=self._execute,
            args=(run_id, inputs),
            kwargs={"stream": True},
            name=f"run-{run_id}",
            daemon=True,
        ).start()
        return {"run_id": run_id, "thread_id": inputs["thread_id"], "status": "running"}

    def _note_started(self, run_id: str, chunk: Any) -> None:
        if not isinstance(chunk, dict) or chunk.get("type") != "task":
            return
        name = (chunk.get("payload") or {}).get("name")
        if not name or str(name).startswith("__"):
            return
        with self._live_lock:
            entry = self.live.get(run_id)
            if entry is not None:
                entry["started"].append(
                    {"run_id": run_id, "node": name, "phase": "started", "ts": now_utc()}
                )

    def _execute(self, run_id: str, inputs: dict[str, Any], *, stream: bool = False) -> None:
        self._track(run_id)
        tok = run_meter.set(self.meters.setdefault(run_id, UsageMeter()))
        try:
            if stream:
                for chunk in self.graph.stream(inputs, self.cfg(run_id), stream_mode="debug"):
                    self._note_started(run_id, chunk)
            else:
                self.graph.invoke(inputs, self.cfg(run_id))
        except Exception as e:
            log.exception("run %s failed", run_id)
            error = str(e)[:500]
            # Kept in memory too, so the run reads failed even when the
            # checkpoint write below fails as well.
            with self._live_lock:
                self.live[run_id]["error"] = error
            try:
                self.graph.update_state(self.cfg(run_id), {"status": "failed", "error": error})
            except Exception as e2:  # noqa: BLE001 - the in-memory mark stands
                log.warning("run %s: could not record the failure: %s", run_id, str(e2)[:120])
        finally:
            run_meter.reset(tok)
            with self._live_lock:
                self.live[run_id]["done"] = True
            try:
                self._index_row(run_id)
            except Exception as e3:  # noqa: BLE001 - listing is best effort
                log.warning("run %s: could not index: %s", run_id, str(e3)[:120])
            self._notify("paused", run_id)

    def _track(self, run_id: str) -> None:
        """Register a run in self.live, dropping the oldest finished ones past LIVE_MAX."""
        with self._live_lock:
            self.live.setdefault(run_id, {"started": [], "done": False})
            done = [k for k, e in self.live.items() if e["done"]]
            for k in done[: max(0, len(self.live) - LIVE_MAX)]:
                del self.live[k]

    def _prepare(self, req: RunRequest) -> tuple[str, dict[str, Any]]:
        run_id = uuid.uuid4().hex[:12]
        # A Rhine / Köln / Ahr question on the default event runs on EMSR517.
        routed, route_why = route_event(
            req.question, req.event_id, req.context.model_dump() if req.context else None
        )
        ev = spec(routed)
        thread_id = req.thread_id or run_id
        turns = self.thread(req.thread_id) if req.thread_id else []
        served_from, cached_at = labelling.computation_label(
            req.replay_ts, live=self._answers_are_live()
        )
        t_route = time.time()
        llm = getattr(self.deps, "llm", None) if self.deps is not None else None
        tok = run_meter.set(self.meters.setdefault(run_id, UsageMeter()))
        try:
            lane = router.route(req, llm)
        finally:
            run_meter.reset(tok)
        router_trace = trace(
            {"run_id": run_id, "trace": []},
            "router",
            lane["reason"],
            lane="fast" if lane["model_id"] != "rules" else "none",
            model_id=None if lane["model_id"] == "rules" else lane["model_id"],
            started=t_route,
        )
        inputs = {
            "run_id": run_id,
            "thread_id": thread_id,
            "thread": turns,
            "event_id": ev.event_id,
            "event_route": route_why,
            "customer_id": req.customer_id,
            "replay_ts": req.replay_ts,
            "request": req.model_dump(),
            "event": ev.as_dict(),
            "served_from": served_from,
            "cached_at": cached_at,
            "lane": lane["lane"],
            "router_reason": lane["reason"],
            "trace": router_trace,
            "revise_rounds": 0,
            "repair_rounds": 0,
            "model_ids": [],
        }
        return run_id, inputs

    def resume(self, run_id: str, decision: ApprovalDecision) -> dict[str, Any]:
        s = self.snapshot(run_id)
        if s["status"] != "awaiting_approval":
            raise NotAwaitingApproval(f"run {run_id} is {s['status']}, not awaiting approval")
        tok = run_meter.set(self.meters.setdefault(run_id, UsageMeter()))
        try:
            self.graph.invoke(Command(resume=decision.model_dump()), self.cfg(run_id))
        finally:
            run_meter.reset(tok)
        out = self.snapshot(run_id)
        # N1: store used to run here on every approval, FF_HMEM or not. It now
        # runs in the graph's Learn node (nodes/memory.py), behind FF_HMEM, so
        # the write shows on the trace and a resumed graph stores exactly once.
        self._index_row(run_id)
        self._notify("resumed", run_id)
        return out

    def _rebuild_index(self) -> bool:
        """Re-read the checkpointer so a restart does not lose the run list.

        S10: the index is process memory while the state is not. After a
        restart a run stayed reachable by id and vanished from /runs/past.
        Returns False when the checkpointer cannot be listed, so the caller
        can say the list is this process only rather than imply it is whole.
        """
        saver = getattr(self.graph, "checkpointer", None)
        if saver is None or not hasattr(saver, "list"):
            return False
        try:
            # Copy the ids out first. SqliteSaver.list holds its lock until
            # this generator is closed, and _index_row reads the same saver.
            pending: list[str] = []
            seen = set()
            for item in saver.list(None):
                thread = (getattr(item, "config", None) or {}).get("configurable", {})
                run_id = thread.get("thread_id")
                if not run_id or run_id in seen or run_id in self.index:
                    continue
                seen.add(run_id)
                pending.append(run_id)
            for run_id in pending:
                try:
                    self._index_row(run_id)
                except Exception:  # noqa: BLE001 - a partial checkpoint is not fatal
                    continue
            return True
        except Exception as e:  # noqa: BLE001 - listing is best effort
            log.warning("could not read past runs from the checkpointer: %s", str(e)[:120])
            return False

    def past(self, limit: int = 50, thread_id: str | None = None) -> list[dict[str, Any]]:
        whole = self._rebuild_index()
        rows = [r for r in list(self.index.values()) if not thread_id or r.get("thread_id") == thread_id]
        rows = sorted(rows, key=lambda r: r["updated_at"], reverse=True)[:limit]
        for r in rows:
            r["scope"] = "all runs on this checkpointer" if whole else "this process only"
        return rows
