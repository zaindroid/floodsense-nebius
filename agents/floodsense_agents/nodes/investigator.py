"""Investigator. Builds the cited causal chain rain -> catchment -> river -> site.

One hypothesis per link, backed by claims. Every claim carries a layer (a)
citation (the Zetaris query_id) and, where the provenance view knows the
dataset, layer (b) citations.

The deterministic path builds the chain from aggregate queries, so the graph
runs without a model. Those queries do not depend on each other, so they run
together. The fast lane, when available, writes the claims and summary from
the same evidence; unknown query_ids are dropped. Repair stays on the deep
lane, in the Playbook.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
import time

from floodsense_agents.engines import memory_origin
from floodsense_agents.events import WATCH_EVENT, hazard_schema, point_label
from floodsense_agents.governance import DEFINITIONS, IN_FOOTPRINT_SQL
from floodsense_agents.live import (
    GAUGE_LIVE_ROWS,
    GAUGE_STALE_H,
    LIVE_ROWS,
    OFFICIAL_NOTE,
    STALE_FORECAST_H,
    gauge_latest_sql,
    gauge_threshold,
    has_gauges,
    hours_between,
    focus,
    is_live,
    points_sql,
    relative,
)
from floodsense_agents.models import Citation, Claim, Evidence, Hypothesis, Locator
from floodsense_agents.nightshift import map_ordered, parse_json
from floodsense_agents.nodes.watchers import last_complete_day, window
from floodsense_agents.prompts import INVESTIGATOR_LINK, compact_rows
from floodsense_agents.provenance import rows_for as provenance_rows
from floodsense_agents.settings import settings
from floodsense_agents.state import Deps, FloodState, add_evidence, trace
from floodsense_agents.tavily import tavily_line, tavily_state
from floodsense_agents.watch import (
    RHINE_WATERS,
    all_sources,
    is_watch_only,
    sql_list,
    watch_target,
)
from floodsense_agents.zetaris import now_utc, run_sql_parallel

log = logging.getLogger("floodsense.investigator")
# 21,600,000 is one number, not 21.6 and 0, and the 3 in "m3/s" is not a
# number at all. The Judge checks whatever comes out of here against the
# cited rows, so a bad split becomes a false mismatch.
_NUM = re.compile(
    r"(?<![A-Za-z\d.,])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?"  # grouped thousands
    r"|(?<![A-Za-z\d.,])-?\d+(?:\.\d+)?"  # plain, including decimals
)
LINKS = ("rain->catchment", "catchment->river", "river->site", "site->exposure")
MEMORY_PROMPT_MAX = 5  # recalled findings shown to the model


def numbers_in(text: str) -> list[float]:
    out = []
    # Timestamps (T or space separated) and relative hours are not numbers to check.
    text = re.sub(r"\d{4}-\d{2}-\d{2}(?:[ T][\d:.]*Z?)?", " ", text)
    text = re.sub(r"\bin \d+ ?h\b|\b\d+ ?h ago\b", " ", text)
    for n in _NUM.findall(text):
        try:
            out.append(float(n.replace(",", "")))
        except ValueError:
            pass
    return out


def _as_number(v) -> float | None:
    """A cell as a float. The REST API returns every value as a string ('72.3')."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.strip())
        except ValueError:
            return None
    return None


def cell_values(evs: list[Evidence]) -> list[float]:
    """Every numeric cell of the cited rows (the values the Judge can match)."""
    out: list[float] = []
    for e in evs:
        for row in e.rows_sample:
            for v in row.values():
                n = _as_number(v)
                if n is not None:
                    out.append(n)
    return out


# "13 Jul 2021", "14 July", "Jul 2021": calendar words, not values to check.
_MONTHS = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?"
_WORD_DATE = re.compile(
    rf"\b(?:\d{{1,2}}(?:[-–]\d{{1,2}})? {_MONTHS}(?: \d{{4}})?|{_MONTHS} \d{{1,2}}(?:, \d{{4}})?"
    rf"|{_MONTHS} \d{{4}})(?!\d)"
)
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}(?:[ T][\d:.]*Z?)?")
# A clock time: "00:00 UTC", "19:11".
_CLOCK = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")
# A number the text names as a line it is compared with: a comparison word, the
# number, its unit, and "line" ("stayed under the 30 mm/h line", "above the 100
# m3/s line", "threshold of 100 m3/s"). "Peaked at the 100 m3/s line" has no
# comparison word, so its 100 is a stated value and stays for the Judge.
_COMPARE = (
    r"(?:under|below|above|over|exceeds?|exceeded|exceeding|reach(?:es|ed)?|"
    r"cross(?:es|ed)?|crossing)"
)
_LINE_UNIT = r"(mm/h|mm|m3/s|m³/s)"
_LINE_NAMED = re.compile(
    rf"\b{_COMPARE}\s+(?:the|a|an)\s+(\d+(?:\.\d+)?)\s*{_LINE_UNIT}\s+(?:anomaly\s+)?"
    rf"(?:line|threshold|mark|limit)\b"
    rf"|\bthreshold\s+of\s+(\d+(?:\.\d+)?)\s*{_LINE_UNIT}",
    re.IGNORECASE,
)


def _unit_key(unit: str) -> str:
    """Definition or text unit -> mm/h, mm, m3/s ('mm per event window' is mm)."""
    u = unit.strip().lower().replace("³", "3")
    if u.startswith("mm/h"):
        return "mm/h"
    if u.startswith("m3/s"):
        return "m3/s"
    if u.startswith("mm"):
        return "mm"
    return u


# A coordinate filter: "lat 50.2-50.7, lon 6.6-7.4", "bbox 50.2, 50.7, ...".
_FILTER_NAMED = re.compile(
    r"\b(?:lat(?:itude)?|lon(?:gitude)?|bbox|bounding box)\b[\s:=]*\(?"
    r"-?\d+(?:\.\d+)?(?:\s*(?:-|–|to|and|,)\s*-?\d+(?:\.\d+)?)*",
    re.IGNORECASE,
)


def date_numbers(text: str) -> list[float]:
    """The day and year figures of the calendar dates a text spells out."""
    return [float(n) for m in _WORD_DATE.findall(text or "") for n in re.findall(r"\d+", m)]


def _spans(rx: re.Pattern, text: str) -> list[tuple[int, int]]:
    return [m.span() for m in rx.finditer(text)]


def cited_numbers(
    numbers: list[float], evs: list[Evidence], text: str = ""
) -> tuple[list[float], list[dict]]:
    """(kept, dropped): drop a number only where the text itself says it is not a result.

    A number is dropped only when it is not a cell of a cited row and every
    place the text states it is explained: inside a date expression ("13 Jul
    2021"), named as a declared line ("the 100 m3/s line"), or written as the
    coordinate filter it is ("lat 50.2-50.7", and a literal of the cited SQL).
    "Peaked at 100 m3/s" against a 250 cell stays, and the Judge flags it.
    "13 m3/s on 13 Jul" keeps 13: one of its two mentions is a value.
    Dropped numbers are returned with the reason, for Claim.numbers_dropped.
    """
    vals = cell_values(evs)
    tol = settings.numeric_tolerance
    sql_literals = [x for e in evs for x in numbers_in(e.sql or "")]
    lines = [(float(d.value), _unit_key(d.unit)) for d in DEFINITIONS.values()]
    dates = _spans(_WORD_DATE, text) + _spans(_ISO_DATE, text) + _spans(_CLOCK, text)
    named_lines = [
        (m.span(), float(m.group(1) or m.group(3)), _unit_key(m.group(2) or m.group(4)))
        for m in _LINE_NAMED.finditer(text)
    ]
    filters = _spans(_FILTER_NAMED, text)

    def near(n: float, pool: list[float]) -> bool:
        return any(
            math.isclose(n, v, rel_tol=tol, abs_tol=0.5 if abs(n) < 10 else 0.0) for v in pool
        )

    def inside(span: tuple[int, int], spans: list[tuple[int, int]]) -> bool:
        return any(a <= span[0] and span[1] <= b for a, b in spans)

    mentions: dict[float, list[str | None]] = {}
    for m in _NUM.finditer(text):
        try:
            n = float(m.group().replace(",", ""))
        except ValueError:
            continue
        span = m.span()
        why = None
        if inside(span, dates):
            why = "date"
        elif any(
            # The named number is a declared line in the same unit.
            inside(span, [s])
            and math.isclose(n, v)
            and any(math.isclose(n, lv) and lu == u for lv, lu in lines)
            for s, v, u in named_lines
        ):
            why = "named line"
        elif inside(span, filters) and any(math.isclose(n, x) for x in sql_literals):
            why = "query filter"
        mentions.setdefault(n, []).append(why)

    kept: list[float] = []
    dropped: list[dict] = []
    for n in numbers:
        if near(n, vals):
            kept.append(n)
            continue
        whys = next((w for k, w in mentions.items() if math.isclose(k, n)), [])
        if whys and all(whys):
            dropped.append({"value": n, "reason": whys[0]})
        else:
            kept.append(n)
    return kept, dropped


