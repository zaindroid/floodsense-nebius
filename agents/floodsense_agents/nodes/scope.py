"""The gate that lets the agents decline.

An agent that answers everything is an agent whose answers mean nothing.
The contract views cover two events, one portfolio, and Rhine gauge levels.
A question about the Rhine at Köln during a Valencia run is still declined:
the gate follows the event vocabulary, not every table the warehouse holds.

The rule is deliberately narrow, because refusing a fair question is worse
than answering a vague one:

  no place named          answer it. "Why are our sites at risk" is fine.
  a place this run holds  answer it.
  a place another event   stop, and name the case that does hold it.
  a place nothing holds   stop, and say which views exist.

Place-like words are read from the question, not guessed at: a token only
counts if it follows "in", "at", "near", "around", "for" or "on", or is
capitalised away from the start of a sentence. Everything compares against
the vocabulary the events themselves declare, so adding an event teaches
the gate without touching this file.
"""

from __future__ import annotations

import re
import time

from floodsense_agents.events import EVENTS, WATCH_EVENT, spec
from floodsense_agents.governance import CONTRACT_VIEWS
from floodsense_agents.live import resolve_mode
from floodsense_agents.state import FloodState, trace

# Words that look like places but are ours, or are grammar.
_GENERIC = {
    "our",
    "us",
    "we",
    "the",
    "a",
    "an",
    "risk",
    "site",
    "sites",
    "policy",
    "policies",
    "portfolio",
    "exposure",
    "insured",
    "customer",
    "client",
    "flood",
    "flooding",
    "water",
    "rain",
    "rainfall",
    "river",
    "discharge",
    "gauge",
    "warning",
    "alert",
    "today",
    "now",
    "next",
    "hours",
    "hour",
    "day",
    "days",
    "why",
    "what",
    "which",
    "how",
    "when",
    "where",
    "who",
    "and",
    "or",
    "of",
    "to",
    "is",
    "are",
    "was",
    "were",
    "this",
    "that",
    "these",
    "those",
    "morning",
    "evening",
    "night",
    "area",
    "region",
    "catchment",
    "footprint",
    "event",
    "events",
    "data",
    "claim",
    "claims",
}

# Capitalised words that name a time or an organisation, not a place. Without
# these the gate refused "as of noon on 29 October" and "inside the Copernicus
# footprint", which is far worse than answering something vague.
_NOT_PLACES = {
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "utc",
    "cet",
    "cest",
    "gmt",
    "noon",
    "midnight",
    # The providers behind the views. Named in provenance, not places on a map.
    "copernicus",
    "ems",
    "aemet",
    "glofas",
    "meteo",
    "openmeteo",
    "saih",
    "chj",
    "dwd",
    "lanuk",
    "openstreetmap",
    "osm",
    "zetaris",
    "pegelonline",
    "pegel",
    "wsv",
    "itzbund",
    "gdws",
    "nightshift",
    "floodsense",
    "emsr773",
    "emsr517",
}

_AFTER = re.compile(r"\b(?:in|at|near|around|for|on)\s+([A-Za-zÀ-ÿ][\w'\-]*)", re.I)
_CAPS = re.compile(r"(?<![.!?]\s)(?<!^)\b([A-ZÀ-Þ][a-zà-ÿ'\-]{2,})\b")
_WORD = re.compile(r"[\w'\-]+", re.UNICODE)


def _tokens(text: str) -> set[str]:
    """Lowercased words that look like they name somewhere."""
    found = {m.group(1).lower() for m in _AFTER.finditer(text or "")}
    found |= {m.group(1).lower() for m in _CAPS.finditer(text or "")}
    return {t for t in found if t not in _GENERIC and t not in _NOT_PLACES and len(t) > 2}


def vocabulary(event_id: str) -> set[str]:
    """Every place word one event declares about itself."""
    ev = spec(event_id)
    words: set[str] = {event_id.lower()}
    for phrase in (ev.name, ev.region, ev.river, ev.catchment):
        words |= {m.group(0).lower() for m in _WORD.finditer(phrase)}
    for pid in ev.river_points + ev.rain_points:
        words |= {part for part in re.split(r"[-_]", pid.lower()) if part}
    for place in ev.place_names:
        words |= {m.group(0).lower() for m in _WORD.finditer(place)}
    return {w for w in words if w not in _GENERIC and len(w) > 2}


