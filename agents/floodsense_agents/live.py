"""Live mode: which question reads hazard_now instead of the event window.

An event run replays a frozen Copernicus window (EMSR773 is 28-30 Oct 2024).
A question about now, tonight or the next 48 hours asked of that window gets a
2024 answer, which is wrong in a way the citations cannot show. Live mode reads
{schema}.hazard_now instead: the past few days (Open-Meteo / GloFAS modelled)
and a ~48 h forecast, each row labelled by `horizon`.

resolve_mode() decides, deterministically:
  replay_ts set           event (a replay clock is a point in the event window)
  explicit mode           that mode
  question about now      live (EN, ES, DE time words below)
  anything else           event

A question about a Europe live-watch place (events.watch_question: a
PEGELONLINE gauge off the Rhine/Mosel or a GloFAS point in {schema}.eu_watch,
no replay-event place named, and a present cue or a level word with no past
cue) is live too, and runs as event LIVE-EU.

A German event (EMSR517) in live mode is "the Rhine right now": the
Investigator reads {schema}.gauge_levels (PEGELONLINE) and says plainly when
hazard_now holds no German point.

api/app/cache.py keeps a copy of LIVE_PATTERNS so a cache key agrees with the
mode the agents will pick. Change both together.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from floodsense_agents.events import (
    AHR_POINT_IDS,
    VALENCIA_POINT_IDS,
    WATCH_EVENT,
    watch_question,
)
from floodsense_agents.watch import EU_POINT_IDS
from floodsense_agents.settings import settings
from floodsense_agents.watch import sql_list

LIVE_DISABLED = (
    "live data disabled (FF_LIVE_DATA off): floodsense_seed.hazard_now holds the frozen "
    "replay window, not a past and a forecast"
)

LIVE = "live"
EVENT = "event"
FORECAST_HOURS = 48
# A forecast reaching less than this far past now means the sync is old.
STALE_FORECAST_H = 24
# The seed twin of hazard_now (migration 040) labels every row 'replay': it is
# the frozen 2024 window, not a present. Only past and forecast rows are live.
LIVE_ROWS = "horizon IN ('past', 'forecast')"

LIVE_PATTERNS: tuple[str, ...] = (
    r"now",
    r"right now",
    r"currently",
    r"today",
    r"tonight",
    r"tomorrow",
    r"this week",
    r"next \d+ ?(?:h|hours?|days?)",
    r"next (?:few )?(?:hours?|days?)",
    r"coming (?:hours?|days?)",
    # Spanish
    r"ahora",
    r"hoy",
    r"ma(?:ñ|n)ana",
    r"pr(?:ó|o)xim[ao]s \d+ ?(?:h|horas?)",
    # German. "Guten Morgen" is a greeting, not tomorrow.
    r"jetzt",
    r"heute",
    r"(?<!guten )morgen",
    r"n(?:ä|a)chsten \d+ ?(?:h|stunden)",
)
# A question that names the past is an event question, whatever else it says.
EVENT_PATTERNS: tuple[str, ...] = (
    r"(?:19\d{2}|20(?:[01]\d|2[0-4]))",  # a year up to 2024
    r"\d{4}-\d{2}-\d{2}",  # an explicit date
    r"\d{1,2}\.? (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ene|abr|ago|dic|"
    r"okt|dez|mai|juli?|juni?|m(?:ä|a)r)\w*",
    r"emsr\d*",
    r"on that day",
)
_EVENT_RE = re.compile(
    "|".join(rf"\b(?:{p})\b" for p in EVENT_PATTERNS), re.IGNORECASE | re.UNICODE
)
_LIVE_RE = re.compile("|".join(rf"\b(?:{p})\b" for p in LIVE_PATTERNS), re.IGNORECASE | re.UNICODE)


def classify(question: str) -> tuple[str, str]:
    """(mode, reason) from the question alone."""
    past = _EVENT_RE.search(question or "")
    if past:
        return EVENT, f"question names a past moment ('{past.group(0)}')"
    m = _LIVE_RE.search(question or "")
    if m:
        return LIVE, f"question asks about the present ('{m.group(0)}')"
    # The Europe watch places (Budapest, the Elbe at Dresden) have no replay
    # window: only their live views hold them.
    target = watch_question(question or "")
    if target:
        return LIVE, f"question asks about a live-watch place ('{target['word']}')"
    return EVENT, "question names no present-time window"


def resolve_mode(request: dict) -> dict:
    """The effective mode of a run, why, and whether the caller chose it."""
    explicit = request.get("mode")
    if request.get("replay_ts"):
        return {
            "mode": EVENT,
            "explicit": explicit,
            "reason": "replay_ts is set, so the run replays the event window",
        }
    if explicit == LIVE and not settings.live_data:
        return {
            "mode": LIVE,
            "explicit": LIVE,
            "reason": f"mode=live requested, but {LIVE_DISABLED}",
        }
    if explicit in (LIVE, EVENT):
        return {"mode": explicit, "explicit": explicit, "reason": f"mode={explicit} requested"}
    mode, reason = classify(str(request.get("question") or ""))
    if mode == LIVE and not settings.live_data:
        return {"mode": EVENT, "explicit": None, "reason": f"{reason}, but {LIVE_DISABLED}"}
    return {"mode": mode, "explicit": None, "reason": reason}


def is_live(state: dict) -> bool:
    return (state.get("mode") or {}).get("mode") == LIVE


def live_points(event: dict) -> tuple[str, ...]:
    """Every warehouse point of the event's region. hazard_now holds all of them."""
    if str(event.get("event_id")) == "EMSR517":
        return AHR_POINT_IDS
    if str(event.get("event_id")) == WATCH_EVENT:
        return EU_POINT_IDS
    return VALENCIA_POINT_IDS