def cite(claim_id: str, ev: Evidence, provenance: list[dict], n: int) -> list[Citation]:
    cits = [
        Citation(
            citation_id=f"{claim_id}-a{n}",
            claim_id=claim_id,
            layer="a",
            query_id=ev.query_id,
            title=ev.view,
            accessed_at=ev.executed_at_utc,
        )
    ]
    for k, p in enumerate(provenance_rows(ev.view, provenance)):
        cits.append(
            Citation(
                citation_id=f"{claim_id}-b{n}.{k + 1}",
                claim_id=claim_id,
                layer="b",
                source_url=p.get("source_url"),
                title=p.get("dataset"),
                publisher=p.get("publisher"),
                licence=p.get("licence"),
                attribution=p.get("attribution"),
                accessed_at=p.get("fetched_at"),
                storage="pointer",
            )
        )
    return cits


def memory_block(memories: list[dict] | None) -> str:
    """Past approved findings from H-MEM, for the prompt. Never cited: their query ids
    belong to earlier runs, and only this run's evidence can back a claim."""
    if not memories:
        return ""
    lines = [
        f"- {'[demo seed] ' if memory_origin(m)[0] else ''}{m.get('content', '')} "
        f"(run {m.get('run_id', '?')}, relevance {float(m.get('relevance') or 0):.2f})"
        for m in memories[:MEMORY_PROMPT_MAX]
    ]
    return (
        "PAST APPROVED FINDINGS (H-MEM; context only, not evidence; do not cite):\n"
        + "\n".join(lines)
        + "\n"
    )


def thread_block(turns: list[dict] | None) -> str:
    """Earlier turns of this conversation, for the prompt. Context, not evidence: a
    follow-up re-derives every claim from this run's queries."""
    if not turns:
        return ""
    lines = []
    for turn in turns:
        lines.append(
            f"- Q: {turn.get('question', '')} [{turn.get('approval') or turn.get('status')}] "
            f"A: {turn.get('summary') or '(no summary yet)'}"
        )
    return (
        "EARLIER IN THIS THREAD (short-term memory; context only, not evidence; do not cite):\n"
        + "\n".join(lines)
        + "\n"
    )


def _in_area(ev: dict) -> str:
    """In the footprint and inside the event's bbox. exposure_join has no event column,
    so without the bbox the Ahr run counted the Valencia sites as EMSR517's."""
    lat0, lat1, lon0, lon1 = ev["bbox"]
    return f"{IN_FOOTPRINT_SQL} AND lat BETWEEN {lat0} AND {lat1} AND lon BETWEEN {lon0} AND {lon1}"


def _fmt(v) -> str:
    return f"{v:g}" if isinstance(v, (int, float)) else str(v)


def _deterministic(
    state: FloodState, deps: Deps
) -> tuple[list[Hypothesis], list[Claim], str, list[Evidence]]:
    s, ev, prov = settings.schema, state["event"], state.get("provenance", [])
    hs = hazard_schema(ev, s)  # the replay's hazard rows (floodsense_seed for the Ahr)
    t0, t1 = window(state)
    rain_pts = ", ".join(f"'{p}'" for p in ev["rain_points"])
    river_pts = ", ".join(f"'{p}'" for p in ev["river_points"])
    # Rain, discharge, the daily series, the footprint count, and warnings do
    # not depend on each other. Order of the tuple is the evidence order.
    rain, flow, daily, foot, warn, peak = run_sql_parallel(
        deps.zetaris,
        [
            (
                f"SELECT point_id, SUM(rain_mm) AS total_mm, MAX(rain_mm) AS max_hourly_mm, "
                f"MIN(ts_utc) AS first_utc, MAX(ts_utc) AS last_utc, "
                f"COUNT(*) AS hours FROM {hs}.hazard_timeline WHERE point_id IN ({rain_pts}) AND "
                f"rain_mm IS NOT NULL "
                f"AND ts_utc BETWEEN ? AND ? GROUP BY point_id ORDER BY total_mm DESC",
                (t0, t1),
            ),
            (
                f"SELECT point_id, ts_utc, discharge_m3s FROM {hs}.hazard_timeline WHERE point_id IN "
                f"({river_pts}) "
                f"AND ts_utc BETWEEN ? AND ? ORDER BY ts_utc",
                (t0, t1),
            ),
            (
                f"SELECT point_id, date, discharge_m3s, source FROM {hs}.discharge_daily WHERE "
                f"point_id IN ({river_pts}) "
                f"AND date BETWEEN ? AND ? ORDER BY date",
                (t0[:10], last_complete_day(t1)),
            ),
            (
                f"SELECT COUNT(*) AS sites_in_footprint, COUNT(DISTINCT segment) AS segments FROM "
                f"{s}.exposure_join WHERE {_in_area(ev)}",
                None,
            ),
            (
                f"SELECT point_id, warning_level, MIN(ts_utc) AS first_utc FROM {hs}.hazard_timeline "
                f"WHERE warning_level IS NOT NULL "
                f"AND ts_utc BETWEEN ? AND ? GROUP BY point_id, warning_level ORDER BY first_utc",
                (t0, t1),
            ),
            # The peak row itself. The series above is sampled (20 rows), so on a
            # 96-hour series its maximum is the first day's, not the peak.
            (
                f"SELECT point_id, ts_utc, discharge_m3s FROM {hs}.hazard_timeline WHERE point_id IN "
                f"({river_pts}) AND discharge_m3s IS NOT NULL "
                f"AND ts_utc BETWEEN ? AND ? ORDER BY discharge_m3s DESC, ts_utc ASC LIMIT 1",
                (t0, t1),
            ),
        ],
    )

    claims: list[Claim] = []
    hyps: list[Hypothesis] = []
    n = 0

    def claim(text, kind, evs, hid, numbers):
        nonlocal n
        n += 1
        cid = f"C{n}"
        claims.append(
            Claim(
                claim_id=cid,
                text=text,
                kind=kind,
                numbers=numbers,
                hypothesis_id=hid,
                citations=[c for i, e in enumerate(evs, 1) for c in cite(cid, e, prov, i)],
            )
        )
        return cid

    # H1 rain -> catchment
    h1 = []
    for r in rain.rows_sample[:2]:
        h1.append(
            claim(
                f"Point {point_label(r['point_id'])} recorded {_fmt(r['total_mm'])} mm of rain over "
                f"{r['hours']} hours between {r['first_utc']} and {r['last_utc']}, "
                f"peak hour {_fmt(r['max_hourly_mm'])} mm.",
                "number",
                [rain],
                "H1",
                [r["total_mm"], r["hours"], r["max_hourly_mm"]],
            )
        )
    for w in warn.rows_sample[:1]:
        h1.append(
            claim(
                f"Warning level '{w['warning_level']}' was in force for point {point_label(w['point_id'])} from "
                f"{w['first_utc']}.",
                "fact",
                [warn],
                "H1",
                [],
            )
        )
    hyps.append(
        Hypothesis(
            id="H1",
            link="rain->catchment",
            citations=h1,
            statement=f"Extreme rainfall fell over the {ev['catchment']}"
            if h1
            else "No rainfall signal in the window",
        )
    )

    # H2 catchment -> river
    h2 = []
    flows = [r for r in flow.rows_sample if r.get("discharge_m3s") is not None]
    if flows:
        p = (
            peak.rows_sample[0]
            if peak.rows_sample
            else max(flows, key=lambda r: r["discharge_m3s"])
        )
        base = flows[0]
        h2.append(
            claim(
                f"Discharge at {point_label(p['point_id'])} reached {_fmt(p['discharge_m3s'])} m3/s at "
                f"{p['ts_utc']}, from {_fmt(base['discharge_m3s'])} m3/s at {base['ts_utc']}.",
                "number",
                [peak, flow] if peak.rows_sample else [flow],
                "H2",
                [p["discharge_m3s"], base["discharge_m3s"]],
            )
        )
        gaps = [r for r in flow.rows_sample if r.get("discharge_m3s") is None]
        if gaps and gaps[0]["ts_utc"] > p["ts_utc"]:
            h2.append(
                claim(
                    f"The {point_label(p['point_id'])} series has no discharge value from {gaps[0]['ts_utc']} "
                    f"on (gauge outage during the peak).",
                    "fact",
                    [flow],
                    "H2",
                    [],
                )
            )
    if len(daily.rows_sample) >= 2:
        d = max(daily.rows_sample, key=lambda r: r["discharge_m3s"])
        before = daily.rows_sample[0]
        h2.append(
            claim(
                f"Daily discharge for {point_label(d['point_id'])} ({d['source']}) was "
                f"{_fmt(d['discharge_m3s'])} m3/s on {d['date']}, up from "
                f"{_fmt(before['discharge_m3s'])} m3/s on {before['date']}.",
                "number",
                [daily],
                "H2",
                [d["discharge_m3s"], before["discharge_m3s"]],
            )
        )
    if rain.rows_sample and flows:
        first_rain = rain.rows_sample[0]["first_utc"]
        peak_ts = (
            peak.rows_sample[0]
            if peak.rows_sample
            else max(flows, key=lambda r: r["discharge_m3s"])
        )["ts_utc"]
        if first_rain < peak_ts:
            h2.append(
                claim(
                    f"Rain began at {first_rain} and the discharge peak followed at {peak_ts}, "
                    f"consistent with catchment runoff driving the river response.",
                    "cause",
                    [rain, flow, peak],
                    "H2",
                    [],
                )
            )
    hyps.append(
        Hypothesis(
            id="H2",
            link="catchment->river",
            citations=h2,
            statement=f"Runoff produced an extreme discharge in the {ev['river']}"
            if h2
            else "No river response recorded",
        )
    )

    # H3 river -> site
    h3 = []
    if foot.rows_sample and foot.rows_sample[0]["sites_in_footprint"]:
        f = foot.rows_sample[0]
        h3.append(
            claim(
                f"The Copernicus EMS footprint ({ev['event_id']}) covers {f['sites_in_footprint']} "
                f"insured sites across {f['segments']} segments.",
                "number",
                [foot],
                "H3",
                [f["sites_in_footprint"], f["segments"]],
            )
        )
    hyps.append(
        Hypothesis(
            id="H3",
            link="river->site",
            citations=h3,
            statement="The overflow reached built-up areas mapped by Copernicus EMS"
            if h3
            else "No mapped footprint touches an insured site",
        )
    )

    summary = " ".join(
        f"{h.statement} [{', '.join(h.citations)}]." if h.citations else f"{h.statement}."
        for h in hyps
    )
    return hyps, claims, summary, [rain, flow, daily, foot, warn, peak]


