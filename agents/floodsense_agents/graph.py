"""The FloodSense LangGraph.

    scope ─┬─ out of scope → END (declined, no data read, no model call)
           └─ watchers → investigator → skeptic ─┬─ not_supported & no revise yet → revise → investigator
                                       └─ → exposure → playbook → judge ─┬─ flagged & repair left → playbook (repair) → judge
                                                                          └─ → hitl (interrupt) → learn → END
    scope ── in scope, lane=quick → live_watch → quick_answer → quick_judge ─┬─ pass → END (answered)
                                                                    └─ flag / no data → escalate → watchers
    scope ── in scope, lane=forecast → forecast_data → history → forecast_answer → forecast_judge ─┬─ pass → END
                                                                                     └─ flag / no data → escalate → watchers
FF_SKEPTIC=false skips the Skeptic, FF_JUDGE=false skips the Judge, FF_HITL=false auto-approves (dev only).

The engines sidecar (ENGINES_URL, engines/) joins in three places. The Watchers,
Investigator and Skeptic write what they found to the World Model board
(nodes/world_model.py). Behind FF_HMEM, the Investigator first recalls past
approved findings, and Learn stores an approved or edited run (nodes/memory.py).
Each write adds a trace event. With ENGINES_URL unset the graph runs as before.

    graph = build_graph(deps, checkpointer)
    out = graph.invoke({"run_id": rid, "request": req, "event": event}, {"configurable": {"thread_id": rid}})
    out["__interrupt__"][0].value            # the approval payload; the run is paused
    graph.invoke(Command(resume={"action": "approve"}), config)

Agents read data through Zetaris only.
"""

from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from floodsense_agents import hitl as hitl_mod
from floodsense_agents.engines import NoWorld, build_engines
from floodsense_agents.nightshift import build_llm
from floodsense_agents.nodes import (
    exposure,
    forecast,
    investigator,
    judge,
    memory,
    playbook,
    quick,
    scope,
    skeptic,
    watchers,
    world_model,
)
from floodsense_agents.settings import settings
from floodsense_agents.state import Deps, FloodState, NoMemory
from floodsense_agents.zetaris import build_zetaris

PLANNED_NODES: tuple[str, ...] = (
    "scope",
    "watchers",
    "investigator",
    "skeptic",
    "exposure",
    "playbook",
    "judge",
    "hitl",
    "learn",
)


def build_deps() -> Deps:
    engines = build_engines()
    return Deps(
        zetaris=build_zetaris(),
        llm=build_llm(),
        memory=engines if engines is not None and settings.ff_hmem else NoMemory(),
        world=engines if engines is not None else NoWorld(),
    )