def focus(state: dict) -> dict:
    """The user's selection, mapped to known values only. Never an identifier.

    point_id: kept only when it is one of the event's warehouse points.
    station: uppercased and quote-escaped, for use as a string literal.
    role: citizen | insurer | operator | None.
    """
    ctx = (state.get("request") or {}).get("context") or {}
    pid = ctx.get("point_id")
    station = ctx.get("station")
    station = str(station).upper().replace("'", "''") if station else None
    return {
        "point_id": pid if pid in live_points(state.get("event") or {}) else None,
        "station": station,
        "role": ctx.get("role") if ctx.get("role") in ("citizen", "insurer", "operator") else None,
        "page": ctx.get("page"),
        "place": ctx.get("place"),
    }


def points_sql(event: dict, point_id: str | None = None) -> str:
    """The event's points, or the one selected point when it is one of them."""
    pts = live_points(event)
    if point_id in pts:
        pts = (point_id,)
    return ", ".join(f"'{p}'" for p in pts)


CITIZEN_ADVICE = (
    "What to do: follow the official warnings (Germany: Hochwassermeldedienst of your Land, "
    "DWD, NINA app; Spain: AEMET, ES-Alert, Protección Civil); keep away from riverbanks, "
    "underpasses and cellars; call 112 in an emergency."
)


def phrase_for_role(summary: str, role: str | None, exposure_line: str | None = None) -> str:
    """Citizen: plain wording and what to do. Insurer: exposure first."""
    if role == "citizen":
        return f"In plain words: {summary} {CITIZEN_ADVICE}"
    if role == "insurer" and exposure_line:
        return f"Exposure: {exposure_line}. {summary}"
    return summary