def _live_deterministic(
    state: FloodState, deps: Deps
) -> tuple[list[Hypothesis], list[Claim], str, list[Evidence], dict]:
    """The same chain, read from {schema}.hazard_now: the past days and the forecast.

    Every number a claim states is a cell of the query it cites, so the Judge's
    numeric check holds. Times are absolute UTC plus a relative "in N h" against
    the clock of this run. Past rows are Open-Meteo / GloFAS model output, not a
    station reading, and the text says so.
    """
    s, ev, prov = settings.schema, state["event"], state.get("provenance", [])
    pts = points_sql(ev, focus(state)["point_id"])
    rain_at = DEFINITIONS["anomaly_rain"]
    flow_at = DEFINITIONS["anomaly_discharge"]
    now = now_utc()
    where = f"point_id IN ({pts}) AND {LIVE_ROWS}"
    span, rain, fpeak, ppeak, cross, foot = run_sql_parallel(
        deps.zetaris,
        [
            (
                f"SELECT horizon, MIN(ts_utc) AS from_utc, MAX(ts_utc) AS to_utc, "
                f"COUNT(*) AS point_hours FROM {s}.hazard_now WHERE {where} "
                f"GROUP BY horizon ORDER BY horizon",
                None,
            ),
            (
                f"SELECT point_id, horizon, SUM(rain_mm) AS total_mm, MAX(rain_mm) AS "
                f"max_hourly_mm, COUNT(*) AS hours FROM {s}.hazard_now WHERE {where} AND "
                f"rain_mm IS NOT NULL GROUP BY point_id, horizon ORDER BY total_mm DESC",
                None,
            ),
            (
                f"SELECT point_id, ts_utc, discharge_m3s FROM {s}.hazard_now WHERE {where} "
                f"AND horizon = 'forecast' AND discharge_m3s IS NOT NULL "
                f"ORDER BY discharge_m3s DESC, ts_utc",
                None,
            ),
            (
                f"SELECT point_id, ts_utc, discharge_m3s FROM {s}.hazard_now WHERE {where} "
                f"AND horizon = 'past' AND discharge_m3s IS NOT NULL "
                f"ORDER BY discharge_m3s DESC, ts_utc",
                None,
            ),
            (
                f"SELECT point_id, MIN(ts_utc) AS first_utc, MAX(discharge_m3s) AS peak_m3s, "
                f"COUNT(*) AS hours FROM {s}.hazard_now WHERE {where} AND horizon = 'forecast' "
                f"AND discharge_m3s >= {flow_at.value} GROUP BY point_id ORDER BY first_utc",
                None,
            ),
            (
                f"SELECT COUNT(*) AS sites_in_footprint, COUNT(DISTINCT segment) AS segments FROM "
                f"{s}.exposure_join WHERE {_in_area(ev)}",
                None,
            ),
        ],
    )

    claims: list[Claim] = []
    hyps: list[Hypothesis] = []
    n = 0

    def claim(text, kind, evs, hid, numbers):
        nonlocal n
        n += 1
        cid = f"C{n}"
        claims.append(
            Claim(
                claim_id=cid,
                text=text,
                kind=kind,
                numbers=numbers,
                hypothesis_id=hid,
                citations=[c for i, e in enumerate(evs, 1) for c in cite(cid, e, prov, i)],
            )
        )
        return cid

    def when(ts) -> str:
        rel = relative(ts, now)
        return f"{ts} ({rel})" if rel else str(ts)

    # How far the synced rows actually reach. The view is only as fresh as the
    # last zetaris sync: an old sync has fewer forecast hours left, and its
    # "past" hours were forecast hours when they were fetched.
    ends = {r.get("horizon"): r.get("to_utc") for r in span.rows_sample}
    past_to, fc_to = ends.get("past"), ends.get("forecast")
    left = hours_between(fc_to, now) if fc_to else None
    stale = left is None or left < STALE_FORECAST_H
    ahead = f"forecast window to {when(fc_to)}" if fc_to else "forecast window (no forecast rows)"
    past_word = "observed-modelled" + (", stale sync" if stale else "")

    # H1 rain -> catchment, forecast first, then the past days.
    h1 = []
    if span.rows_sample:
        h1.append(
            claim(
                f"Live rows: past ({past_word}) up to {when(past_to)}, forecast up to "
                f"{when(fc_to)}."
                + (
                    f" STALE: the forecast reaches less than {STALE_FORECAST_H} h past now, so "
                    f"the last sync is old and some past hours were forecasts when fetched."
                    if stale
                    else ""
                ),
                "fact",
                [span],
                "H1",
                [],
            )
        )
    by_h = {"forecast": [], "past": []}
    for r in rain.rows_sample:
        by_h.setdefault(r.get("horizon"), []).append(r)
    rain_crosses = False
    for horizon, label in (
        ("forecast", f"Forecast, {ahead}"),
        ("past", f"Past days, {past_word} (Open-Meteo, not a station reading)"),
    ):
        rows = by_h.get(horizon) or []
        if not rows:
            continue
        r = rows[0]
        if horizon == "forecast":
            rain_crosses = float(r["max_hourly_mm"] or 0) >= rain_at.value
        h1.append(
            claim(
                f"{label}: {point_label(r['point_id'])} has the most rain, "
                f"{_fmt(r['total_mm'])} mm over {r['hours']} hours, peak hour "
                f"{_fmt(r['max_hourly_mm'])} mm.",
                "number",
                [rain],
                "H1",
                [r["total_mm"], r["hours"], r["max_hourly_mm"]],
            )
        )
    forecast_rain = by_h.get("forecast") or []
    if forecast_rain:
        top = forecast_rain[0]
        rain_statement = (
            f"Forecast rain reaches {_fmt(top['max_hourly_mm'])} mm in an hour at "
            f"{point_label(top['point_id'])} within the {ahead}, at or above the "
            f"{_fmt(rain_at.value)} mm/h anomaly line"
            if rain_crosses
            else f"No point's forecast rain reaches {_fmt(rain_at.value)} mm/h in the {ahead}"
        )
    else:
        rain_statement = f"No live rain rows in {s}.hazard_now"
    hyps.append(Hypothesis(id="H1", link="rain->catchment", citations=h1, statement=rain_statement))

    # H2 catchment -> river: does any point's forecast discharge cross the line?
    h2 = []
    crossing = cross.rows_sample
    for c in crossing[:3]:
        h2.append(
            claim(
                f"Forecast: discharge at {point_label(c['point_id'])} is at or above "
                f"{_fmt(flow_at.value)} m3/s for {c['hours']} hours from {when(c['first_utc'])}, "
                f"peaking at {_fmt(c['peak_m3s'])} m3/s (GloFAS model via Open-Meteo).",
                "number",
                [cross],
                "H2",
                [c["hours"], c["peak_m3s"]],
            )
        )
    if fpeak.rows_sample:
        p = fpeak.rows_sample[0]
        if crossing:
            text = (
                f"The highest forecast discharge in the {ahead} is "
                f"{_fmt(p['discharge_m3s'])} m3/s at {point_label(p['point_id'])}, "
                f"{when(p['ts_utc'])}."
            )
        else:
            text = (
                f"No point crosses {_fmt(flow_at.value)} m3/s in the {ahead}: "
                f"the highest forecast discharge is {_fmt(p['discharge_m3s'])} m3/s at "
                f"{point_label(p['point_id'])}, {when(p['ts_utc'])}."
            )
        h2.append(claim(text, "number", [fpeak], "H2", [p["discharge_m3s"]]))
    if ppeak.rows_sample:
        p = ppeak.rows_sample[0]
        h2.append(
            claim(
                f"Past days ({past_word}, not a gauge reading): the highest discharge was "
                f"{_fmt(p['discharge_m3s'])} m3/s at {point_label(p['point_id'])}, "
                f"{when(p['ts_utc'])}.",
                "number",
                [ppeak],
                "H2",
                [p["discharge_m3s"]],
            )
        )
    if crossing:
        names = ", ".join(point_label(c["point_id"]) for c in crossing)
        flow_statement = (
            f"{names} {'is' if len(crossing) == 1 else 'are'} forecast to reach "
            f"{_fmt(flow_at.value)} m3/s or more within the {ahead}"
        )
    elif fpeak.rows_sample:
        flow_statement = (
            f"No point's forecast discharge reaches {_fmt(flow_at.value)} m3/s in the {ahead}"
        )
    else:
        flow_statement = f"No live discharge rows in {s}.hazard_now"
    hyps.append(
        Hypothesis(id="H2", link="catchment->river", citations=h2, statement=flow_statement)
    )

    # H3 river -> site. The only footprint is the 2024 EMSR773 observed extent.
    h3 = []
    if foot.rows_sample and foot.rows_sample[0]["sites_in_footprint"]:
        f = foot.rows_sample[0]
        h3.append(
            claim(
                f"Historical flood footprint, not a forecast extent: the {ev['event_id']} "
                f"Copernicus EMS observed extent covers {f['sites_in_footprint']} insured sites "
                f"across {f['segments']} segments; it is used here as a proxy for where water "
                f"reached last time.",
                "number",
                [foot],
                "H3",
                [f["sites_in_footprint"], f["segments"]],
            )
        )
    hyps.append(
        Hypothesis(
            id="H3",
            link="river->site",
            citations=h3,
            statement=(
                f"Insured sites lie inside the historical {ev['event_id']} flood footprint "
                f"(a proxy, not a forecast extent)"
                if h3
                else "No insured site lies inside the historical footprint"
            ),
        )
    )
    window_note = " STALE live data: the last sync is old." if stale else ""
    summary = (
        f"Live data ({s}.hazard_now, as of {now}). "
        + " ".join(
            f"{h.statement} [{', '.join(h.citations)}]." if h.citations else f"{h.statement}."
            for h in hyps
        )
        + window_note
    )
    findings = {
        "now_utc": now,
        "rain_crosses": rain_crosses,
        "discharge_crosses": bool(crossing),
        "crossing_points": [c["point_id"] for c in crossing],
        "past_to_utc": past_to,
        "forecast_to_utc": fc_to,
        "forecast_hours_left": left,
        "stale": stale,
    }
    return hyps, claims, summary, [span, rain, fpeak, ppeak, cross, foot], findings


