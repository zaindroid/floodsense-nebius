"""Europe live watch: which gauges and model points a question is about.

Two live sources, kept apart because they mean different things:

  {schema}.gauge_levels  PEGELONLINE water levels (WSV), banded against the
                         station's own MHW: an official characteristic value.
  {schema}.eu_watch      Open-Meteo GloFAS discharge at 11 river points outside
                         Germany, banded against the series itself (7-day
                         forecast max vs 2x the exact past-30-day median): a model band,
                         not an official warning.

watch_target() reads place and river words from the question (or the user's
selection) and returns the stations and points it names. A city wins over a
river: "the Elbe in Dresden" is the DRESDEN gauge, "the Danube" is every
Danube gauge and point. The Rhine and Mosel stay on the EMSR517 live gauge
path (investigator._rhine_live); is_watch_only() says when a target needs this
path instead.

STATIONS mirrors ingestion/feeds/pegel_poll.py STATIONS (a test keeps them
equal). The point ids are migration 064's.
"""

from __future__ import annotations

import re

# (shortname, water) as PEGELONLINE returns them, in pegel_poll.py order.
STATIONS: tuple[tuple[str, str], ...] = (
    ("MAXAU", "RHEIN"),
    ("MAINZ", "RHEIN"),
    ("KAUB", "RHEIN"),
    ("KOBLENZ", "RHEIN"),
    ("ANDERNACH", "RHEIN"),
    ("BONN", "RHEIN"),
    ("KÖLN", "RHEIN"),
    ("DÜSSELDORF", "RHEIN"),
    ("EMMERICH", "RHEIN"),
    ("Trier UP", "MOSEL"),
    ("Cochem", "MOSEL"),
    ("Fremersdorf", "SAAR"),
    ("FRANKFURT OSTHAFEN", "MAIN"),
    ("WÜRZBURG", "MAIN"),
    ("Heidelberg UP", "NECKAR"),
    ("Lauffen", "NECKAR"),
    ("DRESDEN", "ELBE"),
    ("MAGDEBURG-STROMBRÜCKE", "ELBE"),
    ("WITTENBERGE", "ELBE"),
    ("REGENSBURG EISERNE BRÜCKE", "DONAU"),
    ("PASSAU DONAU", "DONAU"),
    ("FRANKFURT1 (ODER)", "ODER"),
    ("HOHENSAATEN-FINOW", "ODER"),
    ("HANN.MUENDEN", "WESER"),
    ("PORTA", "WESER"),
    ("RHEINE UNTERSCHLEUSE", "EMS"),
)
# Waters the EMSR517 live gauge path already answers.
RHINE_WATERS: tuple[str, ...] = ("RHEIN", "MOSEL")

# (point_id, city, country, river, lat, lon) as in migrations 063-065. Seville was dropped:
# its best GloFAS cell carries ~17 m3/s against ~160 m3/s long-term at the city.
EU_POINTS: tuple[tuple[str, str, str, str, float, float], ...] = (
    ("EU01", "Paris", "FR", "Seine", 48.925, 2.275),
    ("EU02", "Lyon", "FR", "Rhone", 45.775, 4.825),
    ("EU03", "Orleans", "FR", "Loire", 47.875, 1.875),
    ("EU04", "Piacenza", "IT", "Po", 45.075, 9.625),
    ("EU05", "Zaragoza", "ES", "Ebro", 41.625, -0.825),
    ("EU06", "Warsaw", "PL", "Vistula", 52.275, 20.975),
    ("EU07", "Vienna", "AT", "Danube", 48.175, 16.475),
    ("EU08", "Budapest", "HU", "Danube", 47.475, 19.025),
    ("EU09", "Szeged", "HU", "Tisza", 46.275, 20.125),
    ("EU10", "Liege", "BE", "Meuse", 50.675, 5.625),
    ("EU11", "Prague", "CZ", "Vltava", 50.125, 14.375),
)
EU_POINT_IDS: tuple[str, ...] = tuple(p[0] for p in EU_POINTS)