# Germany in live mode: PEGELONLINE water levels in {schema}.gauge_levels.
# The seed rows (migration 043) carry no level and source seed:pegelonline.
GAUGE_LIVE_ROWS = "level_cm IS NOT NULL AND (source IS NULL OR source <> 'seed:pegelonline')"
# The reading this many places back is the trend baseline: about 3 h at the
# 15-minute PEGELONLINE interval. A station with fewer readings uses its oldest.
GAUGE_TREND_LAG = 13
# A reading older than this is reported as stale.
GAUGE_STALE_H = 6
# gauge_levels may gain an optional per-station threshold column. Its name is
# not fixed yet, so any numeric column whose name matches this is the threshold.
GAUGE_THRESHOLD_COL = re.compile(r"threshold|warn|alert|mhw|hsw|stufe|limit", re.IGNORECASE)
OFFICIAL_NOTE = "Not an official warning; official: Hochwassermeldedienst (Länder) / DWD."


def has_gauges(event: dict) -> bool:
    return bool(event.get("gauges"))


def gauge_latest_sql(
    schema: str, waters: tuple[str, ...] = (), stations: tuple[str, ...] = ()
) -> str:
    """Latest live reading per station plus a trend baseline, every column kept.

    `g.*` so an optional threshold column comes along when the view has one.
    waters / stations narrow it (the poller covers ten waterways since the EU watch).
    """
    lag = GAUGE_TREND_LAG
    narrow = ""
    if waters:
        narrow += f" AND g.water IN ({sql_list(waters)})"
    if stations:
        narrow += f" AND g.station IN ({sql_list(stations)})"
    return (
        f"WITH r AS (SELECT g.*, ROW_NUMBER() OVER (PARTITION BY g.station ORDER BY g.ts_utc "
        f"DESC) AS rn, COUNT(*) OVER (PARTITION BY g.station) AS n FROM {schema}.gauge_levels g "
        f"WHERE {GAUGE_LIVE_ROWS}{narrow}) SELECT a.*, b.ts_utc AS prev_utc, b.level_cm AS prev_cm "
        f"FROM r a LEFT JOIN r b ON b.station = a.station AND b.rn = CASE WHEN a.n < {lag} "
        f"THEN a.n ELSE {lag} END WHERE a.rn = 1 ORDER BY a.water, a.station"
    )


def gauge_threshold(row: dict) -> tuple[str, float] | None:
    """(column, value) of the station's threshold, when the view carries one.

    mhw_cm (mean high water, PR #58 contract) first; otherwise any matching name.
    """
    mhw = row.get("mhw_cm")
    if isinstance(mhw, str):  # Zetaris REST returns numbers as strings
        try:
            mhw = float(mhw)
        except ValueError:
            mhw = None
    if isinstance(mhw, (int, float)) and not isinstance(mhw, bool):
        return "mhw_cm", float(mhw)
    for key, value in row.items():
        if key in ("level_cm", "prev_cm") or not GAUGE_THRESHOLD_COL.search(str(key)):
            continue
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(key), float(value)
    return None


def horizon_word(horizon: str | None) -> str:
    if horizon == "forecast":
        return "forecast"
    return "past (observed-modelled)"


def hours_between(ts: str, now: str) -> int | None:
    try:
        a = datetime.strptime(str(ts)[:19].replace(" ", "T"), "%Y-%m-%dT%H:%M:%S")
        b = datetime.strptime(str(now)[:19].replace(" ", "T"), "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return round((a - b).total_seconds() / 3600)


def relative(ts: str, now: str) -> str:
    """'in 17 h' / '5 h ago' between two UTC stamps. Blank when unreadable."""
    try:
        a = datetime.strptime(str(ts)[:19].replace(" ", "T"), "%Y-%m-%dT%H:%M:%S")
        b = datetime.strptime(str(now)[:19].replace(" ", "T"), "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return ""
    delta = a.replace(tzinfo=timezone.utc) - b.replace(tzinfo=timezone.utc)
    hours = round(delta.total_seconds() / 3600)
    if hours > 0:
        return f"in {hours} h"
    if hours < 0:
        return f"{-hours} h ago"
    return "this hour"
