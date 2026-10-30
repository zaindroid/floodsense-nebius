"""Demo seed: approved findings in H-MEM and two warmed answers in Redis.

In real use the system starts empty: memory fills when an analyst approves a
run, and the cache fills when an approved, Judge-passed run is asked again.
For a recorded demo this module fills both ahead of time, and labels all of it.

    python tasks.py demo-seed        # runs `python -m app.demo_seed seed` in the api container
    python tasks.py demo-reset       # removes what seed put in Redis

Memory. Each seed is sent to the engines' POST /hmem/store, the endpoint the
agents call on approval (agents/floodsense_agents/engines.py, store()). The
reviewer is "demo-seed", the run ids start with "demo-seed-", and every claim
carries the entity "demo-seed", so the stored provenance reads "run
demo-seed-... approved by demo-seed" and GET /system flags it seeded. The
texts are copied from a recorded run (ui/src/fixtures/run_f16733274f1c.json)
with their citations, and the Ahr one is written from the floodsense_seed rows
in ui/src/fixtures/ahr_2021.json in the agents' own wording. The engines key a
memory by (run_id, claim_id), so seeding twice writes nothing twice. H-MEM has
no delete route; demo-reset says how to drop the engines volume instead.

Cache. Two real runs already in the agents that a person approved and the
Judge passed are written to Redis through app/cache.py: AnswerCache.remember
(the cache entry, floodsense:cache:v1:) and AnswerCache.record (the 30-day
recording, floodsense:replay:v1:). Asking one of those questions again is then
answered "Cached answer from HH:MM · not live · original run R". Nothing is
invented: with no such run, seed says so and warms nothing. A marker key
floodsense:demo:v1:seeded lists the warmed runs for /system.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

import httpx

from app.cache import (
    CACHE_PREFIX,
    DEMO_SEED_KEY,
    REPLAY_PREFIX,
    AnswerCache,
    Entry,
    _slot,
    approved_by_a_person,
    ask_of,
    canonical_event,
    finished_well,
    fingerprint,
    is_follow_up,
    key_of,
)

REVIEWER = "demo-seed"
NOTE = "seeded for demo"
WARM_RUNS = 2
TIMEOUT = httpx.Timeout(10.0, connect=3.0)

_VAL_Q = (
    "Why was Paiporta exposed on 29 Oct 2024, and what does the Copernicus delineation "
    "and the literature say about the Barranc del Poyo?"
)


def _cite(cid: str, claim: str, title: str, query_id: str | None, **extra: Any) -> dict[str, Any]:
    return {"citation_id": cid, "claim_id": claim, "layer": "a", "title": title, "query_id": query_id, **extra}


# Copied from ui/src/fixtures/run_f16733274f1c.json (claims C3 to C6, citations kept)
# and, for the Ahr, from the floodsense_seed rows in ui/src/fixtures/ahr_2021.json.
SEEDS: list[dict[str, Any]] = [
    {
        "run_id": "demo-seed-valencia-paiporta",
        "event_id": "EMSR773",
        "question": _VAL_Q,
        "claims": [
            {
                "claim_id": "C3",
                "text": (
                    "Daily discharge for Paiporta (VAL01) (open-meteo-flood-glofas) was 467.81 m3/s "
                    "on 2024-10-30, up from 23.38 m3/s on 2024-10-28."
                ),
                "hypothesis_id": "H2",
                "entities": ["Paiporta", "Barranc del Poyo", "VAL01", REVIEWER],
                "citations": [
                    _cite("C3-a1", "C3", "floodsense.discharge_daily", "1223e572-6676-4b30-bad6-15c20cbb70e0")
                ],
            },
            {
                "claim_id": "C4",
                "text": "The Copernicus EMS footprint (EMSR773) covers 91 insured sites across 2 segments.",
                "hypothesis_id": "H3",
                "entities": ["Paiporta", "Horta Sud", "EMSR773", REVIEWER],
                "citations": [
                    _cite("C4-a1", "C4", "floodsense.exposure_join", "a23655ae-5c1a-4876-8a93-d942e3a12735")
                ],
            },
        ],
    },
    {
        "run_id": "demo-seed-valencia-exposure",
        "event_id": "EMSR773",
        "question": "How many of our policies are inside the Copernicus footprint?",
        "claims": [
            {
                "claim_id": "C5",
                "text": (
                    "91 policies sit inside the mapped footprint, sum insured 313,166,000 EUR; "
                    "the largest is SYN-00034 (industrial, 10,900,000 EUR)."
                ),
                "hypothesis_id": "H4",
                "entities": ["Paiporta", "Barranc del Poyo", "EMSR773", REVIEWER],
                "citations": [
                    _cite("C5-a1", "C5", "floodsense.exposure_join", "db656b44-29e8-4b3f-91fb-38f8405604e9")
                ],
            },
            {
                "claim_id": "C6",
                "text": "The most exposed segment is industrial: 30 policies, 161,701,000 EUR sum insured.",
                "hypothesis_id": "H4",
                "entities": ["Paiporta", "EMSR773", REVIEWER],
                "citations": [
                    _cite("C6-a1", "C6", "floodsense.exposure_join", "18111c22-1483-4ce9-a351-7652ba9f9d99")
                ],
            },
        ],
    },
    {
        "run_id": "demo-seed-ahr-altenahr",
        "event_id": "EMSR517",
        # Not an eval question (ahr-03 asks "What discharge did the Altenahr gauge reach?").
        "question": "How high did the Ahr run at Altenahr in July 2021?",
        "claims": [
            {
                "claim_id": "C2",
                "text": (
                    "Daily discharge for Altenahr (AHR01) (open-meteo-flood-glofas) was 249.61 m3/s "
                    "on 2021-07-14, up from 6.91 m3/s on 2021-07-12."
                ),
                "hypothesis_id": "H2",
                "entities": ["Altenahr", "Ahr", "AHR01", "EMSR517", REVIEWER],
                "citations": [
                    _cite(
                        "C2-a1",
                        "C2",
                        "floodsense_seed.discharge_daily",
                        None,
                        publisher="Open-Meteo (GloFAS v4 reanalysis)",
                        licence="CC-BY-4.0",
                        attribution="Open-Meteo.com, modelled, not gauge readings",
                    )
                ],
            },
        ],
    },
]


# River history. Findings paraphrased from the layer (c) Wikipedia snapshots in
# corpus/pdf/wiki-*.html (CC BY-SA 4.0, see docs/legal/sources.md). Each one names
# its doc_id, section and paragraph as rag_ingest numbers them (section = `page`,
# paragraph = `paragraph` in rag.chunks) and the revision URL. Every number in a
# finding appears in that paragraph; api/tests/test_demo_seed_history.py checks it.
# The watch runs carry event LIVE-EU and the engines keep a recall to that event's
# tag, so these seeds use LIVE-EU; Valencia's use EMSR773, its replay event.
HISTORY_URLS: dict[str, str] = {
    "wiki-1997-central-european-flood": "https://en.wikipedia.org/w/index.php?title=1997_Central_European_flood&oldid=1368946079",
    "wiki-2002-european-floods": "https://en.wikipedia.org/w/index.php?title=2002_European_floods&oldid=1374296101",
    "wiki-2010-central-european-floods": "https://en.wikipedia.org/w/index.php?title=2010_Central_European_floods&oldid=1359816549",
    "wiki-2013-european-floods": "https://en.wikipedia.org/w/index.php?title=2013_European_floods&oldid=1372735297",
    "wiki-2016-european-floods": "https://en.wikipedia.org/w/index.php?title=2016_European_floods&oldid=1360455033",
    "wiki-2021-european-floods": "https://en.wikipedia.org/w/index.php?title=2021_European_floods&oldid=1375935659",
    "wiki-2024-central-european-floods": "https://en.wikipedia.org/w/index.php?title=2024_Central_European_floods&oldid=1377676053",
    "wiki-2024-spanish-floods": "https://en.wikipedia.org/w/index.php?title=2024_Spanish_floods&oldid=1379732613",
    "wiki-seine": "https://en.wikipedia.org/w/index.php?title=Seine&oldid=1381786474",
    "wiki-moselle": "https://en.wikipedia.org/w/index.php?title=Moselle&oldid=1374522670",
    "wiki-neckar": "https://en.wikipedia.org/w/index.php?title=Neckar&oldid=1381972636",
    "wiki-flood-control-netherlands": "https://en.wikipedia.org/w/index.php?title=Flood_control_in_the_Netherlands&oldid=1369449074",
    "wiki-list-of-floods": "https://en.wikipedia.org/w/index.php?title=List_of_floods&oldid=1380945599",
}

_ELBE = ["Elbe", "ELBE", "Dresden", "Magdeburg", "Wittenberge"]
_DANUBE = ["Danube", "Donau", "Regensburg", "Passau", "Vienna", "Budapest"]
_ODER = ["Oder", "Odra", "Frankfurt (Oder)", "Hohensaaten", "Wroclaw"]
_VISTULA = ["Vistula", "Wisla", "Warsaw", "Krakow"]
_VLTAVA = ["Vltava", "Moldau", "Prague"]
_RHINE = ["Rhine", "Rhein", "Cologne", "Koeln", "Bonn", "Koblenz", "Mainz"]
_MOSEL = ["Mosel", "Moselle", "Trier", "Cochem"]
_MAIN = ["Main", "Frankfurt", "Wuerzburg"]
_NECKAR = ["Neckar", "Heidelberg", "Lauffen"]
_WESER = ["Weser", "Hann. Muenden", "Porta"]
_SEINE = ["Seine", "Paris"]
_LOIRE = ["Loire", "Orleans"]
_PO = ["Po", "Piacenza"]
_MEUSE = ["Meuse", "Maas", "Liege"]
_VALENCIA = ["Valencia", "Barranc del Poyo", "Poyo", "Paiporta"]

# (run slug, event_id, question, [(doc_id, section, paragraph, entities, finding)])
HISTORY: list[tuple[str, str, str, list[tuple[str, int, int, list[str], str]]]] = [
    ("elbe", "LIVE-EU", "What past floods hit the Elbe, and what weather caused them?", [
        ("wiki-2002-european-floods", 3, 8, _ELBE,
         "Elbe at Dresden, August 2002 flood: the Elbe reached an all-time high of 9.4 m and more than 30,000 people were evacuated."),
        ("wiki-2002-european-floods", 2, 1, _ELBE + _VLTAVA + _DANUBE,
         "Elbe, Vltava and Danube, August 2002: the flooding came from two Genoa lows (Hanne and Ilse) that carried warm, moist Mediterranean air north."),
        ("wiki-2013-european-floods", 2, 7, _ELBE + _DANUBE,
         "Elbe, June 2013: water levels on the Elbe and Danube exceeded 2002 in many places; Dresden's old town was largely spared, but Magdeburg reached a record level."),
        ("wiki-2013-european-floods", 4, 5, _ELBE,
         "Elbe at Magdeburg, June 2013: with water five metres above normal, about 23,000 residents had to leave their homes on 9 June."),
        ("wiki-2013-european-floods", 2, 5, _ELBE + _DANUBE,
         "Elbe and Danube basins, 2013 trigger: 150 to 200 mm of rain, in places around 250 mm, fell from 30 May to 1 June on already saturated soils."),
    ]),
    ("danube", "LIVE-EU", "What past floods hit the Danube, and what weather caused them?", [
        ("wiki-2013-european-floods", 5, 1, _DANUBE,
         "Danube at Passau, 1 June 2013: the water level reached 12.85 m, above the highest recorded historic flood level."),
        ("wiki-2013-european-floods", 5, 5, _DANUBE,
         "Danube, June 2013: the river peaked at 10,530 m3/s in Bratislava, the highest flow ever recorded there, while Budapest prepared for the crest."),
        ("wiki-2024-central-european-floods", 1, 2, _DANUBE + _ODER + _VLTAVA + _VISTULA,
         "Storm Boris, September 2024: an extremely humid Genoa low brought record rain; the floods caused 28 deaths and about 4.2 billion euros of damage, of which about 1.9 billion euros were insured."),
        ("wiki-2024-central-european-floods", 2, 1, _DANUBE,
         "Danube at Vienna, September 2024 (Storm Boris): the Danube was kept under control but the Wien partly overflowed; Lower Austria, on the Danube, Kamp and Traisen, was hit hardest."),
        ("wiki-2024-central-european-floods", 2, 21, _DANUBE,
         "Danube at Budapest, 21 September 2024: the river reached its highest level in around a decade, with water at the steps of the Parliament building."),
    ]),
    ("oder", "LIVE-EU", "What past floods hit the Oder, and what weather caused them?", [
        ("wiki-1997-central-european-flood", 2, 1, _ODER,
         "Oder, July 1997 flood: two spells of rain (3-10 July and 17-22 July) came from a Genoa low that stalled over southern Poland under a blocking high."),
        ("wiki-1997-central-european-flood", 2, 2, _ODER,
         "Oder, July 1997: 300-600 mm of rain fell in a few days and water levels rose 2-3 m above previous records; it was dubbed the Millennium Flood."),
        ("wiki-1997-central-european-flood", 5, 1, _ODER,
         "Oder, July 1997: 114 people died (56 in Poland, 50 in the Czech Republic) and damage was estimated at 4.5 billion US dollars."),
        ("wiki-1997-central-european-flood", 3, 1, _ODER,
         "Oder, July 1997: the flood wave reached Opole on 10 July and Wroclaw on 12 July, then slowed before the Polish-German border, which allowed more time to prepare."),
        ("wiki-2024-central-european-floods", 2, 8, _ODER,
         "Oder basin, September 2024 (Storm Boris): some places in south-western Poland saw more than 400 mm of rain in three days; severe flood alerts were reached at 82 measuring stations, mostly in the Oder basin."),
        ("wiki-2010-central-european-floods", 2, 4, _ODER,
         "Oder at Wroclaw, May 2010: the river reached 665 cm at Trestno on 22 May and the city declared a flood alert."),
    ]),
    ("vistula", "LIVE-EU", "What past floods hit the Vistula, and what weather caused them?", [
        ("wiki-2010-central-european-floods", 2, 2, _VISTULA,
         "Vistula, May 2010: two months' worth of rain fell in 24 hours; high water closed two Krakow bridges on 18 May."),
        ("wiki-2010-central-european-floods", 2, 3, _VISTULA,
         "Vistula, May 2010: the river broke its banks on 20 May; the flood was considered more severe than that of 1997."),
        ("wiki-2010-central-european-floods", 2, 10, _VISTULA,
         "Vistula at Sandomierz, June 2010: the river reached 770 cm, over 100 cm past the alarm level."),
        ("wiki-2010-central-european-floods", 2, 1, _VISTULA,
         "Poland, 2010 floods: at least 25 deaths, about 23,000 people evacuated and an estimated 2.5 billion euros of economic cost."),
        ("wiki-2010-central-european-floods", 2, 5, _VISTULA,
         "Vistula near Plock, 23 May 2010: the river broke a retaining wall at Swiniary; around 4,000 people and 5,000 animals were evacuated."),
    ]),
    ("vltava", "LIVE-EU", "What past floods hit the Vltava in Prague, and what weather caused them?", [
        ("wiki-2002-european-floods", 3, 2, _VLTAVA,
         "Vltava at Prague, August 2002: the flow culminated at 5300 m3/s, 20% more than in the flood of 1845."),
        ("wiki-2002-european-floods", 3, 5, _VLTAVA,
         "Prague, August 2002: an estimated 40,000 people were evacuated before the worst of the flooding."),
        ("wiki-2013-european-floods", 4, 2, _VLTAVA,
         "Vltava at Prague, 3 June 2013: the river flowed at 3,200 m3/s, against almost 5,000 m3/s in 2002."),
        ("wiki-2013-european-floods", 4, 3, _VLTAVA,
         "Czech Republic, June 2013: more than 19,000 people were evacuated (as of 5 June 2013) and a state of emergency covered seven regions including Prague."),
        ("wiki-2002-european-floods", 2, 2, _VLTAVA + _ELBE,
         "Vltava and upper Elbe, August 2002: when the rain moved north-east to the Bohemian Forest and the sources of the Elbe and Vltava, water levels became catastrophic."),
    ]),
    ("rhine", "LIVE-EU", "What past floods hit the Rhine, and what weather caused them?", [
        ("wiki-flood-control-netherlands", 4, 5, _RHINE + _MEUSE,
         "Lower Rhine and Meuse, 1993 and 1995: in the 1995 flood threat over 200,000 people in the Netherlands had to be evacuated and the dikes only just held."),
        ("wiki-2021-european-floods", 2, 1, _RHINE,
         "Rhine region, 12-15 July 2021: a stalled storm complex gave 100 to 150 mm in 24 hours in southern North Rhine-Westphalia and northern Rhineland-Palatinate; Cologne observed 154 mm in 24 hours."),
        ("wiki-2013-european-floods", 6, 1, _RHINE + _MAIN + _NECKAR,
         "Rhine, Main and Neckar, June 2013: flood damage in the Rhine watershed was less severe, but shipping was halted on long stretches of all three rivers."),
        ("wiki-list-of-floods", 2, 3, _RHINE + _MOSEL + _MAIN + _WESER + _DANUBE + _ELBE,
         "St. Mary Magdalene's flood (around 25 July): a Genoa low flooded the Rhine, Moselle, Main, Danube, Weser, Elbe and Vltava; Cologne, Mainz, Frankfurt am Main and Wuerzburg were seriously damaged and about 6000 died in the Danube area alone."),
        ("wiki-2016-european-floods", 2, 5, _RHINE,
         "Rhine near Bonn, 4 June 2016: tributaries of the Rhine flooded around Bonn during the late-May and early-June heavy rain."),
    ]),
    ("mosel", "LIVE-EU", "What past floods hit the Mosel at Trier, and how high did it rise?", [
        ("wiki-moselle", 5, 3, _MOSEL,
         "Mosel at Trier: the highest listed flood level is 11.28 m at the Trier gauge on 21 December 1993."),
        ("wiki-moselle", 5, 5, _MOSEL,
         "Mosel at Trier: the January 1995 flood reached 10.33 m at the Trier gauge on 23 January 1995."),
        ("wiki-moselle", 5, 4, _MOSEL,
         "Mosel at Trier: the May 1983 flood reached 10.56 m at the Trier gauge on 28 May 1983."),
        ("wiki-moselle", 5, 1, _MOSEL,
         "Mosel at Trier, for scale: the highest navigable water level is 6.95 m and the normal level 2.00 m at the Trier gauge."),
        ("wiki-2021-european-floods", 3, 13, _MOSEL,
         "Trier-Saarburg, July 2021: the village of Kordel was cut off and the Kyll rose from an average 1 metre to 7.85 metres."),
    ]),
    ("main", "LIVE-EU", "What past floods hit the Main, and what weather caused them?", [
        ("wiki-list-of-floods", 2, 3, _MAIN,
         "Main, St. Mary Magdalene's flood: after the passage of a Genoa low, Frankfurt am Main and Wuerzburg were among the towns seriously damaged."),
    ]),
    ("neckar", "LIVE-EU", "What past floods hit the Neckar, and what weather caused them?", [
        ("wiki-neckar", 7, 40, _NECKAR,
         "Neckar: the most serious flood in the Neckar area happened in October 1824, estimated as an HQ4000 (a 4000-year return period)."),
        ("wiki-neckar", 7, 38, _NECKAR,
         "Neckar at Plochingen: the large flood of February 1970 destroyed the stone ridge below the gauge."),
        ("wiki-2016-european-floods", 1, 2, _NECKAR + _SEINE,
         "Neckar, late May and early June 2016: after several days of heavy rain, the flooding began at the Neckar and spread to the Danube, Rhine and Seine; at least 21 people died."),
        ("wiki-2016-european-floods", 2, 1, _NECKAR,
         "Baden-Wuerttemberg, 29 May 2016: flash floods on small Kocher tributaries hit Braunsbach hardest; four people died in the state."),
    ]),
    ("seine", "LIVE-EU", "What past floods hit the Seine in Paris, and what weather caused them?", [
        ("wiki-seine", 5, 4, _SEINE,
         "Seine at Paris, January 2018: the river reached 5.84 metres on 29 January after a warning on 24 January that heavy rain was likely to cause flooding."),
        ("wiki-seine", 5, 2, _SEINE,
         "Seine at Paris: after the severe high water of January 1910, the river rose to threatening levels again in 1924, 1955, 1982, 1999-2000, June 2016 and January 2018."),
        ("wiki-list-of-floods", 3, 127, _SEINE,
         "Seine, 1910: three months of heavy rain and snow sent the river to 8.62 m above normal on 28 January; over 20,000 buildings flooded."),
        ("wiki-2016-european-floods", 2, 8, _SEINE + _LOIRE,
         "Seine and Loiret, June 2016: six weeks' worth of rain fell in three days in the Loiret; Paris expected a peak near 6.30 m, above 6.18 m in 1982 but below 7.12 m in 1955 and 8.62 m in 1910."),
        ("wiki-2016-european-floods", 2, 7, _SEINE,
         "Seine, June 2016: the river burst its banks, one town was evacuated and four people died in France."),
    ]),
    ("po", "LIVE-EU", "What past floods hit the Po, and how bad were they?", [
        ("wiki-list-of-floods", 3, 134, _PO,
         "Po delta, 14 November 1951: floods caused 84 casualties and 180,000 people lost their homes."),
        ("wiki-list-of-floods", 3, 140, _PO,
         "Po and Tanaro, 6 November 1994: floods in southern Piedmont caused 70 casualties and 2,226 people lost their homes."),
        ("wiki-list-of-floods", 3, 144, _PO,
         "Po basin, 13 to 16 September 2001: floods in most of the basin left 23 casualties, 11 missing and 40,000 evacuees."),
    ]),
    ("meuse", "LIVE-EU", "What past floods hit the Meuse at Liege, and what weather caused them?", [
        ("wiki-2021-european-floods", 3, 2, _MEUSE,
         "Meuse at Liege, 15 July 2021: all residents of the city (about 200,000) were urged to evacuate as the Meuse threatened to burst its banks."),
        ("wiki-2021-european-floods", 3, 3, _MEUSE,
         "Meuse basin, July 2021 trigger: 271.5 mm of rain fell in 48 hours at Jalhay (province of Liege), a Belgian record, and 217 mm in Spa."),
        ("wiki-2021-european-floods", 3, 23, _MEUSE,
         "Meuse in Dutch Limburg, July 2021: the river reached its highest summer level in over 100 years and was expected to pass the winter records of 1993 and 1995."),
        ("wiki-2021-european-floods", 3, 24, _MEUSE,
         "Meuse (Maas) at Venlo, 16 July 2021: more than 10,000 people were evacuated after over 100 mm of rain in a day and 200 mm in three days."),
        ("wiki-2021-european-floods", 3, 28, _MEUSE + _RHINE,
         "July 2021 trigger: the cut-off low behind the western European floods first moved over the United Kingdom on 12 July."),
    ]),
    ("valencia", "EMSR773", "What caused the October 2024 Valencia floods along the Barranc del Poyo?", [
        ("wiki-2024-spanish-floods", 1, 2, _VALENCIA,
         "Valencia, 29 October 2024: an isolated upper-level low (DANA) brought over a year's precipitation to parts of eastern Spain; about 241 people died."),
        ("wiki-2024-spanish-floods", 4, 3, _VALENCIA,
         "Barranc del Poyo, October 2024 DANA: Turis set a Spanish record of 184.6 mm in one hour, and at 18:30 the Poyo burst its banks in Torrent and flooded Horta Sud."),
        ("wiki-2024-spanish-floods", 4, 5, _VALENCIA,
         "Paiporta, October 2024: 62 people died in this town alone; the Turia diversion built after the 1957 flood protected only Valencia city."),
        ("wiki-2024-spanish-floods", 4, 2, _VALENCIA,
         "Chiva, October 2024 DANA: nearly 500 mm of rain fell during the day and the ravine overflowed at 11:30."),
        ("wiki-2024-spanish-floods", 3, 5, _VALENCIA,
         "Valencia DANA, 2024: climate change made the storm 2 times more likely and its rain 12% heavier."),
    ]),
]


def history_text(doc_id: str, section: int, paragraph: int, finding: str) -> str:
    """The finding with its citation: doc_id, section (rag page), paragraph and URL."""
    return f"{finding} [doc {doc_id}, section {section}, paragraph {paragraph}, {HISTORY_URLS[doc_id]}]"


def history_seeds() -> list[dict[str, Any]]:
    """The river-history seeds in the SEEDS shape. Claim ids are stable, so seeding is idempotent."""
    seeds = []
    for slug, event_id, question, items in HISTORY:
        claims = []
        for n, (doc_id, section, paragraph, entities, finding) in enumerate(items, start=1):
            claims.append(
                {
                    "claim_id": f"H{n}",
                    "text": history_text(doc_id, section, paragraph, finding),
                    "entities": [*dict.fromkeys([*entities, doc_id, REVIEWER])],
                    "citations": [
                        {
                            "citation_id": f"H{n}-c1",
                            "claim_id": f"H{n}",
                            "layer": "c",
                            "doc_id": doc_id,
                            "query_id": None,
                            "source_url": HISTORY_URLS[doc_id],
                            "publisher": "Wikipedia (Wikimedia Foundation)",
                            "licence": "CC-BY-SA-4.0",
                            "locator": {"page": section, "paragraph": paragraph},
                        }
                    ],
                }
            )
        seeds.append(
            {"run_id": f"demo-seed-history-{slug}", "event_id": event_id, "question": question, "claims": claims}
        )
    return seeds


SEEDS.extend(history_seeds())


def _post(client: httpx.Client, path: str, body: dict[str, Any]) -> dict[str, Any]:
    r = client.post(path, json=body)
    r.raise_for_status()
    return r.json()


def seed_memory(engines_url: str, transport: httpx.BaseTransport | None = None) -> int:
    """Store every seed through POST /hmem/store. Returns the number of new memories."""
    new = 0
    with httpx.Client(base_url=engines_url.rstrip("/"), timeout=TIMEOUT, transport=transport) as c:
        for seed in SEEDS:
            body = {
                "run_id": seed["run_id"],
                "question": seed["question"],
                "event_id": seed["event_id"],
                "approval": {"status": "approved", "reviewer": REVIEWER, "reviewer_note": NOTE},
                "claims": seed["claims"],
            }
            report = _post(c, "/hmem/store", body)
            stored = len(report.get("stored") or [])
            again = len(report.get("already_stored") or [])
            new += stored
            print(f"  memory {seed['run_id']} ({seed['event_id']}): {stored} stored, {again} already there")
    return new


def _get(client: httpx.Client, path: str, **params: Any) -> Any:
    r = client.get(path, params=params or None)
    if r.status_code != 200:
        return None
    try:
        body = r.json()
    except ValueError:
        return None
    return body


def pick_runs(rows: list[dict[str, Any]], runs: dict[str, dict[str, Any]], n: int = WARM_RUNS) -> list[str]:
    """Up to n run ids that may be cached: approved by a person, Judge-passed, not a follow-up.

    Newest first, one per event before a second from the same event.
    """
    good = [
        r["run_id"]
        for r in rows
        if isinstance(r, dict)
        and r.get("run_id") in runs
        and finished_well(runs[r["run_id"]])
        and not is_follow_up(runs[r["run_id"]])
    ]
    picked: list[str] = []
    seen: set[str] = set()
    for rid in good:
        ev = canonical_event(runs[rid].get("event_id") or (runs[rid].get("request") or {}).get("event_id"))
        if ev not in seen:
            picked.append(rid)
            seen.add(ev)
    for rid in good:
        if rid not in picked:
            picked.append(rid)
    return picked[:n]


def warm_cache(agents_url: str, cache: AnswerCache, transport: httpx.BaseTransport | None = None) -> list[str]:
    """Cache entry and recording for two approved runs. Returns the warmed run ids."""
    if cache.backend() != "redis":
        print("  cache: Redis is not reachable from here (REDIS_URL unset or down); nothing warmed.")
        print("         Start the cache profile (python tasks.py up-all) and set REDIS_URL in api/.env.")
        return []
    with httpx.Client(base_url=agents_url.rstrip("/"), timeout=TIMEOUT, transport=transport) as c:
        config = _get(c, "/config")
        if not isinstance(config, dict):
            print("  cache: agents GET /config failed; nothing warmed.")
            return []
        flags = fingerprint(config)
        past = _get(c, "/runs/past", limit=200)
        rows = [r for r in ((past or {}).get("runs") or []) if isinstance(r, dict)]
        rows = [r for r in rows if r.get("status") == "approved" and not str(r.get("run_id", "")).startswith(REVIEWER)]
        runs: dict[str, dict[str, Any]] = {}
        for row in rows[:40]:
            run = _get(c, f"/runs/{row['run_id']}")
            if isinstance(run, dict) and approved_by_a_person(run):
                runs[row["run_id"]] = run
        picked = pick_runs(rows, runs)
        if not picked:
            print("  cache: no approved, Judge-passed run in the agents yet; nothing warmed.")
            print("         Ask two questions, approve them on the Approvals page, then seed again.")
            return []
        ttl = cache.settings.recording_ttl_s
        entries: list[dict[str, str]] = []
        slots: list[str] = []
        questions: list[str] = []
        warmed: list[str] = []
        for rid in picked:
            run = runs[rid]
            if not cache.remember(run, flags):
                continue
            # A warmed entry lives as long as the recording (30 days), not the 15 min
            # (live) or 1 day (replay) a cache entry gets, so it survives until recording.
            key = key_of(run.get("request") or {}, flags)
            cache._write_entry(key, Entry(rid, time.time(), ttl), ttl)
            warmed.append(rid)
            cache_key = _slot(CACHE_PREFIX, key)
            slots.append(cache_key)
            entries.append({"run_id": rid, "cache_key": cache_key})
            replay = _get(c, f"/runs/{rid}/replay")
            if isinstance(replay, dict):
                cache.record(replay)
                slots.append(_slot(REPLAY_PREFIX, ask_of(replay)))
            q = str((run.get("request") or {}).get("question") or "")
            questions.append(q)
            print(f"  cache: run {rid} warmed ({canonical_event(run.get('event_id'))}): {q}")
    marker = {
        "run_ids": warmed,
        "entries": entries,
        "ttl_s": cache.settings.recording_ttl_s,
        "questions": questions,
        "keys": slots,
        "seeded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": NOTE,
    }
    if cache._redis is not None:
        cache._redis.set_json(DEMO_SEED_KEY, marker, cache.settings.recording_ttl_s)
    return warmed


def semantic_cache_warning(cache: AnswerCache) -> str | None:
    """The warm hit needs FF_SEMANTIC_CACHE=true on the API. This runs with the API's env."""
    if cache.settings.semantic_cache:
        return None
    return (
        "WARNING: FF_SEMANTIC_CACHE is off for the API. The warmed runs are in Redis, but a repeat "
        "question is answered live (or 429) until FF_SEMANTIC_CACHE=true is set in api/.env and "
        "the api container is recreated."
    )