# City words -> station shortnames or EU point ids. Case-insensitive, full words.
_CITY: dict[str, tuple[str, ...]] = {
    "Maxau": ("MAXAU",),
    "Karlsruhe": ("MAXAU",),
    "Mainz": ("MAINZ",),
    "Kaub": ("KAUB",),
    "Koblenz": ("KOBLENZ",),
    "Andernach": ("ANDERNACH",),
    "Bonn": ("BONN",),
    "Köln": ("KÖLN",),
    "Koeln": ("KÖLN",),
    "Cologne": ("KÖLN",),
    "Düsseldorf": ("DÜSSELDORF",),
    "Duesseldorf": ("DÜSSELDORF",),
    "Dusseldorf": ("DÜSSELDORF",),
    "Emmerich": ("EMMERICH",),
    "Trier": ("Trier UP",),
    "Cochem": ("Cochem",),
    "Fremersdorf": ("Fremersdorf",),
    "Würzburg": ("WÜRZBURG",),
    "Wuerzburg": ("WÜRZBURG",),
    "Wurzburg": ("WÜRZBURG",),
    "Heidelberg": ("Heidelberg UP",),
    "Lauffen": ("Lauffen",),
    "Dresden": ("DRESDEN",),
    "Magdeburg": ("MAGDEBURG-STROMBRÜCKE",),
    "Wittenberge": ("WITTENBERGE",),
    "Regensburg": ("REGENSBURG EISERNE BRÜCKE",),
    "Passau": ("PASSAU DONAU",),
    "Hohensaaten": ("HOHENSAATEN-FINOW",),
    "Hann. Münden": ("HANN.MUENDEN",),
    "Hann. Muenden": ("HANN.MUENDEN",),
    "Hannoversch Münden": ("HANN.MUENDEN",),
    "Porta Westfalica": ("PORTA",),
    "Rheine": ("RHEINE UNTERSCHLEUSE",),
    # Frankfurt alone is Frankfurt am Main; the Oder town is named with the river.
    "Frankfurt (Oder)": ("FRANKFURT1 (ODER)",),
    "Frankfurt an der Oder": ("FRANKFURT1 (ODER)",),
    "Frankfurt/Oder": ("FRANKFURT1 (ODER)",),
    "Frankfurt": ("FRANKFURT OSTHAFEN",),
    "Paris": ("EU01",),
    "Lyon": ("EU02",),
    "Orléans": ("EU03",),
    "Orleans": ("EU03",),
    "Piacenza": ("EU04",),
    "Zaragoza": ("EU05",),
    "Saragossa": ("EU05",),
    "Warsaw": ("EU06",),
    "Warszawa": ("EU06",),
    "Warschau": ("EU06",),
    "Vienna": ("EU07",),
    "Wien": ("EU07",),
    "Budapest": ("EU08",),
    "Szeged": ("EU09",),
    "Liège": ("EU10",),
    "Liege": ("EU10",),
    "Lüttich": ("EU10",),
    "Prague": ("EU11",),
    "Praha": ("EU11",),
    "Prag": ("EU11",),
}
# River words -> (PEGELONLINE waters, EU rivers). Ambiguous words ("Main",
# "Ems", "Oder" = German "or", "Po") only count capitalised.
_RIVER: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "Rhine": (("RHEIN",), ()),
    "Rhein": (("RHEIN",), ()),
    "Mosel": (("MOSEL",), ()),
    "Moselle": (("MOSEL",), ()),
    "Saar": (("SAAR",), ()),
    "Neckar": (("NECKAR",), ()),
    "Elbe": (("ELBE",), ()),
    "Danube": (("DONAU",), ("Danube",)),
    "Donau": (("DONAU",), ("Danube",)),
    "Duna": ((), ("Danube",)),
    "Weser": (("WESER",), ()),
    "Seine": ((), ("Seine",)),
    "Rhône": ((), ("Rhone",)),
    "Rhone": ((), ("Rhone",)),
    "Loire": ((), ("Loire",)),
    "Ebro": ((), ("Ebro",)),
    "Vistula": ((), ("Vistula",)),
    "Wisła": ((), ("Vistula",)),
    "Weichsel": ((), ("Vistula",)),
    "Tisza": ((), ("Tisza",)),
    "Theiss": ((), ("Tisza",)),
    "Meuse": ((), ("Meuse",)),
    "Maas": ((), ("Meuse",)),
    "Vltava": ((), ("Vltava",)),
    "Moldau": ((), ("Vltava",)),
}
_RIVER_CASED: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "Main": (("MAIN",), ()),
    "Ems": (("EMS",), ()),
    "Oder": (("ODER",), ()),
    "Po": ((), ("Po",)),
}