def _trend(row: dict) -> str:
    rate = row.get("trend_cm_h")
    if isinstance(rate, (int, float)) and not isinstance(rate, bool):
        if abs(rate) < 0.5:
            return f"steady ({_fmt(rate)} cm/h, trend_cm_h)"
        word = "rising" if rate > 0 else "falling"
        return f"{word} {_fmt(abs(rate))} cm/h (trend_cm_h)"
    prev, prev_ts, level = row.get("prev_cm"), row.get("prev_utc"), row.get("level_cm")
    if prev is None or not prev_ts or prev_ts == row.get("ts_utc"):
        return "no earlier reading to show a trend"
    # Only cited cells: the earlier and the latest level, no derived difference.
    delta = float(level) - float(prev)
    word = "steady" if abs(delta) < 2 else ("rising" if delta > 0 else "falling")
    return f"{word}, from {_fmt(prev)} cm at {prev_ts} to {_fmt(level)} cm"


def _rhine_live(
    state: FloodState, deps: Deps
) -> tuple[list[Hypothesis], list[Claim], str, list[Evidence], dict]:
    """The Rhine right now: PEGELONLINE levels from {schema}.gauge_levels.

    hazard_now is read for the event's German points first. When it holds none,
    the run says so plainly and does not borrow Valencia rows. Every number a
    gauge claim states is a cell of the gauge query it cites.
    """
    s, ev, prov = settings.schema, state["event"], state.get("provenance", [])
    now = now_utc()
    count, gauges, readings = run_sql_parallel(
        deps.zetaris,
        [
            (
                f"SELECT COUNT(*) AS point_hours FROM {s}.hazard_now WHERE point_id IN "
                f"({points_sql(ev)}) AND {LIVE_ROWS}",
                None,
            ),
            (gauge_latest_sql(s, RHINE_WATERS), None),
            # One row even when the view is empty, so a "no reading" claim cites rows.
            (
                f"SELECT COUNT(*) AS live_readings, COUNT(DISTINCT station) AS stations FROM "
                f"{s}.gauge_levels WHERE {GAUGE_LIVE_ROWS}",
                None,
            ),
        ],
    )
    hazard_hours = int((count.rows_sample or [{}])[0].get("point_hours") or 0)
    if hazard_hours:
        hyps, claims, _summary, extra, findings = _live_deterministic(state, deps)
    else:
        hyps, claims, extra, findings = [], [], [], {"now_utc": now}
    n = len(claims)

    def claim(text, kind, evs, numbers):
        nonlocal n
        n += 1
        cid = f"C{n}"
        claims.append(
            Claim(
                claim_id=cid,
                text=text,
                kind=kind,
                numbers=numbers,
                hypothesis_id=hid,
                citations=[c for i, e in enumerate(evs, 1) for c in cite(cid, e, prov, i)],
            )
        )
        return cid

    hid = "H5" if hyps else "H2"
    ids: list[str] = []
    names = ", ".join(
        point_label(p) for p in [*ev.get("river_points", ()), *ev.get("rain_points", ())]
    )
    if not hazard_hours:
        ids.append(
            claim(
                f"{s}.hazard_now holds 0 live rows (past or forecast) for the German points "
                f"({names}): this run has no modelled rain or discharge for Germany, only "
                f"PEGELONLINE gauge levels.",
                "fact",
                [count],
                [0],
            )
        )
    stations = [r for r in gauges.rows_sample if r.get("level_cm") is not None]
    # Stations the question names (Köln, Mainz) first, so the 8-row cut keeps them.
    named = (watch_target(str((state.get("request") or {}).get("question") or "")) or {}).get(
        "stations"
    ) or []
    if named:
        stations.sort(key=lambda r: r.get("station") not in named)
    # The selected station (context) first. One the view does not hold is said plainly.
    picked = focus(state)["station"]
    if picked:
        picked = picked.replace("''", "'")
        stations.sort(key=lambda r: str(r.get("station")).upper() != picked)
        if stations and not any(str(r.get("station")).upper() == picked for r in stations):
            ids.append(
                claim(
                    f"The selected station {picked} has no live reading in {s}.gauge_levels; "
                    f"{readings.rows_sample[0].get('stations', 0) if readings.rows_sample else 0} "
                    f"other stations do.",
                    "fact",
                    [readings],
                    [readings.rows_sample[0].get("stations", 0)] if readings.rows_sample else [],
                )
            )
    over: list[str] = []
    stale_any = False
    for r in stations[:8]:
        ago = hours_between(now, r["ts_utc"])
        stale_any = stale_any or (ago is not None and ago >= GAUGE_STALE_H)
        rel = relative(r["ts_utc"], now) or "time unreadable"
        numbers = [r["level_cm"]]
        if r.get("prev_cm") is not None and r.get("prev_utc") != r.get("ts_utc"):
            numbers.append(r["prev_cm"])
        rate = r.get("trend_cm_h")
        if isinstance(rate, (int, float)) and not isinstance(rate, bool):
            numbers.append(rate)
        flagged_stale = str(r.get("is_stale")).strip().lower() in ("true", "1", "yes")
        if flagged_stale:
            stale_any = True
        when_txt = (
            f"stale reading from {r['ts_utc']} ({rel}), not a current level"
            if flagged_stale
            else f"at {r['ts_utc']} ({rel})"
        )
        text = (
            f"{r['station']} ({r.get('water') or '?'}): {_fmt(r['level_cm'])} cm {when_txt}; "
            f"{_trend(r)}"
        )
        band = str(r.get("band") or "").lower()
        if band in ("below", "near", "above"):
            text += f"; band '{band}' (PEGELONLINE level band)"
        thr = gauge_threshold(r)
        if thr:
            col, value = thr
            numbers.append(value)
            at_or_over = (
                band == "above"
                if band in ("below", "near", "above")
                else float(r["level_cm"]) >= value
            )
            if flagged_stale:
                at_or_over = False
            if at_or_over:
                over.append(r["station"])
            text += (
                f"; {'at or above' if at_or_over else 'below'} the station threshold "
                f"{_fmt(value)} cm ({col})"
            )
        else:
            text += "; gauge_levels carries no threshold for this station"
        ids.append(
            claim(text + f". PEGELONLINE (WSV). {OFFICIAL_NOTE}", "number", [gauges], numbers)
        )
    if not stations:
        ids.append(
            claim(
                f"Status: {s}.gauge_levels holds no live PEGELONLINE reading (seed rows carry no "
                f"level), so there is no current Rhine water level to report. {OFFICIAL_NOTE}",
                "fact",
                [readings],
                [],
            )
        )
        statement = f"No current Rhine gauge level in {s}.gauge_levels"
    else:
        listed = ", ".join(
            f"{r['station']} {_fmt(r['level_cm'])} cm"
            + (" (stale)" if str(r.get("is_stale")).strip().lower() in ("true", "1", "yes") else "")
            for r in stations[:8]
        )
        statement = f"Rhine gauges now (PEGELONLINE): {listed}" + (
            f"; at or above threshold: {', '.join(over)}" if over else ""
        )
    hyps.append(Hypothesis(id=hid, link="catchment->river", citations=ids, statement=statement))
    summary = (
        f"Live data ({s}.gauge_levels"
        + (f" and {s}.hazard_now" if hazard_hours else "")
        + f", as of {now}). "
        + " ".join(
            f"{h.statement} [{', '.join(h.citations)}]." if h.citations else f"{h.statement}."
            for h in hyps
        )
        + (" STALE: a gauge reading is more than 6 h old." if stale_any else "")
        + f" {OFFICIAL_NOTE}"
    )
    findings = {
        **findings,
        "now_utc": now,
        "stale": bool(findings.get("stale")) or stale_any,
        "gauge_hypothesis": hid,
        "gauge_stations": [r["station"] for r in stations],
        "gauge_over_threshold": over,
        "hazard_now_german_rows": hazard_hours,
    }
    return hyps, claims, summary, [count, gauges, readings, *extra], findings


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _float(v) -> float | None:
    """Zetaris REST returns numbers as strings. None when missing or not a finite number."""
    if v is None or isinstance(v, bool) or v == "":
        return None
    try:
        out = float(v)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _eu_watch_live(
    state: FloodState, deps: Deps, target: dict
) -> tuple[list[Hypothesis], list[Claim], str, list[Evidence], dict]:
    """Europe live watch: the gauges and model points the question names.

    PEGELONLINE gauges ({schema}.gauge_levels) are banded against the station's
    MHW, an official characteristic value. GloFAS points ({schema}.eu_watch)
    carry a model band relative to their own series, which is not an official
    warning; every point claim says so. Each number a claim states is a cell of
    the query it cites.
    """
    s, prov = settings.schema, state.get("provenance", [])
    now = now_utc()
    stations, points = tuple(target["stations"]), tuple(target["points"])
    queries: list[tuple[str, None]] = []
    if stations:
        queries += [
            (gauge_latest_sql(s, stations=stations), None),
            (
                f"SELECT COUNT(DISTINCT station) AS stations FROM {s}.gauge_levels WHERE "
                f"{GAUGE_LIVE_ROWS} AND station IN ({sql_list(stations)})",
                None,
            ),
        ]
    if points:
        queries.append(
            (
                f"SELECT point_id, name, country, river, discharge_m3s, forecast_max_m3s, "
                f"past30_median_m3s, band, basis, as_of_date FROM {s}.eu_watch WHERE point_id "
                f"IN ({sql_list(points)}) ORDER BY point_id",
                None,
            )
        )
    evs = run_sql_parallel(deps.zetaris, queries)
    gauges, readings = (evs[0], evs[1]) if stations else (None, None)
    model = evs[-1] if points else None
    claims: list[Claim] = []
    hid = "H1"

    def claim(text, kind, ev, numbers):
        cid = f"C{len(claims) + 1}"
        claims.append(
            Claim(
                claim_id=cid,
                text=text,
                kind=kind,
                numbers=numbers,
                hypothesis_id=hid,
                citations=cite(cid, ev, prov, 1),
            )
        )
        return cid

    ids: list[str] = []
    parts: list[str] = []
    at_risk: list[str] = []
    stale_any = False
    rows = [
        {**r, **{k: _float(r.get(k)) for k in ("level_cm", "trend_cm_h", "mw_cm", "mhw_cm")}}
        for r in (gauges.rows_sample if gauges else [])
    ]
    rows = [r for r in rows if r["level_cm"] is not None]
    for r in rows:
        stale = str(r.get("is_stale")).strip().lower() in ("true", "1", "yes")
        stale_any = stale_any or stale
        rel = relative(r["ts_utc"], now) or "time unreadable"
        numbers = [r["level_cm"]]
        text = (
            f"{r['station']} ({r.get('water') or '?'}), PEGELONLINE gauge: "
            f"{_fmt(r['level_cm'])} cm "
            + (
                f"(stale reading from {r['ts_utc']}, {rel})"
                if stale
                else f"at {r['ts_utc']} ({rel})"
            )
        )
        if _num(r.get("trend_cm_h")):
            numbers.append(r["trend_cm_h"])
            text += f", trend {_fmt(r['trend_cm_h'])} cm/h"
        band = str(r.get("band") or "unknown").lower()
        mhw, mw = r.get("mhw_cm"), r.get("mw_cm")
        if _num(mhw):
            numbers.append(mhw)
            text += f"; official threshold band '{band}' against MHW {_fmt(mhw)} cm"
            if _num(mw):
                numbers.append(mw)
                text += f" (MW {_fmt(mw)} cm)"
        else:
            text += "; gauge_levels carries no MHW for this station"
        if band in ("above", "near") and not stale:
            at_risk.append(r["station"])
        ids.append(
            claim(text + f". Quelle: WSV, PEGELONLINE. {OFFICIAL_NOTE}", "number", gauges, numbers)
        )
        parts.append(f"{r['station']} {_fmt(r['level_cm'])} cm ({band} vs MHW)")
    if stations and not rows:
        n_live = _float((readings.rows_sample or [{}])[0].get("stations")) if readings else None
        n_live = int(n_live) if n_live is not None else 0
        ids.append(
            claim(
                f"{s}.gauge_levels holds no live PEGELONLINE reading for "
                f"{', '.join(stations)} ({n_live} of them have one); the poller may not have "
                f"run. {OFFICIAL_NOTE}",
                "fact",
                readings,
                [n_live] if _num(n_live) else [],
            )
        )
        parts.append(f"no live gauge reading for {', '.join(stations)}")
    for r in model.rows_sample if model else []:
        label = f"{r.get('river')} at {r.get('name')} ({r.get('country')}, {r.get('point_id')})"
        q, fmax, med = (
            _float(r.get(k)) for k in ("discharge_m3s", "forecast_max_m3s", "past30_median_m3s")
        )
        band = str(r.get("band") or "unknown").lower()
        if not (_num(q) and _num(fmax) and _num(med)):
            ids.append(
                claim(
                    f"{label}: {s}.eu_watch holds no current GloFAS value (band '{band}'), so "
                    f"there is no model reading to report. Model, not an official warning.",
                    "fact",
                    model,
                    [],
                )
            )
            parts.append(f"{label}: no model reading")
            continue
        meaning = {
            "above": "at least twice",
            "near": "at least one and a half times",
            "below": "less than one and a half times",
        }.get(band, "not comparable with")
        ids.append(
            claim(
                f"{label}: GloFAS model cell value {_fmt(q)} m3/s today ({r.get('as_of_date')}), 7-day "
                f"forecast max {_fmt(fmax)} m3/s, {meaning} the exact past-30-day median "
                f"{_fmt(med)} m3/s; model band '{band}'. Open-Meteo Flood API (GloFAS), CC BY "
                f"4.0. Model, not an official warning; official: the national hydrological "
                f"service and EFAS.",
                "number",
                model,
                [q, fmax, med],
            )
        )
        if band in ("above", "near"):
            at_risk.append(label)
        parts.append(f"{label} forecast max {_fmt(fmax)} m3/s, model band '{band}'")
    statement = f"Europe live watch ({target['word']}): " + "; ".join(parts)
    unknown = any("no model reading" in p or "no live gauge" in p or "(unknown" in p for p in parts)
    if at_risk:
        statement += f". Raised: {', '.join(at_risk)}"
    elif unknown:
        statement += ". No raised band among the readings available"
    else:
        statement += ". Nothing named is near or above its line"
    hyps = [Hypothesis(id=hid, link="catchment->river", citations=ids, statement=statement)]
    views = [v for v, on in (("gauge_levels", stations), ("eu_watch", points)) if on]
    notes = []
    if stations:
        notes.append(
            "Gauge bands use the official PEGELONLINE characteristic values (MHW). " + OFFICIAL_NOTE
        )
    if points:
        notes.append(
            "GloFAS bands compare the forecast with the point's own recent series: a model, "
            "not an official warning; official: the national hydrological service and EFAS."
        )
    summary = (
        f"Live data ({', '.join(f'{s}.{v}' for v in views)}, as of {now}). {statement} "
        f"[{', '.join(ids)}]."
        + (" STALE: a gauge reading is old." if stale_any else "")
        + " "
        + " ".join(notes)
    )
    findings = {
        "now_utc": now,
        "stale": stale_any,
        "watch_hypothesis": hid,
        "watch_stations": [r["station"] for r in rows],
        "watch_points": [r.get("point_id") for r in (model.rows_sample if model else [])],
        "watch_at_risk": at_risk,
    }
    return hyps, claims, summary, list(evs), findings


