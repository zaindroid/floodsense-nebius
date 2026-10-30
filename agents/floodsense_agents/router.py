"""Router agent: which agent path answers a chat message.

Four lanes:

    reply     small talk and help (front_door.py): a fixed template, no run.
    quick     a live-data question one view read can answer: Scope, the live
              watcher (gauge_levels, hazard_now, eu_watch), template claims,
              the deterministic Judge. No Playbook, no HITL.
    forecast  "do the next 48 hours look safe at Köln?": Scope, forecast data
              (weather_forecast, the GloFAS discharge forecast, the gauge),
              history (replay seed, RAG passages, H-MEM), deterministic claims
              plus a template lead (no model call), the deterministic Judge (nodes/forecast.py).
    full   the deep investigation (graph.py), for why / replay / exposure /
           insurer actions / documents, and every explicit event_id,
           replay_ts or doc_query (so the evals keep their path).

Rules first. A clear full word wins; a forecast cue plus a watched place
picks forecast; a live word plus a known place picks quick. Only an ambiguous message (a live word or a place, not both) asks the
fast lane (``TASK: router``) with the front door's short deadline. A failure
there means full: the old behaviour.
"""

from __future__ import annotations

import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any

from floodsense_agents import front_door
from floodsense_agents.settings import settings
from floodsense_agents.watch import STATIONS, place_words, watch_target
from floodsense_agents.events import EVENTS, POINT_NAMES, RHINE_GAUGES
from floodsense_agents.live import classify as live_classify
from floodsense_agents.nightshift import LLM, parse_json, submit_with_deadline

log = logging.getLogger("floodsense.router")

REPLY, QUICK, FORECAST, FULL = "reply", "quick", "forecast", "full"
LANES = (REPLY, QUICK, FORECAST, FULL)

# A question about what comes next: a horizon, a forecast word, "will ... rise",
# "look safe". EN, DE, ES. "Guten Morgen" is a greeting, not tomorrow.
_FORECAST = re.compile(
    r"\b(next\s+(few\s+)?\d*\s*(h|hrs?|hours?|days?|week)|coming\s+(hours?|days?|week)|"
    r"tomorrow|tonight\s+and\s+tomorrow|this\s+week(end)?|over\s+the\s+weekend|"
    r"forecasts?|outlook|will\b[^?.!]{0,40}\b(rise|rising|flood\w*|go\s+up|overflow|"
    r"burst|be\s+safe|be\s+ok|stay\s+safe|get\s+worse)|look(s)?\s+(safe|ok|okay|fine)|"
    r"(?<!guten\s)morgen|übermorgen|nächsten?\s+(?:\d+\s*)?(?:stunden|std|tage|tagen|wochen?)|vorhersage\w*|"
    r"mañana|manana|próxim[oa]s?\s+(?:\d+\s*)?(?:horas?|d[ií]as?|semanas?)|proxim[oa]s?\s+(?:\d+\s*)?(?:horas?|dias?|semanas?)|pronóstico|pronostico|previsión|prevision)\b",
    re.I,
)

# A live reading: the present, a level, a trend, a short horizon.
_LIVE = re.compile(
    r"\b(now|right\s+now|today|tonight|current(ly)?|at\s+the\s+moment|latest|"
    r"levels?|how\s+high|rising|falling|dropping|going\s+up|"
    r"next\s+\d+\s*(h|hours?|days?)|\d+\s*h(ours)?|coming\s+hours|"
    r"jetzt|heute|pegel\w*|steigt|ahora|hoy|nivel\w*)\b",
    re.I,
)
# A question the quick lane must not answer: causes, the past, money, actions, documents.
_DEEP = re.compile(
    r"\b(why|explain\w*|how\s+come|caus\w*|reason\w*|replay\w*|happened|history|"
    r"historic\w*|past|last\s+(year|month|week)|exposure|exposed|polic(y|ies)|"
    r"claims?|insur\w*|underwrit\w*|portfolio|sites?|alerts?|draft\w*|notify|"
    r"playbook|adjuster|approv\w*|documents?|reports?|pdf|bulletin\w*|evidence|"
    r"compare|warum|por\s+qu[eé])\b",
    re.I,
)
# Ordinary words that are also river names; watch_target reads them only in context.
_AMBIGUOUS = {"main", "ems", "oder", "po"}


def _known_places() -> set[str]:
    # The Europe live-watch cities, rivers and stations (watch.py, PR #78): not copied here.
    words = {w.lower() for p in place_words() for w in re.findall(r"[^\W\d_]{3,}", p)}
    words |= {w.lower() for s, _ in STATIONS for w in re.findall(r"[^\W\d_]{3,}", s)}
    words |= {"valencia", "ahr", "turia", "magro", "poyo"}
    for ev in EVENTS.values():
        for phrase in (ev.region, ev.river, ev.catchment, *ev.place_names):
            words |= {w.lower() for w in re.findall(r"[^\W\d_]{3,}", phrase or "")}
    for name in POINT_NAMES.values():
        words |= {w.lower() for w in re.findall(r"[^\W\d_]{3,}", name)}
    for station, water in RHINE_GAUGES:
        words |= {station.lower(), water.lower()}
    stop = {"river", "the", "and", "bad", "region", "catchment", "basin", "der", "an"}
    stop |= {"european", "europe", "rivers", "basins", "live", "watch"}
    return words - stop - _AMBIGUOUS


