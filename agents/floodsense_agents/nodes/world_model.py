"""World Model in the trace.

recording(node, deps, by) wraps a graph node. After the node runs, its output
goes to the World Model board: the Watchers' anomalies as observations, and
the Investigator's and the Skeptic's hypotheses with their status. Each write
adds a `world_model` trace event that says what changed.

`at` is the scenario clock (the end of the event window, cut at replay_ts),
not the wall clock, so a replayed run writes the same events and the engines
append nothing new.

With the engines off (NoWorld) the node runs unchanged and the trace gets
nothing. A failed write becomes a trace note; the run carries on.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

from floodsense_agents.engines import WorldModel, short
from floodsense_agents.nodes.watchers import window
from floodsense_agents.state import Deps, FloodState, trace
from floodsense_agents.zetaris import now_utc

log = logging.getLogger("floodsense.world_model")

Node = Callable[[FloodState], dict]


def scenario_clock(state: FloodState) -> str:
    """The replay clock for World Model events: window end, cut at replay_ts."""
    try:
        return window(state)[1]
    except (KeyError, TypeError, ValueError):
        return now_utc()


def _write(world: WorldModel, state: dict[str, Any], by: str) -> str:
    if by == "watchers":
        anomalies = state.get("anomalies") or []
        if not anomalies:
            return ""
        r = world.observe(anomalies)
        return (
            f"{r.get('processed', len(anomalies))} anomalies observed, "
            f"{r.get('skipped_unchanged', 0)} already known, "
            f"{r.get('events_appended', 0)} events appended"
        )
    hypotheses = state.get("hypotheses") or []
    if not hypotheses:
        return ""
    board = world.update_hypotheses(
        state.get("run_id", ""), scenario_clock(state), f"floodsense-{by}", hypotheses
    )
    statuses = ", ".join(f"{b.get('hypothesis_id')} {b.get('status')}" for b in board)
    return f"board after {by}: {statuses or 'empty'}"


def recording(node: Node, deps: Deps, by: str) -> Node:
    """Run `node`, then write its anomalies or hypotheses to the World Model."""

    def run(state: FloodState) -> dict:
        out = node(state)
        world = deps.world
        if not getattr(world, "enabled", False):
            return out
        merged = {**state, **out}
        t = time.time()
        try:
            note = _write(world, merged, by)
        except Exception as e:  # noqa: BLE001 - the World Model never fails a run
            log.warning("world model: write after %s failed: %s", by, short(e))
            note = f"not updated after {by}: {short(e)}; the run continues"
        if not note:
            return out
        return {**out, "trace": trace(merged, "world_model", note, lane="none", started=t)}

    run.__name__ = getattr(node, "__name__", by)
    return run