LINK_ROWS = 8  # evidence rows per table in a per-link prompt
LINK_CLAIMS = 4  # claims kept from one per-link answer


def _link_prompt(
    state: FloodState,
    h: Hypothesis,
    drafts: list[Claim],
    evs: list[Evidence],
    others: list[Evidence] = (),
    alias: dict[str, str] | None = None,
) -> str:
    """One link's prompt. Query ids appear as short aliases (Q1, Q2..): a 36-char
    UUID per citation cost the model tokens it cannot spare under the deadline."""
    alias = alias or {}
    nums = [n for c in drafts for n in c.numbers]
    shown = {e.query_id for e in evs}
    rest = [e for e in others if e.query_id not in shown]
    view = lambda e: e.view.rsplit(".", 1)[-1]  # noqa: E731
    return (
        f"EVENT: {state['event']['name']} ({state['event_id']}); river "
        f"{state['event']['river']}\nQUESTION: {state['request']['question']}\n"
        f"{thread_block(state.get('thread'))}{memory_block(state.get('memories'))}"
        f"LINK: {h.id} {h.link}\nDRAFT:\n"
        + "\n".join(f"- {c.text}" for c in drafts)
        + "\n\nEVIDENCE:\n"
        + "\n\n".join(compact_rows(e, nums, LINK_ROWS, qid=alias.get(e.query_id)) for e in evs)
        + (
            "\n\nOTHER QUERIES OF THIS RUN (rows not shown):\n"
            + "\n".join(
                f"query_id={alias.get(e.query_id, e.query_id)} view={view(e)} rows={e.row_count}"
                for e in rest
            )
            if rest
            else ""
        )
    )


