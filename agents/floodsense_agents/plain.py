"""The calm, plain-language answer of the quick and forecast lanes. No model call.

Both lanes build analyst-style claims and a summary. This module adds a `plain`
object next to them for a worried reader: a short headline, one sentence, the
history framed as history, one next step and one short disclaimer. Everything
here is a fixed rule over what the lane already computed; nothing is written by a
model, and the claims and the summary are not touched.

Rules (tested in tests/test_plain.py):

* Calm only when every status the lane computed is Normal and the data is
  complete: "Nothing alarming expected at <place>." Never reassure otherwise.
* Missing, stale, unknown or not-covering-the-horizon data says so: "We can't
  fully check <place> right now."
* Watch or elevated: "Keep an eye on <place>: <the one reason>." Above mean high
  water on a gauge: "Water is high at <place>. Follow official warnings."
* A number appears in a sentence only when it is a cell of a cited claim.
* The horizon is "7d" when the question asks for the week or the next days and the
  river forecast (eu_watch, a 7-day GloFAS maximum) covers it; otherwise "48h",
  and the sentence says honestly that no week-ahead data exists for that place.
* History (a recalled memory, a document passage, the past pattern) is labelled
  as history, with its source, "demo seed" when seeded, cut at a sentence
  boundary.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

NORMAL, WATCH, ELEVATED, UNKNOWN = "normal", "watch", "elevated", "unknown"
_RANK = {NORMAL: 0, UNKNOWN: 1, WATCH: 2, ELEVATED: 3}
H48, D7 = "48h", "7d"

NEXT_STEP = "Ask me about another place or open the official warnings."
FALLBACK_SERVICE = "your national weather and flood service"

# ------------------------------------------------------------------ horizon

# "this week", "next days", "rest of the week" (EN); "nächste Woche" (DE);
# "esta semana" (ES). "next 3 days" and longer count as a week-ahead question;
# "tomorrow", "next 48 hours" and "next 2 days" stay 48 h.
_WEEK = re.compile(
    r"\b(?:"
    r"(?:this|next|coming|following)\s+week(?!end)|the\s+week\s+ahead|rest\s+of\s+(?:the|this)\s+week|"
    r"over\s+the\s+week|(?:next|coming)\s+(?:few\s+)?days|"
    r"(?:next|coming)\s+(?:[3-9]|three|four|five|six|seven)\s*(?:days?|d)|(?:7|seven)[\s-]*days?|"
    r"diese[rn]?\s+woche|n[äa]chste[rn]?\s+woche|kommende[rn]?\s+woche|restliche[rn]?\s+woche|"
    r"(?:in\s+den\s+)?(?:n[äa]chsten|kommenden)\s+(?:[3-9]\s+)?tage[n]?|(?:7|sieben)\s+tage[n]?|"
    r"esta\s+semana|pr[óo]xima\s+semana|resto\s+de\s+la\s+semana|semana\s+que\s+viene|"
    r"pr[óo]ximos\s+(?:[3-9]\s+)?d[ií]as"
    r")\b",
    re.IGNORECASE | re.UNICODE,
)


def horizon_of(question: str | None) -> str:
    """"7d" when the question asks about the week or the next days, else "48h"."""
    return D7 if _WEEK.search(question or "") else H48


# --------------------------------------------------------------- text helpers

_ABBREVIATIONS = {"st", "dr", "no", "nr", "ca", "approx", "vs", "hann", "mt", "fig"}
_DOC_MARK = re.compile(r"\s*\[doc\b[^\]]*\]")
_OPEN_DOC_MARK = re.compile(r"\s*\[doc\b[^\]]*$")
_DOC_ID = re.compile(r"\[doc\s+([\w.-]+)")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"“(\[])")


def clean_quote(text: str) -> str:
    """One line, without a `[doc ..., section N, ...]` marker (also a cut-off one)."""
    t = _DOC_MARK.sub("", str(text or ""))
    t = _OPEN_DOC_MARK.sub("", t)
    return " ".join(t.split())


def _sentence_ends(t: str) -> list[int]:
    ends = []
    for m in _SENTENCE_END.finditer(t):
        word = re.findall(r"([A-Za-z]+)\.$", t[: m.start()])
        if word and (word[0].lower() in _ABBREVIATIONS or len(word[0]) == 1):
            continue
        ends.append(m.start())
    return ends


def sentence_cut(text: str, limit: int = 240) -> str:
    """The text cut at a sentence boundary, never in the middle of a word.

    Whole when it fits. Otherwise the last sentence that ends within `limit`; else
    the first sentence when it is not absurdly long; else the last whole word,
    followed by an ellipsis.
    """
    t = clean_quote(text)
    if not t:
        return ""
    if len(t) <= limit:
        return t if t[-1] in ".!?\"”)" else t + "."
    ends = _sentence_ends(t)
    fit = [e for e in ends if e <= limit]
    if fit:
        return t[: fit[-1]]
    if ends and ends[0] <= limit * 2:
        return t[: ends[0]]
    cut = t[:limit]
    space = cut.rfind(" ")
    cut = cut[:space] if space > 0 else cut
    return cut.rstrip(" ,;:-–—") + "…"


def humanize_doc(doc_id: str) -> str:
    """wiki-2024-central-european-floods -> Wikipedia: 2024 Central European floods."""
    raw = str(doc_id or "").strip()
    if not raw:
        return ""
    body = raw[5:] if raw.lower().startswith("wiki-") else raw
    words = body.replace("_", "-").split("-")
    small = {"of", "the", "in", "and"}
    out = [
        w if w.isdigit() else w.lower() if (w.lower() in small and i > 0) else w.capitalize()
        for i, w in enumerate(words)
    ]
    title = " ".join(out)
    return f"Wikipedia: {title}" if raw.lower().startswith("wiki-") else title


_RIVERS = {
    "RHEIN": "Rhine",
    "DONAU": "Danube",
    "MOSEL": "Mosel",
    "ELBE": "Elbe",
    "ODER": "Oder",
    "WESER": "Weser",
    "EMS": "Ems",
    "MAIN": "Main",
    "NECKAR": "Neckar",
    "SAAR": "Saar",
}


def nice_name(name: str | None) -> str:
    """KÖLN -> Köln. Names that already carry lower-case letters stay as they are."""
    n = " ".join(str(name or "").split())
    return n.title() if n.isupper() else n


def nice_river(river: str | None) -> str | None:
    r = " ".join(str(river or "").split())
    if not r:
        return None
    return _RIVERS.get(r.upper(), r.title() if r.isupper() else r)


def join_names(names: list[str]) -> str:
    names = list(dict.fromkeys(n for n in names if n))
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def service_for(countries: list[str | None]) -> str:
    """The official services of the asked places' countries (the forecast lane's table)."""
    from floodsense_agents.nodes.forecast import OFFICIAL

    found = [OFFICIAL[c] for c in dict.fromkeys(c for c in countries if c) if c in OFFICIAL]
    return "; ".join(found) or FALLBACK_SERVICE


# -------------------------------------------------------------------- checks


@dataclass
class Signal:
    """One computed status of one place: its level, its river forecast or its rain forecast."""

    role: Literal["level", "river", "rain"]
    status: str  # normal | watch | elevated | unknown
    above_mhw: bool = False  # a gauge at or above mean high water
    level_text: str | None = None  # the level as the claim states it, e.g. "187"
    trend: str | None = None  # rising | falling | steady, when a claim states it
    valencia: bool = False  # a hazard_now point: no usual range, only a demo line


@dataclass
class Check:
    """What a lane computed for one asked place."""

    name: str
    river: str | None
    country: str | None
    kind: Literal["gauge", "model"]
    signals: list[Signal] = field(default_factory=list)
    needs: tuple[str, ...] = ()
    covers_week: bool = False
    stale: bool = False
    week_note: str | None = None  # why this place has no week-ahead data

    @property
    def where(self) -> str:
        return f"the {self.river} at {self.name}" if self.river else self.name

    @property
    def missing(self) -> list[str]:
        have = {s.role for s in self.signals}
        return [r for r in self.needs if r not in have]


def _level_phrase(s: Signal, claims_text: str) -> str:
    num = f"at {s.level_text} cm, " if s.level_text and f"{s.level_text} cm" in claims_text else ""
    trend = {"rising": " and rising", "falling": " and falling"}.get(s.trend or "", "")
    if s.status == NORMAL:
        return f"is {num}below its usual high-water mark{trend}"
    if s.status == WATCH:
        return f"is {num}close to its usual high-water mark{trend}"
    if s.status == ELEVATED:
        return f"is {num}above its usual high-water mark{trend}"
    if num:
        return f"is {num.rstrip(', ')} (we have no high-water mark to compare it with)"
    return "has no high-water mark to compare with"


def _river_phrase(s: Signal, week: bool) -> str:
    when = " this week" if week else ""
    if s.valencia:
        return {
            NORMAL: "has no high river flow forecast",
            WATCH: "has raised river flow forecast",
            ELEVATED: "has high river flow forecast",
        }.get(s.status, "has no usable river forecast")
    return {
        NORMAL: f"is {'expected to stay' if week else 'flowing'} within its normal range{when}",
        WATCH: f"is forecast to run higher than usual{when}",
        ELEVATED: f"is forecast to run much higher than usual{when}",
    }.get(s.status, "has no usable river forecast")


def _rain_clause(s: Signal, week: bool, where: str = "") -> str:
    # The rain status is the 48 h total (the weather row also holds 72 h): never "this week".
    when = "over the next two days"
    return {
        NORMAL: f"no significant rain is forecast{where} {when}",
        WATCH: f"a lot of rain is forecast{where} {when}",
        ELEVATED: f"very heavy rain is forecast{where} {when}",
    }.get(s.status, f"the rain forecast{where} is unclear")


_REASON = {
    ("level", WATCH): "the water level is close to its usual high-water mark",
    ("level", ELEVATED): "the water level is above its usual high-water mark",
    ("river", WATCH): "the river is forecast to run higher than usual",
    ("river", ELEVATED): "the river is forecast to run much higher than usual",
    ("rain", WATCH): "a lot of rain is forecast",
    ("rain", ELEVATED): "very heavy rain is forecast",
}
_REASON_VALENCIA = {
    WATCH: "river flow is forecast to rise",
    ELEVATED: "high river flow is forecast",
}
_ROLE_ORDER = {"level": 0, "river": 1, "rain": 2}


def _cap(text: str) -> str:
    return text[:1].upper() + text[1:]


def _check_sentence(c: Check, week: bool, claims_text: str) -> str | None:
    sigs = sorted(
        (s for s in c.signals if s.status != UNKNOWN or s.role == "level"),
        key=lambda s: _ROLE_ORDER[s.role],
    )
    verbs: list[str] = []
    clauses: list[str] = []
    for s in sigs:
        if s.role == "level":
            verbs.append(_level_phrase(s, claims_text))
        elif s.role == "river":
            verbs.append(_river_phrase(s, week and c.covers_week))
        else:
            clauses.append(_rain_clause(s, week, "" if verbs else f" for {c.name}"))
    if not verbs and not clauses:
        return None
    if verbs:
        subject = _cap(c.where)
        text = f"{subject} {verbs[0]}"
        text += "".join(f" and {v}" for v in verbs[1:])
        glue = ", and " if " and " in text else " and "
        text += "".join(f"{glue}{cl}" for cl in clauses)
    else:
        text = _cap(clauses[0]) + "".join(f" and {cl}" for cl in clauses[1:])
    return text + "."


def _reason(c: Check) -> str:
    worst = max(
        (s for s in c.signals if s.status in (WATCH, ELEVATED)),
        key=lambda s: (_RANK[s.status], -_ROLE_ORDER[s.role]),
    )
    if worst.valencia and worst.role == "river":
        return _REASON_VALENCIA[worst.status]
    return _REASON[(worst.role, worst.status)]


def build_plain(
    checks: list[Check],
    *,
    asked: str,
    claims: list[dict[str, Any]],
    context: str | None = None,
) -> dict[str, Any]:
    """The `plain` object for the places a lane checked. Pure and deterministic."""
    asked = D7 if asked == D7 else H48
    claims_text = " ".join(str(c.get("text") or "") for c in claims)
    names = [c.name for c in checks]
    place = join_names(names) or "this place"
    week_ok = asked == D7 and any(c.covers_week for c in checks)
    horizon = D7 if week_ok else H48
    sigs = [(c, s) for c in checks for s in c.signals]
    # Forward-looking per place: a place checked only by a present gauge reading is never "expected" calm.
    reading_only = [c for c in checks if c.signals and all(s.role == "level" for s in c.signals)]
    forecasted = [c for c in checks if c not in reading_only]


    top = max((s for _, s in sigs), key=lambda s: _RANK[s.status], default=None)
    status = top.status if top and top.status in (WATCH, ELEVATED) else NORMAL
    gaps: list[str] = []
    for c in checks:
        if c.stale:
            gaps.append(
                f"The latest reading for {c.name} is out of date, so we can't confirm the water level."
            )
        elif c.missing or any(s.status == UNKNOWN and s.role != "level" for s in c.signals):
            gaps.append(f"We could not read all the data for {c.name} just now.")
        if asked == D7 and not c.covers_week:
            gaps.append(
                c.week_note
                or f"We only have a two-day outlook for {c.where}, not a full week."
            )
    complete = bool(checks) and not gaps and all(
        s.status != UNKNOWN for _, s in sigs
    ) and all(c.signals for c in checks)
    if status == NORMAL and not complete:
        status = UNKNOWN

    # headline: fixed rules over the computed statuses
    high = [c.name for c, s in sigs if s.role == "level" and s.above_mhw]
    if high:
        headline = f"Water is high at {join_names(high)}. Follow official warnings."
        for c in checks:  # another place elevated by a model band is named too
            if c.name not in high and any(s.status in (WATCH, ELEVATED) for s in c.signals):
                headline += f" Keep an eye on {c.name}: {_reason(c)}."
    elif status in (WATCH, ELEVATED):
        worst_check = max(
            (c for c in checks if any(s.status in (WATCH, ELEVATED) for s in c.signals)),
            key=lambda c: max(_RANK[s.status] for s in c.signals),
        )
        headline = f"Keep an eye on {worst_check.name}: {_reason(worst_check)}."
    elif status == NORMAL and not reading_only:
        headline = f"Nothing alarming expected at {place}."
    elif status == NORMAL:
        # A place with only a present gauge reading gets no forward-looking claim.
        rn = join_names([c.name for c in reading_only])
        verb = "is" if len(set(c.name for c in reading_only)) == 1 else "are"
        headline = f"{rn} {verb} at a normal level right now"
        if forecasted:
            headline += f" (today's reading). Nothing alarming expected at {join_names([c.name for c in forecasted])}."
        else:
            headline += "."
    else:
        headline = f"We can't fully check {place} right now."

    sentences = [
        s
        for s in (_check_sentence(c, week_ok and asked == D7, claims_text) for c in checks)
        if s
    ]
    if status in (WATCH, ELEVATED) and any(s.valencia or s.role == "river" for _, s in sigs):
        if all(c.kind == "model" for c, s in sigs if s.status in (WATCH, ELEVATED)):
            sentences.append("This is a model estimate, not a measurement.")
    if status == NORMAL and reading_only:
        if forecasted:
            sentences.append(
                f"For {join_names([c.name for c in reading_only])} this is today's reading, not a forecast."
            )
        else:
            sentences.append("This is today's reading, not a forecast.")
    one_line = " ".join([*sentences, *gaps]) or f"We could not read any data for {place} just now."

    countries = [c.country for c in checks]
    service = service_for(countries)
    basis = "gauge" if top and top.role == "level" and top.status in (WATCH, ELEVATED) else "model"
    if status == NORMAL:
        basis = "gauge" if all(s.role == "level" for _, s in sigs) else "model"
    return {
        "headline": headline,
        "one_line": one_line,
        "horizon": horizon,
        "status": status,
        "basis": basis,
        "places": list(dict.fromkeys(names)),
        "country": next((c for c in countries if c), None),
        "countries": list(dict.fromkeys(c for c in countries if c)),
        "service": service,
        "context": context,
        "next_step": NEXT_STEP,
        "disclaimer": f"Model-based check, not an official warning. Follow {service}.",
        "details": [str(c.get("claim_id")) for c in claims if c.get("claim_id")],
    }


# ------------------------------------------------------------------- context


def memory_context(memory: dict[str, Any], seeded: bool) -> str | None:
    """A recalled memory as history: its finding, its source, "demo seed" when seeded."""
    content = str(memory.get("content") or "")
    finding = sentence_cut(content)
    if not finding:
        return None
    doc = _DOC_ID.search(content)
    source = humanize_doc(doc.group(1)) if doc else "an earlier approved run"
    if memory.get("run_id") and not seeded:
        source += f" (run {memory['run_id']})"
    return _context(finding, source, seeded)


def passage_context(raw: dict[str, Any]) -> str | None:
    finding = sentence_cut(str(raw.get("quote") or raw.get("text") or ""))
    if not finding:
        return None
    return _context(finding, str(raw.get("title") or "a document"), False)


def pattern_context(label: str, days: str, rain_mm: str, where: str) -> str:
    finding = f"before the {label} ({days}), rain over 48 hours reached {rain_mm} mm at {where}."
    return _context(finding, "FloodSense replay data", False)


def _context(finding: str, source: str, seeded: bool) -> str:
    tag = f"{source}, demo seed" if seeded else source
    return f"For context, from the past: {finding} (history, from {tag}; not today's conditions)"


# ------------------------------------------------------------------ checking

_DIGITS = re.compile(r"\d[\d.,]*")


def numbers_outside_claims(plain: dict[str, Any], claims: list[dict[str, Any]]) -> list[str]:
    """Digit runs in the headline / one_line that no claim text and no place name carries."""
    allowed = " ".join(str(c.get("text") or "") for c in claims) + " " + " ".join(plain["places"])
    text = f"{plain['headline']} {plain['one_line']}"
    return [m for m in _DIGITS.findall(text) if m.rstrip(".,") not in allowed]