def build_graph(
    deps: Deps | None = None,
    checkpointer=None,
    *,
    ff_skeptic: bool | None = None,
    ff_judge: bool | None = None,
    ff_rag_docs: bool | None = None,
):
    deps = deps or build_deps()
    use_skeptic = settings.ff_skeptic if ff_skeptic is None else ff_skeptic
    use_judge = settings.ff_judge if ff_judge is None else ff_judge
    use_rag = settings.ff_rag_docs if ff_rag_docs is None else ff_rag_docs
    if not use_rag:
        deps.retrieve_docs = None
    elif deps.retrieve_docs is None:
        deps.retrieve_docs = _live_retrieve(deps.zetaris)

    g = StateGraph(FloodState)
    g.add_node("watchers", world_model.recording(watchers.make(deps), deps, "watchers"))
    g.add_node(
        "investigator",
        world_model.recording(
            memory.recalling(investigator.make(deps), deps), deps, "investigator"
        ),
    )
    g.add_node("exposure", exposure.make(deps))
    g.add_node("playbook", playbook.make(deps))
    g.add_node("hitl", hitl_mod.hitl)
    g.add_node("learn", memory.make_learn(deps))
    # The gate runs before anything reads data or calls a model: a question
    # these views cannot answer is declined, not attempted.
    g.add_node("scope", scope.make())
    g.add_edge(START, "scope")
    # Router lanes (router.py): lane=quick takes the short live path and ends
    # answered, or escalates into the full lane at watchers. lane=full (and
    # every run without a lane) routes exactly as before.
    g.add_node("live_watch", quick.make_live_watch(deps))
    g.add_node("quick_answer", quick.quick_answer)
    g.add_node("quick_judge", quick.quick_judge)
    g.add_node("escalate", quick.escalate)
    # lane=forecast (nodes/forecast.py): forecast data, history, deterministic claims
    # plus one model outlook, the deterministic Judge; escalates like quick.
    g.add_node("forecast_data", forecast.make_forecast_data(deps))
    g.add_node("history", forecast.make_history(deps))
    g.add_node("forecast_answer", forecast.make_forecast_answer(deps))
    g.add_node("forecast_judge", quick.quick_judge)
    g.add_conditional_edges(
        "scope",
        quick.route_after_scope,
        {
            "watchers": "watchers",
            "declined": END,
            "live_watch": "live_watch",
            "forecast_data": "forecast_data",
        },
    )
    g.add_conditional_edges(
        "forecast_data",
        forecast.route_after_forecast_data,
        {"history": "history", "escalate": "escalate"},
    )
    g.add_edge("history", "forecast_answer")
    g.add_conditional_edges(
        "forecast_answer",
        forecast.route_after_answer,
        {"forecast_judge": "forecast_judge", "escalate": "escalate"},
    )
    g.add_conditional_edges(
        "forecast_judge", quick.route_after_quick_judge, {"done": END, "escalate": "escalate"}
    )
    g.add_conditional_edges(
        "live_watch",
        quick.route_after_live_watch,
        {"quick_answer": "quick_answer", "escalate": "escalate"},
    )
    g.add_conditional_edges(
        "quick_answer",
        quick.route_after_answer,
        {"quick_judge": "quick_judge", "escalate": "escalate"},
    )
    g.add_conditional_edges(
        "quick_judge", quick.route_after_quick_judge, {"done": END, "escalate": "escalate"}
    )
    g.add_conditional_edges(
        "escalate", quick.route_after_escalate, {"watchers": "watchers", "declined": END}
    )
    g.add_edge("watchers", "investigator")

    if use_skeptic:
        g.add_node("skeptic", world_model.recording(skeptic.make(deps), deps, "skeptic"))
        g.add_node("revise", skeptic.bump_revise)
        g.add_edge("investigator", "skeptic")
        g.add_conditional_edges(
            "skeptic", skeptic.route_after_skeptic, {"revise": "revise", "exposure": "exposure"}
        )
        g.add_edge("revise", "investigator")
    else:
        g.add_edge("investigator", "exposure")
    g.add_edge("exposure", "playbook")

    if use_judge:
        g.add_node("judge", judge.make(deps))
        g.add_edge("playbook", "judge")
        g.add_conditional_edges(
            "judge", judge.route_after_judge, {"repair": "playbook", "hitl": "hitl"}
        )
    else:
        g.add_edge("playbook", "hitl")
    g.add_edge("hitl", "learn")
    g.add_edge("learn", END)
    return g.compile(checkpointer=checkpointer or MemorySaver())


def _live_retrieve(zetaris):
    """Rank in Postgres and hydrate through this run's Zetaris client."""

    def retrieve(query: str, k: int, filters: dict | None):
        from floodsense_agents.retrieve_docs import (
            default_embedder,
            default_hydrate,
            default_search,
            default_search_generic,
            retrieve_docs,
        )

        return retrieve_docs(
            query,
            k,
            filters,
            embedder=default_embedder,
            search=default_search,
            hydrate=lambda ids: default_hydrate(ids, zetaris),
            search_generic=default_search_generic,
        )

    return retrieve