def _link_reply(
    deps: Deps, system: str, prompt: str, link: str
) -> tuple[str, list[dict], str] | None:
    """(statement, raw claims, model_id) for one link, or None: that link keeps its draft."""
    try:
        text, model_id = deps.llm.complete("fast", system, prompt)
        js = parse_json(text)
    except Exception as e:  # one 502 loses this link's wording, not the chain
        log.warning("investigator: %s model step skipped (%s)", link, str(e)[:140])
        return None
    raw = [c for c in js.get("claims") or [] if isinstance(c, dict) and c.get("text")]
    if not raw:
        return None
    statement = js.get("statement")
    if not statement:  # tolerate the older whole-chain shape
        statement = next(
            (h.get("statement") for h in js.get("hypotheses") or [] if isinstance(h, dict)), ""
        )
    return str(statement or ""), raw[:LINK_CLAIMS], model_id


def _model(
    state: FloodState,
    deps: Deps,
    hyps: list[Hypothesis],
    claims: list[Claim],
    extra: list[Evidence],
) -> tuple[list[Hypothesis], list[Claim], str, str, int, list[dict]] | None:
    """Reword the deterministic chain, one model call per link, in parallel.

    Each call sees only that link's draft claims and the evidence they cite
    (compact, <= LINK_ROWS rows per table) and answers a small JSON object, so
    it fits the Nightshift gateway's ~45 s. Links merge in chain order and
    claims are renumbered C1.. in that order. A link whose call fails keeps
    its deterministic claims. A model claim may cite any query of the run
    (the others are listed by id and row count, rows not shown); an unknown
    id is dropped, and a claim that cites none stays and the Skeptic rejects
    its link.
    A model claim whose every cited query is empty or errored is dropped
    (listed in the last item, with why); its numbers go through
    cited_numbers like the deterministic ones.
    Returns None when no link was answered.
    """
    evidence = {e.query_id: e for e in [Evidence(**e) for e in state["evidence"].values()] + extra}
    by_id = {c.claim_id: c for c in claims}
    jobs = []
    for h in hyps:
        drafts = [by_id[i] for i in h.citations if i in by_id]
        qids = dict.fromkeys(
            x.query_id
            for c in drafts
            for x in c.citations
            if x.layer == "a" and x.query_id in evidence
        )
        jobs.append((h, drafts, [evidence[q] for q in qids]))
    alias = {q: f"Q{i}" for i, q in enumerate(evidence, 1)}
    back = {a: q for q, a in alias.items()}
    system = INVESTIGATOR_LINK.replace("{lang}", state["request"].get("lang", "en"))
    replies = map_ordered(
        lambda j: (
            _link_reply(
                deps, system, _link_prompt(state, *j, list(evidence.values()), alias), j[0].link
            )
            if j[2]
            else None
        ),
        jobs,
    )
    if not any(replies):
        return None
    prov = state.get("provenance", [])
    out_h: list[Hypothesis] = []
    out_c: list[Claim] = []
    drops: list[dict] = []
    model_id = ""
    for (h, drafts, evs), reply in zip(jobs, replies):
        items = []  # (text, kind, numbers, numbers_dropped, cited evidence)
        if reply:
            statement, raw, mid = reply
            model_id = model_id or mid
            # A link's claim may cite its own draft queries and other queries of
            # the same views (e.g. the hourly and daily series); an exposure or
            # gauge query on the rain link is unrelated and is removed.
            views = {e.view for e in evs}
            relevant = {q for q, e in evidence.items() if e.view in views}
            for k, c in enumerate(raw, 1):
                ids_in = [back.get(str(q), str(q)) for q in c.get("query_ids") or []]
                known_ids = [q for q in dict.fromkeys(ids_in) if q in evidence]
                cited = [evidence[q] for q in known_ids if q in relevant]
                off = [q for q in known_ids if q not in relevant]
                if ids_in and not cited:
                    # Every id unknown (e.g. Q99) or unrelated: nothing backs it.
                    drop = {
                        "claim_id": f"{h.id}.{k}",
                        "reason": "unrelated query ids" if off else "unknown query ids",
                        "query_ids": off,
                        "errors": [],
                    }
                    drops.append(drop)
                    log.warning(
                        "investigator: dropped claim %s (%s)", drop["claim_id"], drop["reason"]
                    )
                    continue
                if off:
                    drops.append(
                        {
                            "kind": "citation",
                            "claim_id": f"{h.id}.{k}",
                            "reason": "unrelated citation removed",
                            "query_ids": off,
                            "errors": [],
                            "views": sorted({evidence[q].view for q in off}),
                        }
                    )
                if cited and all(e.row_count == 0 or e.error for e in cited):
                    # A claim whose every cited query came back empty has no rows
                    # behind it, and the Skeptic would reject its whole link.
                    errors = [f"{e.query_id}: {e.error}" for e in cited if e.error]
                    drop = {
                        "claim_id": f"{h.id}.{k}",
                        "reason": "errored evidence" if errors else "empty evidence",
                        "query_ids": [e.query_id for e in cited],
                        "errors": errors,
                    }
                    drops.append(drop)
                    log.warning(
                        "investigator: dropped claim %s (%s) %s",
                        drop["claim_id"],
                        drop["reason"],
                        errors,
                    )
                    continue
                text = str(c["text"])
                kept, gone = cited_numbers(
                    [float(x) for x in c.get("numbers") or [] if isinstance(x, (int, float))]
                    or numbers_in(text),
                    cited,
                    text,
                )
                kind = c.get("kind") if c.get("kind") in ("fact", "number", "cause") else "fact"
                items.append((text, kind, kept, gone, cited))
        if not items:  # no answer, or every model claim dropped: keep the draft
            statement = h.statement
            items = [
                (
                    c.text,
                    c.kind,
                    c.numbers,
                    c.numbers_dropped,
                    [
                        evidence[x.query_id]
                        for x in c.citations
                        if x.layer == "a" and x.query_id in evidence
                    ],
                )
                for c in drafts
            ]
        ids = []
        for text, kind, numbers, gone, cited in items:
            cid = f"C{len(out_c) + 1}"
            out_c.append(
                Claim(
                    claim_id=cid,
                    text=text,
                    kind=kind,
                    numbers=numbers,
                    numbers_dropped=gone,
                    hypothesis_id=h.id,
                    citations=[x for i, e in enumerate(cited, 1) for x in cite(cid, e, prov, i)],
                )
            )
            ids.append(cid)
        out_h.append(h.model_copy(update={"statement": statement or h.statement, "citations": ids}))
    summary = " ".join(
        f"{h.statement} [{', '.join(h.citations)}]." if h.citations else f"{h.statement}."
        for h in out_h
    )
    return out_h, out_c, summary, model_id, sum(1 for r in replies if r), drops