PLACES = _known_places()
# Its own small pool: a timed-out router call never holds a front-door worker.
_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="router")
_WORD = re.compile(r"[^\W\d_][\w'-]*")

SYSTEM = """TASK: router
You route one flood question for FloodSense EU. Answer with JSON only:
{"lane": "quick" | "full"}.
quick: it asks for a current reading at one place (a river level, whether it is rising,
whether a point is at risk in the next hours) that live gauge and forecast rows answer.
full: anything that needs causes, the past, insurance exposure, actions, documents,
or several steps of reasoning, and every case where you are unsure.
Do not answer the question."""


def enabled() -> bool:
    v = (os.environ.get("FF_QUICK_LANE") or "true").strip().lower()
    return v in ("1", "true", "yes", "on")


def forecast_enabled() -> bool:
    v = (os.environ.get("FF_FORECAST_LANE") or "true").strip().lower()
    return v in ("1", "true", "yes", "on")


def _ctx_dict(context: Any) -> dict:
    if context is None:
        return {}
    if isinstance(context, dict):
        return context
    dump = getattr(context, "model_dump", None)
    return dump() if callable(dump) else {}


def place_in(question: str, context: Any = None) -> str | None:
    """The first known place, station or river the message names, upper-cased."""
    target = watch_target(question or "")
    if target and target.get("word"):
        return str(target["word"]).upper()
    for w in _WORD.findall(question or ""):
        if w.lower() in PLACES:
            return w.upper()
    for key in ("station", "place", "point_id"):
        v = getattr(context, key, None) if context is not None else None
        if v:
            return str(v).upper()
    return None


def rules(question: str, context: Any = None) -> tuple[str | None, str]:
    """(lane or None when ambiguous, reason)."""
    q = " ".join((question or "").split())
    deep = _DEEP.search(q)
    if deep:
        return FULL, f"asks '{deep.group(0).lower()}', which needs the full investigation"
    mode, why = live_classify(q)
    if mode == "event" and why.startswith("question names a past moment"):
        return FULL, why
    place = place_in(q, context)
    cue = _FORECAST.search(q)
    if cue and forecast_enabled():
        from floodsense_agents.nodes.forecast import forecast_places, label

        named = forecast_places(q, _ctx_dict(context))
        if named:
            return FORECAST, (
                f"forecast question ('{cue.group(0).lower()}') about "
                f"{', '.join(label(p) for p in named)}"
            )
    live = _LIVE.search(q)
    if live and place:
        return QUICK, f"live {_kind(live.group(0))} question about {place}"
    if live:
        return None, f"live word '{live.group(0).lower()}' but no known place"
    if place:
        return None, f"names {place} but no live word"
    return FULL, "no live reading asked for"


def _kind(word: str) -> str:
    w = word.lower()
    if "level" in w or "high" in w or "pegel" in w or "nivel" in w:
        return "level"
    if w in ("rising", "falling", "dropping", "going up", "steigt"):
        return "trend"
    return "data"


def _ask_model(llm: LLM, question: str, timeout: float) -> tuple[str, str] | None:
    fut = submit_with_deadline(_POOL, timeout, llm.complete, "fast", SYSTEM, question[:500])
    try:
        text, model_id = fut.result(timeout=timeout)
        lane = str(parse_json(text).get("lane", "")).strip().lower()
    except FutureTimeout:
        log.warning("router: fast lane over %.1fs; full lane", timeout)
        return None
    except Exception as e:  # noqa: BLE001 - any model failure means the full lane
        log.warning("router: fast lane failed (%s); full lane", type(e).__name__)
        return None
    return (lane, model_id) if lane in (QUICK, FULL) else None


def route(req: Any, llm: LLM | None = None) -> dict[str, Any]:
    """{lane, reason, model_id, latency_ms} for a run request (quick or full).

    The reply lane is decided earlier by front_door.front_door; a request that
    reaches a run is quick or full.
    """
    t0 = time.monotonic()

    def out(lane: str, reason: str, model_id: str = "rules") -> dict[str, Any]:
        return {
            "lane": lane,
            "reason": f"chose {lane}: {reason}",
            "model_id": model_id,
            "latency_ms": int((time.monotonic() - t0) * 1000),
        }

    if front_door.explicit_run(req):
        return out(FULL, "explicit event_id, replay_ts or doc_query")
    if getattr(req, "mode", None) == "event":
        return out(FULL, "mode=event requested")
    if not enabled() and not forecast_enabled():
        return out(FULL, "FF_QUICK_LANE and FF_FORECAST_LANE are off")
    if not settings.live_data:
        # The seed schema holds no present: the quick lane would answer "now" from a replay.
        return out(FULL, "live data is off (FF_LIVE_DATA), so nothing answers now")
    ctx = getattr(req, "context", None)
    lane, reason = rules(req.question, ctx)
    if lane == QUICK and not enabled():
        return out(FULL, f"{reason}, but FF_QUICK_LANE is off")
    if lane is not None:
        return out(lane, reason)
    if not enabled():
        return out(FULL, f"{reason}; FF_QUICK_LANE is off")
    if llm is None:
        return out(FULL, f"{reason}; no model to ask")
    got = _ask_model(llm, req.question, front_door._timeout_s())
    if got is None:
        return out(FULL, f"{reason}; the fast lane did not decide")
    lane, model_id = got
    return out(lane, f"{reason}; the fast lane said {lane}", model_id)