def _alt(words) -> re.Pattern[str]:
    alts = sorted(words, key=len, reverse=True)
    return re.compile(r"(?<!\w)(?:" + "|".join(re.escape(w) for w in alts) + r")(?!\w)")


_CITY_RE = re.compile(_alt(_CITY).pattern, re.IGNORECASE | re.UNICODE)
_RIVER_RE = re.compile(_alt(_RIVER).pattern, re.IGNORECASE | re.UNICODE)
# "Main", "Oder", "Ems", "Po" are also ordinary words ("Main roads", "Oder doch",
# "Ems?"). They count only beside a river word: "river Main", "am Main",
# "an der Oder", "Main at Frankfurt", "Oder river".
_CASED = "|".join(_RIVER_CASED)
_RIVER_CASED_RE = re.compile(
    rf"(?:(?i:\b(?:river|fluss|am|an der)\s+)(?P<a>{_CASED})\b)"
    rf"|(?:\b(?P<b>{_CASED})(?i:\s+(?:river|fluss|at)\b))"
)
_CITY_KEYS = {k.lower(): v for k, v in _CITY.items()}
_RIVER_KEYS = {k.lower(): v for k, v in _RIVER.items()}
_STATION_WATER = dict(STATIONS)
_STATION_KEYS = {s.upper(): s for s, _ in STATIONS}


def _target(stations: list[str], points: list[str], word: str) -> dict:
    return {
        "stations": list(dict.fromkeys(stations)),
        "points": list(dict.fromkeys(points)),
        "word": word,
    }


def watch_target(question: str, context: dict | None = None) -> dict | None:
    """{"stations": [...], "points": [...], "word": ...} the question names, else None.

    Cities first (every city named), then rivers. With neither, the user's
    selection: context watch_point (an EU id) or station (a PEGELONLINE name).
    """
    text = question or ""
    stations: list[str] = []
    points: list[str] = []
    words: list[str] = []
    for m in _CITY_RE.finditer(text):
        for ident in _CITY_KEYS[m.group(0).lower()]:
            (points if ident in EU_POINT_IDS else stations).append(ident)
        words.append(m.group(0))
    # Longest alternative first, so "Frankfurt (Oder)" never also reads as "Frankfurt".
    if stations or points:
        return _target(stations, points, ", ".join(words))
    hits = [(m.group(0), _RIVER_KEYS[m.group(0).lower()]) for m in _RIVER_RE.finditer(text)]
    for m in _RIVER_CASED_RE.finditer(text):
        word = m.group("a") or m.group("b")
        hits.append((word, _RIVER_CASED[word]))
    for word, (waters, rivers) in hits:
        stations += [s for s, w in STATIONS if w in waters]
        points += [p[0] for p in EU_POINTS if p[3] in rivers]
        words.append(word)
    if stations or points:
        return _target(stations, points, ", ".join(words))
    ctx = context or {}
    if ctx.get("watch_point") in EU_POINT_IDS:
        return _target([], [ctx["watch_point"]], f"selected {ctx['watch_point']}")
    picked = _STATION_KEYS.get(str(ctx.get("station") or "").upper())
    if picked and _STATION_WATER[picked] not in RHINE_WATERS:
        return _target([picked], [], f"selected {picked}")
    return None