_DOC_SQL = (
    "SELECT chunk_id, text, text_sha256, title, source_url, publisher, licence, "
    "attribution, page, paragraph, lines, section FROM PGVECTOR_RAG.chunks"
)


def _text(raw: dict, key: str) -> str | None:
    value = raw.get(key)
    return value if isinstance(value, str) else None


def _doc_locator(raw: dict) -> Locator | None:
    locator = raw.get("locator")
    if not isinstance(locator, dict):
        return None
    page = locator.get("page")
    paragraph = locator.get("paragraph")
    lines = locator.get("lines")
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        return None
    if isinstance(paragraph, bool) or not isinstance(paragraph, int) or paragraph < 1:
        return None
    if not isinstance(lines, str) or not lines:
        return None
    section = locator.get("section")
    return Locator(
        page=page,
        paragraph=paragraph,
        lines=lines,
        section=section if isinstance(section, str) and section else None,
    )


def _verified_raw(raw: dict) -> bool:
    """The retrieved row's quote hashes, its chunk hashes, and the quote is in the chunk."""
    quote, digest = raw.get("quote"), raw.get("content_sha256")
    text, text_digest = raw.get("text"), raw.get("text_sha256")
    if not all(isinstance(x, str) and x for x in (quote, digest, text, text_digest)):
        return False
    return (
        hashlib.sha256(quote.encode()).hexdigest() == digest
        and hashlib.sha256(text.encode()).hexdigest() == text_digest
        and quote in text
    )


def _doc_text(raw: dict, limit: int = 220) -> str:
    """'<title>, p. N para. M: "<excerpt>"' with the excerpt cut from the verified quote."""
    quote = " ".join(str(raw.get("quote")).split())
    excerpt = quote
    if len(excerpt) > limit:
        cut = excerpt[:limit]
        end = max(cut.rfind(". "), cut.rfind("; "))
        excerpt = cut[: end + 1] if end > limit // 3 else cut[: cut.rfind(" ")]
    loc = raw.get("locator") if isinstance(raw.get("locator"), dict) else {}
    where = ", ".join(f"{k} {loc[k]}" for k in ("page", "paragraph") if loc.get(k) is not None)
    title = _text(raw, "title") or "Document"
    return f'{title}{", " + where if where else ""}: "{excerpt.strip()}"'


def _cite_passage(target, raw: dict, offset: int, rows_for_q: dict[str, list[dict]]) -> None:
    """One layer (c) citation of `raw` on `target`, plus its evidence row sample."""
    qid = raw.get("query_id") if isinstance(raw.get("query_id"), str) else None
    chunk_id = raw.get("chunk_id") if isinstance(raw.get("chunk_id"), str) else None
    target.citations.append(
        Citation(
            citation_id=f"{target.claim_id}-c{offset}",
            claim_id=target.claim_id,
            layer="c",
            source_url=_text(raw, "source_url"),
            title=_text(raw, "title"),
            publisher=_text(raw, "publisher"),
            licence=_text(raw, "licence"),
            attribution=_text(raw, "attribution"),
            locator=_doc_locator(raw),
            quote=_text(raw, "quote"),
            content_sha256=_text(raw, "content_sha256"),
            storage="full_text",
            query_id=qid,
            chunk_id=chunk_id if chunk_id and len(chunk_id) <= 128 else None,
            accessed_at=now_utc(),
        )
    )
    text = raw.get("text")
    digest = raw.get("text_sha256")
    if qid and isinstance(text, str) and isinstance(digest, str):
        sample = {"text": text, "text_sha256": digest}
        if chunk_id and len(chunk_id) <= 128:
            sample["chunk_id"] = chunk_id
        rows_for_q.setdefault(qid, []).append(sample)