def reset(cache: AnswerCache) -> int:
    """Delete the Redis keys seed wrote, and the marker. H-MEM keeps its memories."""
    marker = cache.demo_seeded()
    if marker is None:
        print("  cache: no demo-seed marker in Redis; nothing to remove.")
    else:
        keys = [k for k in (marker.get("keys") or []) if isinstance(k, str)]
        if cache._redis is not None:
            cache._redis.delete(*keys, DEMO_SEED_KEY)
        print(f"  cache: removed {len(keys)} warmed keys and the marker.")
    print("  memory: H-MEM has no delete route. To start empty, stop the stack and remove the")
    print("          engines volume: python tasks.py down, then docker volume rm floodsense-app_engines")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m app.demo_seed", description=__doc__.splitlines()[0])
    p.add_argument("action", choices=["seed", "reset"])
    p.add_argument("--engines-url", default=os.environ.get("ENGINES_URL") or "http://engines:8300")
    p.add_argument("--agents-url", default=os.environ.get("AGENTS_URL") or "http://agents:8100")
    p.add_argument("--skip-memory", action="store_true")
    p.add_argument("--skip-cache", action="store_true")
    args = p.parse_args(argv)
    cache = AnswerCache()
    if args.action == "reset":
        return reset(cache)
    print("Demo seed (labelled: reviewer demo-seed, note 'seeded for demo')")
    warning = semantic_cache_warning(cache)
    if warning:
        print(warning)
    code = 0
    if not args.skip_memory:
        try:
            n = seed_memory(args.engines_url)
            print(f"  memory: {n} new memories")
        except httpx.HTTPError as e:
            print(f"  memory: engines not reachable or refused the store ({type(e).__name__})")
            code = 1
    if not args.skip_cache:
        try:
            warm_cache(args.agents_url, cache)
        except httpx.HTTPError as e:
            print(f"  cache: agents not reachable ({type(e).__name__})")
            code = 1
    if warning and not args.skip_cache:
        print(warning)
    print(json.dumps({"done": code == 0}))
    return code


if __name__ == "__main__":
    sys.exit(main())