def is_watch_only(target: dict | None) -> bool:
    """True when the target needs the watch path: an EU point, or a gauge off the Rhine/Mosel."""
    if not target:
        return False
    if target["points"]:
        return True
    return any(_STATION_WATER.get(s) not in RHINE_WATERS for s in target["stations"])


# A watch question must ask about the present. Live cue: always live. A level or
# discharge word: live unless the question also points at the past.
_LIVE_CUE = re.compile(
    r"\b(?:right now|now|currently|current|today|tonight|tomorrow|at the moment|rising|"
    r"next (?:few )?\d* ?(?:h|hours?|days?)|coming (?:hours?|days?)|"
    # Forward-looking cues (the forecast lane, router.py): still a present question.
    r"this week|forecasts?|outlook|will\b[^?.!]{0,40}\b(?:rise|flood)|look (?:safe|ok)|"
    r"heute|jetzt|aktuell|derzeit|ahora|hoy|actualmente)\b",
    re.IGNORECASE | re.UNICODE,
)
_LEVEL_WORD = re.compile(
    r"\b(?:levels?|water levels?|discharge|flow|gauges?|risk|pegel|wasserstand|abfluss|"
    r"caudal|nivel)\b",
    re.IGNORECASE | re.UNICODE,
)
_PAST_CUE = re.compile(
    r"\b(?:was|did|were|happened|affected|flood of|floods of|hit|last (?:year|month|week)|"
    r"(?:19|20)\d{2}|january|february|march|april|may|june|july|august|september|october|"
    r"november|december|januar|februar|märz|juni|juli|oktober|dezember|enero|julio|octubre|"
    r"war|waren|wurde|fue|emsr\d*)\b",
    re.IGNORECASE | re.UNICODE,
)


def has_watch_cue(question: str) -> bool:
    """A live cue, or a level/discharge word with no past cue."""
    q = question or ""
    if _LIVE_CUE.search(q):
        return True
    return bool(_LEVEL_WORD.search(q)) and not _PAST_CUE.search(q)


def all_sources() -> dict:
    """Every model point and every gauge off the Rhine/Mosel: a watch run that names nothing."""
    return _target(
        [s for s, w in STATIONS if w not in RHINE_WATERS], list(EU_POINT_IDS), "all watch sources"
    )


def place_words() -> tuple[str, ...]:
    """Every city and river word the watch reads, for the LIVE-EU scope vocabulary."""
    return (*_CITY, *_RIVER, *_RIVER_CASED)


def sql_list(values) -> str:
    return ", ".join("'" + str(v).replace("'", "''") + "'" for v in values)