def _attach_documents(claims, raws, request, query):
    """Append layer (c) citations to the named claim, or to a new fact claim C-doc.

    Event-agnostic passages (`generic`, e.g. EEA or EIOPA) never sit on a claim built
    from an event passage: each verified one gets its own claim C-doc-g<n>, whose text
    comes from that same passage. An unverifiable generic passage is dropped.
    """
    event_raws = [r for r in raws if not r.get("generic")]
    generic_raws = [r for r in raws if r.get("generic") and _verified_raw(r)]
    rows_for_q: dict[str, list[dict]] = {}
    if event_raws:
        target_id = request.get("doc_claim_id")
        target = next(
            (item for item in claims if isinstance(target_id, str) and item.claim_id == target_id),
            None,
        )
        if target is None:
            # A document-only claim asserts what the top verified passage says, never
            # the search query. No verifiable passage: no C-doc.
            top = next((r for r in event_raws if _verified_raw(r)), None)
            if top is not None:
                target = Claim(claim_id="C-doc", text=_doc_text(top), kind="fact")
                claims = [*claims, target]
        if target is not None:
            start = 1 + sum(1 for item in target.citations if item.layer == "c")
            for offset, raw in enumerate(event_raws, start=start):
                _cite_passage(target, raw, offset, rows_for_q)
    for number, raw in enumerate(generic_raws, start=1):
        own = Claim(claim_id=f"C-doc-g{number}", text=_doc_text(raw), kind="fact")
        _cite_passage(own, raw, 1, rows_for_q)
        claims = [*claims, own]
    evidence = [
        Evidence(
            query_id=qid,
            view="PGVECTOR_RAG.chunks",
            sql=_DOC_SQL,
            rows_sample=rows[:20],
            row_count=len(rows),
            executed_at_utc=now_utc(),
        )
        for qid, rows in rows_for_q.items()
    ]
    return claims, evidence


def _attach_web(claims, place, note, out=None):
    """Tavily snippets as labelled layer (c) claims. Text is cleaned of digits, markup and
    newlines (tavily.clean) and shown only as a quoted excerpt; claims carry no severity."""
    from floodsense_agents import tavily

    res = tavily.search(place)
    if out is not None:
        out["res"] = res
    if res.status != "ok":
        why = f" ({res.reason})" if res.reason else ""
        return claims, [], f"{note.lstrip('; ')} web context {res.status}{why}".strip()
    rows_for_q: dict[str, list[dict]] = {}
    for n, raw in enumerate(tavily.passages(res.items, now_utc()), 1):
        own = Claim(
            claim_id=f"C-web-{n}",
            text=f'{tavily.LABEL}. {raw["title"]}: "{raw["quote"]}"',
            kind="fact",
        )
        _cite_passage(own, raw, 1, rows_for_q)
        claims = [*claims, own]
    ev = [
        Evidence(
            query_id=q,
            view="web.tavily",
            sql="Tavily Search API",
            rows_sample=r,
            row_count=len(r),
            executed_at_utc=now_utc(),
            source="tavily",
        )
        for q, r in rows_for_q.items()
    ]
    return claims, ev, note


def make(deps: Deps):
    def investigator(state: FloodState) -> dict:
        t = time.time()
        if (
            state.get("hypotheses") and state.get("revise_rounds", 0) > 0
        ):  # revise edge: drop what the Skeptic broke
            bad = {h["id"] for h in state["hypotheses"] if h.get("status") == "not_supported"}
            hyps = [h for h in state["hypotheses"] if h["id"] not in bad]
            claims = [c for c in state["claims"] if c.get("hypothesis_id") not in bad]
            kept = " ".join(
                f"{h['statement']} [{', '.join(h['citations'])}]." for h in hyps if h["citations"]
            )
            # Nothing left is a result, not a missing value. Repeating the summary the
            # first pass wrote would state a case the Skeptic has just broken, and an
            # empty one loses the run: the desk refuses a recorded run with no summary
            # and shows its fixture instead, reporting nothing.
            summary = kept or "No hypothesis survived the Skeptic's counter-checks."
            return {
                "hypotheses": hyps,
                "claims": claims,
                "summary": summary,
                "trace": trace(
                    state,
                    "investigator",
                    f"revised chain: removed {len(bad)} hypothesis/es the Skeptic did not support "
                    f"({', '.join(sorted(bad)) or '-'})",
                    started=t,
                ),
            }

        findings = None
        if state.get("event_id") == WATCH_EVENT:
            req = state.get("request") or {}
            watch = watch_target(str(req.get("question") or ""), req.get("context"))
            if not is_watch_only(watch):
                watch = all_sources()
            hyps, claims, summary, extra, findings = _eu_watch_live(state, deps, watch)
        elif is_live(state) and has_gauges(state["event"]):
            hyps, claims, summary, extra, findings = _rhine_live(state, deps)
        elif is_live(state):
            hyps, claims, summary, extra, findings = _live_deterministic(state, deps)
        else:
            hyps, claims, summary, extra = _deterministic(state, deps)
        model_id = "deterministic"
        lane = "sql"
        link_note = ""
        drop_note = ""
        try:
            # Live: the deterministic hazard_now chain stands. A model-written
            # chain cited the empty threshold queries and lost the "nothing
            # crosses" answer; its numbers and past/forecast labels are not ours.
            got = None if findings is not None else _model(state, deps, hyps, claims, extra)
            if got:
                hyps, claims, summary, model_id, n_model, drops = got
                lane = "fast"
                link_note = f"; {n_model}/{len(hyps)} links worded by the model"
                drop_note = "".join(
                    f"; removed unrelated citation(s) from model claim {d['claim_id']} "
                    f"({', '.join(d['views'])})"
                    if d.get("kind") == "citation"
                    else f"; dropped model claim {d['claim_id']} ({d['reason']}"
                    + (f": {'; '.join(d['errors'])[:300]}" if d["errors"] else "")
                    + ")"
                    for d in drops
                )
        except Exception as e:  # the deterministic chain is complete; the model only refines it
            log.warning("investigator: model step skipped (%s)", str(e)[:140])
        doc_note = drop_note
        if deps.retrieve_docs is not None:
            request = state.get("request") or {}
            doc_query = request.get("doc_query")
            if isinstance(doc_query, str) and doc_query.strip():
                try:
                    result = deps.retrieve_docs(
                        doc_query,
                        request.get("doc_k", 4),
                        {
                            "event_id": state.get("event_id"),
                            # an insurer role lets retrieve_docs add generic insurer passages
                            "role": (request.get("context") or {}).get("role"),
                        },
                    )
                except Exception as exc:
                    doc_note += f" retrieve_docs error: {str(exc)[:200]}"
                else:
                    if result.error:
                        doc_note += f" retrieve_docs error: {result.error}"
                    elif result.citations:
                        claims, doc_evidence = _attach_documents(
                            claims, result.citations, request, doc_query
                        )
                        extra = [*extra, *doc_evidence]
        web = None
        if settings.ff_tavily and state.get("event_id") != WATCH_EVENT:
            place = ((state.get("request") or {}).get("context") or {}).get("place")
            if isinstance(place, str) and place.strip():
                web_out: dict = {}
                claims, web_ev, doc_note = _attach_web(claims, place, doc_note, web_out)
                extra = [*extra, *web_ev]
                web = web_out.get("res")
        out_live = {"live_findings": findings} if findings is not None else {}
        steps = trace(
            state,
            "investigator",
            f"{len(hyps)} hypotheses, {len(claims)} cited claims{link_note}{doc_note}"
            + (" (STALE live data)" if (findings or {}).get("stale") else ""),
            lane=lane,
            model_id=model_id,
            started=t,
            evidence_ids=[e.query_id for e in extra],
        )
        if web is not None:  # the Tavily call as its own trace entry (no key, no secrets)
            out_live["web"] = tavily_state(web)
            steps = trace({**state, "trace": steps}, "tavily", tavily_line(web), started=time.time() - web.latency_ms / 1000)
        return {
            **out_live,
            "hypotheses": [h.model_dump() for h in hyps],
            "claims": [c.model_dump() for c in claims],
            "summary": summary,
            "evidence": add_evidence(state, *extra),
            "revise_rounds": state.get("revise_rounds", 0),
            "model_ids": [*state.get("model_ids", []), model_id],
            "trace": steps,
        }

    return investigator