def _sentence(text: str) -> str:
    """The reason is shown to a person as the whole answer, so it opens like one."""
    return text[:1].upper() + text[1:] if text else text


# How a person names each event's case: (the case, where we are). The German case
# also holds the live Rhine gauges, so it is named for both, not only the 2021 flood.
_PLAIN: dict[str, tuple[str, str]] = {
    "EMSR773": ("the Valencia case", "Valencia"),
    "EMSR517": ("the German Rhine/Ahr case", "the German Rhine/Ahr case"),
}


def _as_asked(question: str, words: set[str]) -> list[str]:
    """The matched words in the capitalisation the person typed, in question order."""
    out: list[str] = []
    for m in _WORD.finditer(question or ""):
        w = m.group(0)
        if w.lower() in words and w not in out:
            out.append(w)
    return out or sorted(words)


def elsewhere_reason(event_id: str, other: str, hit: set[str], question: str = "") -> str:
    """A warm decline that still says plainly why: the words belong to the other event."""
    case, _ = _PLAIN.get(other, (f"case {other}", ""))
    _, here = _PLAIN.get(event_id, ("", spec(event_id).region))
    return (
        f"That's about {case} ({other}: {spec(other).name}). I'm looking at {here} "
        f"({event_id}) here, and this run holds no data on {', '.join(_as_asked(question, hit))}. "
        f"Switch to {case} and I'll answer it."
    )


def check(question: str, event_id: str) -> dict:
    """Decide whether this run can honestly take the question on."""
    asked = _tokens(question)
    if not asked:
        return {"in_scope": True, "reason": "no place named; answered for the configured event"}

    mine = vocabulary(event_id)
    if asked & mine:
        return {
            "in_scope": True,
            "reason": f"question names {', '.join(sorted(asked & mine))}, which this event covers",
        }

    for other in EVENTS:
        if other == event_id:
            continue
        hit = asked & vocabulary(other)
        if hit:
            return {
                "in_scope": False,
                "elsewhere": other,
                "asked": sorted(asked),
                "reason": elsewhere_reason(event_id, other, hit, question),
            }

    return {
        "in_scope": False,
        "elsewhere": None,
        "asked": sorted(asked),
        "reason": _sentence(
            f"nothing in this run covers {', '.join(sorted(asked))}. The agents read "
            f"{len(CONTRACT_VIEWS)} views only: {', '.join(CONTRACT_VIEWS)}, which hold "
            f"{', '.join(spec(e).region for e in EVENTS)}."
        ),
    }


def make():
    def scope(state: FloodState) -> dict:
        t = time.time()
        request = state.get("request") or {}
        question = request.get("question", "")
        verdict = check(question, state["event_id"])
        # Event replay or live hazard_now. Decided once, here, so every node
        # and the run body read the same answer.
        mode = resolve_mode(request)
        # The Europe live watch has no replay window: its views are live only.
        if state["event_id"] == WATCH_EVENT and mode["mode"] != "live":
            mode = {
                "mode": "live",
                "explicit": mode.get("explicit"),
                "reason": f"{WATCH_EVENT} reads live views only ({mode['reason']})",
            }
        note = f"; mode {mode['mode']}: {mode['reason']}"
        if state.get("event_route"):
            note += f"; event {state['event_id']}: {state['event_route']}"
        ctx = {k: v for k, v in (request.get("context") or {}).items() if v}
        if ctx:
            note += "; context " + ", ".join(f"{k}={v}" for k, v in sorted(ctx.items()))
        if verdict["in_scope"]:
            return {
                "scope": verdict,
                "mode": mode,
                "status": "running",
                "trace": trace(state, "scope", verdict["reason"] + note, lane="none", started=t),
            }
        # Declining costs one SQL query and no model call, which is the point:
        # the cheapest answer is the one we do not make up.
        return {
            "scope": verdict,
            "mode": mode,
            "status": "out_of_scope",
            "summary": verdict["reason"],
            "claims": [],
            "hypotheses": [],
            "playbook": [],
            "exposure": {},
            "trace": trace(
                state,
                "scope",
                f"declined: {verdict['reason']}",
                lane="none",
                started=t,
            ),
        }

    return scope


def route_after_scope(state: FloodState) -> str:
    return "watchers" if (state.get("scope") or {}).get("in_scope", True) else "declined"