# The 45 watched places of the forecast lane, in the request order of migration 070
# (location_id 0..44; Open-Meteo omits location_id for the first point). The view
# floodsense.weather_forecast (071) carries the same ids, ASCII names and positions;
# a test keeps this tuple and the migrations equal.
#   (point_id, kind, ref, ascii name, river or area, lat, lon)
# gauge: ref is the PEGELONLINE shortname (gauge_levels.station); position from
#        gauge_levels (PEGELONLINE station metadata), rounded to 4 decimals.
# eu: ref is the eu_watch point id, position the 063 GloFAS cell.
# valencia: ref is the warehouse point id; ingestion/prep/valencia_points.csv.
_GAUGE_POS: dict[str, tuple[str, float, float]] = {
    "MAXAU": ("MAXAU", 49.039, 8.3056),
    "MAINZ": ("MAINZ", 50.004, 8.2753),
    "KAUB": ("KAUB", 50.0854, 7.765),
    "KOBLENZ": ("KOBLENZ", 50.3586, 7.6047),
    "ANDERNACH": ("ANDERNACH", 50.4434, 7.3921),
    "BONN": ("BONN", 50.7364, 7.108),
    "KÖLN": ("KOELN", 50.9369, 6.9633),
    "DÜSSELDORF": ("DUESSELDORF", 51.2255, 6.7699),
    "EMMERICH": ("EMMERICH", 51.8293, 6.2456),
    "Trier UP": ("Trier UP", 49.7322, 6.6269),
    "Cochem": ("Cochem", 50.1445, 7.1677),
    "Fremersdorf": ("Fremersdorf", 49.4089, 6.6484),
    "FRANKFURT OSTHAFEN": ("FRANKFURT OSTHAFEN", 50.1057, 8.715),
    "WÜRZBURG": ("WUERZBURG", 49.7962, 9.926),
    "Heidelberg UP": ("Heidelberg UP", 49.4147, 8.7177),
    "Lauffen": ("Lauffen", 49.0723, 9.1598),
    "DRESDEN": ("DRESDEN", 51.0545, 13.7388),
    "MAGDEBURG-STROMBRÜCKE": ("MAGDEBURG-STROMBRUECKE", 52.1297, 11.6443),
    "WITTENBERGE": ("WITTENBERGE", 52.9855, 11.7594),
    "REGENSBURG EISERNE BRÜCKE": ("REGENSBURG EISERNE BRUECKE", 49.0214, 12.1018),
    "PASSAU DONAU": ("PASSAU DONAU", 48.5761, 13.4591),
    "FRANKFURT1 (ODER)": ("FRANKFURT1 (ODER)", 52.3578, 14.5517),
    "HOHENSAATEN-FINOW": ("HOHENSAATEN-FINOW", 52.8647, 14.1411),
    "HANN.MUENDEN": ("HANN.MUENDEN", 51.4258, 9.6409),
    "PORTA": ("PORTA", 52.2487, 8.922),
    "RHEINE UNTERSCHLEUSE": ("RHEINE UNTERSCHLEUSE", 52.288, 7.4341),
}
# (point_id, ASCII municipality, area from the csv's `why` column, lat, lon)
_VALENCIA_POS: tuple[tuple[str, str, str, float, float], ...] = (
    ("VAL01", "Paiporta", "Barranc del Poyo", 39.4278, -0.4172),
    ("VAL02", "Catarroja", "Horta Sud", 39.4019, -0.4036),
    ("VAL03", "Sedavi", "Horta Sud", 39.4267, -0.3836),
    ("VAL04", "Alfafar", "Horta Sud", 39.4181, -0.3792),
    ("VAL05", "Benetusser", "Horta Sud", 39.4244, -0.3969),
    ("VAL06", "Algemesi", "Jucar", 39.1906, -0.4367),
    ("VAL07", "Chiva", "Barranc del Poyo", 39.4694, -0.7186),
    ("VAL08", "Utiel", "Plana de Utiel", 39.5683, -1.2056),
)

ForecastPoint = tuple[str, str, str, str, str, float, float]
FORECAST_POINTS: tuple[ForecastPoint, ...] = (
    *(
        (f"PEG{n:02d}", "gauge", station, _GAUGE_POS[station][0], water, *_GAUGE_POS[station][1:])
        for n, (station, water) in enumerate(STATIONS, start=1)
    ),
    *((p[0], "eu", p[0], p[1], p[3], p[4], p[5]) for p in EU_POINTS),
    *((pid, "valencia", pid, name, area, lat, lon) for pid, name, area, lat, lon in _VALENCIA_POS),
)
FORECAST_BY_REF: dict[str, ForecastPoint] = {p[2]: p for p in FORECAST_POINTS}
FORECAST_BY_ID: dict[str, ForecastPoint] = {p[0]: p for p in FORECAST_POINTS}
