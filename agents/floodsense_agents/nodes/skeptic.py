"""Skeptic. Tries to disprove each hypothesis before it is trusted.

Runs at most SKEPTIC_MAX_ROUNDS SQL counter-checks per hypothesis and marks
it supported or not_supported. Counter-checks are deterministic predicates
over fresh queries, so a verdict is reproducible and every check has a
query_id. The fast lane only writes the rationale from the same rows.
How many checks run is SKEPTIC_MAX_ROUNDS (default 3). A smoke run can set
that to 1; the node does not hardcode the cap.
"""

from __future__ import annotations

import logging
import re
import time

from floodsense_agents.governance import DEFINITIONS, IN_FOOTPRINT_SQL, OUTSIDE_FOOTPRINT_SQL
from floodsense_agents.live import GAUGE_LIVE_ROWS, LIVE_ROWS, is_live, points_sql
from floodsense_agents.models import Evidence, Hypothesis
from floodsense_agents.nightshift import map_ordered, parse_json
from floodsense_agents.events import hazard_schema
from floodsense_agents.nodes.watchers import last_complete_day, window
from floodsense_agents.prompts import SKEPTIC, SKEPTIC_WEB, rows_block
from floodsense_agents.settings import settings
from floodsense_agents.state import Deps, FloodState, add_evidence, trace

log = logging.getLogger("floodsense.skeptic")


def _footprint_checks(s: str, ev: dict | None = None) -> list[tuple[str, str, tuple[str, ...]]]:
    # exposure_join has no event column: without the event's bbox the Ahr check
    # counted Valencia's 91 footprint sites as EMSR517's.
    area = ""
    if ev and ev.get("bbox"):
        lat0, lat1, lon0, lon1 = ev["bbox"]
        area = f" AND lat BETWEEN {lat0} AND {lat1} AND lon BETWEEN {lon0} AND {lon1}"
    return [
        (
            "the footprint contains insured sites",
            f"SELECT COUNT(*) AS n FROM {s}.exposure_join WHERE {IN_FOOTPRINT_SQL}{area} HAVING "
            f"COUNT(*) >= 1",
            (),
        ),
        (
            "the footprint does not swallow every site (it is a footprint, not a region)",
            f"SELECT COUNT(*) AS n FROM {s}.exposure_join WHERE {OUTSIDE_FOOTPRINT_SQL}{area} HAVING "
            f"COUNT(*) >= 1",
            (),
        ),
        (
            "sites in the footprint carry coordinates",
            f"SELECT COUNT(*) AS n FROM {s}.exposure_join WHERE {IN_FOOTPRINT_SQL}{area} AND lat IS "
            f"NOT NULL AND lon IS NOT NULL HAVING COUNT(*) >= 1",
            (),
        ),
    ]


def _gauge_checks(s: str, found: dict) -> list[tuple[str, str, tuple[str, ...]]]:
    """The Rhine gauge hypothesis, checked against gauge_levels in its own direction."""
    stations = found.get("gauge_stations") or []
    if not stations:
        return [
            (
                "gauge_levels holds no live reading",
                f"SELECT COUNT(*) AS n FROM {s}.gauge_levels WHERE {GAUGE_LIVE_ROWS} HAVING COUNT(*) = 0",
                (),
            )
        ]
    names = ", ".join("'" + str(x).replace("'", "''") + "'" for x in stations)
    return [
        (
            "every cited station has a live reading in gauge_levels",
            f"SELECT COUNT(DISTINCT station) AS stations FROM {s}.gauge_levels WHERE "
            f"{GAUGE_LIVE_ROWS} AND station IN ({names}) HAVING COUNT(DISTINCT station) = "
            f"{len(stations)}",
            (),
        )
    ]


def _watch_checks(s: str, found: dict) -> list[tuple[str, str, tuple[str, ...]]]:
    """The Europe watch hypothesis: every cited gauge and model point is in its view."""
    checks = []
    stations = found.get("watch_stations") or []
    if stations:
        names = ", ".join("'" + str(x).replace("'", "''") + "'" for x in stations)
        checks.append(
            (
                "every cited gauge has a live reading in gauge_levels",
                f"SELECT COUNT(DISTINCT station) AS stations FROM {s}.gauge_levels WHERE "
                f"{GAUGE_LIVE_ROWS} AND station IN ({names}) HAVING COUNT(DISTINCT station) = "
                f"{len(stations)}",
                (),
            )
        )
    points = found.get("watch_points") or []
    if points:
        ids = ", ".join("'" + str(x).replace("'", "''") + "'" for x in points)
        checks.append(
            (
                "every cited model point is a row of eu_watch",
                f"SELECT COUNT(DISTINCT point_id) AS points FROM {s}.eu_watch WHERE point_id IN "
                f"({ids}) HAVING COUNT(DISTINCT point_id) = {len(points)}",
                (),
            )
        )
    return checks


def _live_checks_for(h: Hypothesis, state: FloodState) -> list[tuple[str, str, tuple[str, ...]]]:
    """Live counter-checks: the same view the claims cite (hazard_now), other predicates.

    A "nothing crosses" hypothesis is checked in its own direction: the check
    passes when the forecast maximum stays under the line, so a quiet forecast
    survives and a wrong "quiet" is caught.
    """
    s = settings.schema
    where = f"point_id IN ({points_sql(state['event'])}) AND {LIVE_ROWS}"
    found = state.get("live_findings") or {}
    rain_at = DEFINITIONS["anomaly_rain"].value
    flow_at = DEFINITIONS["anomaly_discharge"].value
    if found.get("gauge_hypothesis") == h.id:
        return _gauge_checks(s, found)
    if found.get("watch_hypothesis") == h.id:
        return _watch_checks(s, found)
    if h.link == "rain->catchment":
        direction = (
            ("forecast rain reaches the anomaly line", f">= {rain_at}")
            if found.get("rain_crosses")
            else ("forecast rain stays under the anomaly line", f"< {rain_at}")
        )
        return [
            (
                "hazard_now holds both past and forecast rows",
                f"SELECT COUNT(DISTINCT horizon) AS horizons FROM {s}.hazard_now WHERE {where} "
                f"HAVING COUNT(DISTINCT horizon) >= 2",
                (),
            ),
            (
                direction[0],
                f"SELECT MAX(rain_mm) AS max_mm FROM {s}.hazard_now WHERE {where} AND "
                f"horizon = 'forecast' HAVING MAX(rain_mm) {direction[1]}",
                (),
            ),
            (
                "rain is recorded for more than one forecast hour",
                f"SELECT COUNT(*) AS hours FROM {s}.hazard_now WHERE {where} AND "
                f"horizon = 'forecast' AND rain_mm IS NOT NULL HAVING COUNT(*) >= 2",
                (),
            ),
        ]
    if h.link == "catchment->river":
        if found.get("discharge_crosses"):
            pts = ", ".join(f"'{p}'" for p in found.get("crossing_points") or [])
            direction = [
                (
                    "the crossing point's forecast stays at or above the line for an hour or more",
                    f"SELECT point_id, COUNT(*) AS hours FROM {s}.hazard_now WHERE {where} AND "
                    f"horizon = 'forecast' AND point_id IN ({pts}) AND discharge_m3s >= "
                    f"{flow_at} GROUP BY point_id HAVING COUNT(*) >= 1",
                    (),
                ),
                (
                    "the forecast maximum at the crossing points reaches the line",
                    f"SELECT MAX(discharge_m3s) AS max_m3s FROM {s}.hazard_now WHERE {where} AND "
                    f"horizon = 'forecast' AND point_id IN ({pts}) HAVING MAX(discharge_m3s) >= "
                    f"{flow_at}",
                    (),
                ),
            ]
        else:
            direction = [
                (
                    "no point's forecast discharge reaches the anomaly line",
                    f"SELECT MAX(discharge_m3s) AS max_m3s FROM {s}.hazard_now WHERE {where} AND "
                    f"horizon = 'forecast' HAVING MAX(discharge_m3s) < {flow_at}",
                    (),
                ),
            ]
        return [
            (
                "forecast discharge is present for the event's points",
                f"SELECT COUNT(*) AS n FROM {s}.hazard_now WHERE {where} AND horizon = "
                f"'forecast' AND discharge_m3s IS NOT NULL HAVING COUNT(*) >= 1",
                (),
            ),
            *direction,
        ]
    if h.link == "river->site":
        return _footprint_checks(s)
    return []


def _checks_for(h: Hypothesis, state: FloodState) -> list[tuple[str, str, tuple[str, ...]]]:
    """(name, sql): each query must return >= 1 row for the check to pass."""
    found = state.get("live_findings") or {}
    if found.get("watch_hypothesis") == h.id:
        return _watch_checks(settings.schema, found)
    if is_live(state):
        return _live_checks_for(h, state)
    es, ev = settings.schema, state["event"]
    # Hazard counter-checks read the views the claims cite: the replay schema.
    s = hazard_schema(ev, es)
    t0, t1 = window(state)
    clock = (t0, t1)
    day = (t0[:10], last_complete_day(t1))
    rain_pts = ", ".join(f"'{p}'" for p in ev["rain_points"])
    river_pts = ", ".join(f"'{p}'" for p in ev["river_points"])
    if h.link == "rain->catchment":
        return [
            (
                # Hourly or window total: ERA5 hourly rain is smoothed (Ahr 2021:
                # 5.6-18.5 mm/h) while the day sums 45-108 mm.
                f"{DEFINITIONS['extreme_rain'].wording} {DEFINITIONS['extreme_rain_total'].wording}",
                f"SELECT point_id, MAX(rain_mm) AS max_mm, SUM(rain_mm) AS total_mm FROM "
                f"{s}.hazard_timeline WHERE point_id "
                f"IN ({rain_pts}) AND ts_utc BETWEEN ? AND ? GROUP BY point_id HAVING "
                f"MAX(rain_mm) >= {DEFINITIONS['extreme_rain'].value} OR SUM(rain_mm) >= "
                f"{DEFINITIONS['extreme_rain_total'].value}",
                clock,
            ),
            (
                "rain lasted more than one hour",
                f"SELECT point_id, COUNT(*) AS hours FROM {s}.hazard_timeline WHERE point_id IN "
                f"({rain_pts}) AND rain_mm > 0 AND ts_utc BETWEEN ? AND ? GROUP BY "
                f"point_id HAVING COUNT(*) >= 2",
                clock,
            ),
            (
                "rain started before the observed discharge peak (or before now while rising)",
                # Reference time: peak_ts, the ts of the highest discharge row in the
                # clocked window (argmax; ties take the earliest). If that row is also the
                # latest non-null discharge row, the river is still rising (or the gauge
                # stopped at its peak) and no fall is observed, so the reference is t1,
                # the clock. No discharge row at all: t1 as well. Daily 00:00 rows are not
                # read here; only hourly hazard_timeline rows with a discharge value count.
                # Passes iff first rain <= reference. Placeholders in text order:
                #   rain window (t0, t1), CASE fallback t1, peak window (t0, t1),
                #   latest window (t0, t1), COALESCE fallback t1.
                f"SELECT MIN(r.ts_utc) AS first_rain FROM {s}.hazard_timeline r WHERE "
                f"r.point_id IN ({rain_pts}) AND r.rain_mm > 0 AND r.ts_utc BETWEEN ? AND ? "
                f"HAVING MIN(r.ts_utc) <= COALESCE((SELECT CASE WHEN p.ts_utc < l.last_ts THEN "
                f"p.ts_utc ELSE ? END FROM (SELECT ts_utc FROM {s}.hazard_timeline WHERE "
                f"point_id IN ({river_pts}) AND discharge_m3s IS NOT NULL AND ts_utc BETWEEN ? AND ? "
                f"ORDER BY discharge_m3s DESC, ts_utc ASC LIMIT 1) p, (SELECT MAX(ts_utc) AS last_ts "
                f"FROM {s}.hazard_timeline WHERE point_id IN ({river_pts}) AND discharge_m3s IS NOT "
                f"NULL AND ts_utc BETWEEN ? AND ?) l), ?)",
                clock + (t1,) + clock + clock + (t1,),
            ),
        ]
    if h.link == "catchment->river":
        rise = DEFINITIONS["extreme_discharge_rise"].value
        flow_at = DEFINITIONS["anomaly_discharge"].value
        return [
            (
                # Hourly or daily. hazard_timeline repeats the day's GloFAS value per
                # hour and the Ahr extract starts on 13 Jul, mid-rise (28 -> 250 m3/s);
                # discharge_daily starts before the event (6.9 m3/s on 12 Jul).
                DEFINITIONS["extreme_discharge_rise"].wording,
                f"SELECT 'hourly' AS series, MAX(discharge_m3s) AS mx, MIN(discharge_m3s) AS mn "
                f"FROM {s}.hazard_timeline WHERE point_id IN ({river_pts}) AND discharge_m3s IS "
                f"NOT NULL AND ts_utc BETWEEN ? AND ? HAVING MAX(discharge_m3s) >= {rise} * "
                f"MIN(discharge_m3s) UNION ALL SELECT 'daily' AS series, MAX(discharge_m3s) AS mx, "
                f"MIN(discharge_m3s) AS mn FROM {s}.discharge_daily WHERE point_id IN "
                f"({river_pts}) AND date BETWEEN ? AND ? HAVING MAX(discharge_m3s) >= {rise} * "
                f"MIN(discharge_m3s)",
                clock + day,
            ),
            (
                "the river point reaches the anomaly line (discharge >= 100 m3/s)",
                f"SELECT point_id, MAX(discharge_m3s) AS mx FROM {s}.hazard_timeline WHERE "
                f"point_id IN ({river_pts}) AND ts_utc BETWEEN ? AND ? GROUP BY point_id "
                f"HAVING MAX(discharge_m3s) >= {flow_at}",
                clock,
            ),
            (
                "a warning was issued for the river point",
                f"SELECT point_id, MIN(ts_utc) AS first_utc FROM {s}.hazard_timeline WHERE "
                f"point_id IN ({river_pts}) AND warning_level IS NOT NULL AND ts_utc BETWEEN "
                f"? AND ? GROUP BY point_id",
                clock,
                # Skip probe: reanalysis views (GloFAS / ERA5, migrations 051/052)
                # carry no warnings at all, so the check cannot apply. A row here
                # means skip; a skipped check is recorded and is not support.
                (
                    "the view carries no warnings in the window",
                    f"SELECT COUNT(*) AS n FROM {s}.hazard_timeline WHERE ts_utc BETWEEN ? AND ? "
                    f"AND warning_level IS NOT NULL HAVING COUNT(*) = 0",
                    clock,
                ),
            ),
        ]
    if h.link == "river->site":
        return _footprint_checks(es, ev)
    return []


def _generic_ok(h: Hypothesis, state: FloodState) -> tuple[bool, str]:
    """Every claim of the hypothesis must cite at least one layer-(a) query that returned rows."""
    if not h.citations:
        return False, "hypothesis has no claims"
    ev = state["evidence"]
    live = is_live(state)
    for c in state["claims"]:
        if c["claim_id"] in h.citations:
            qids = [
                x["query_id"] for x in c["citations"] if x["layer"] == "a" and x.get("query_id")
            ]
            # Live: an answered hazard_now threshold query with no rows is the
            # evidence for "nothing crosses". Only an errored or missing query is not.
            if (
                live
                and qids
                and any(
                    q in ev and not ev[q].get("error") and "hazard_now" in str(ev[q].get("view"))
                    for q in qids
                )
            ):
                continue
            if not qids or not any(ev.get(q, {}).get("row_count", 0) > 0 for q in qids):
                return False, f"claim {c['claim_id']} cites no query with rows"
    return True, ""


def _rationale(deps: Deps, prompt: str) -> tuple[str, str] | None:
    """(rationale text or '', model_id) from the fast lane, or None if the call failed."""
    try:
        text, model_id = deps.llm.complete("fast", SKEPTIC, prompt)
    except Exception as e:
        log.debug("skeptic: model rationale skipped (%s)", str(e)[:100])
        return None
    try:
        js = parse_json(text)
    except Exception as e:
        log.debug("skeptic: model rationale skipped (%s)", str(e)[:100])
        return "", model_id
    return (str(js["rationale"])[:240] if js.get("rationale") else ""), model_id


_TIMING = re.compile(r"\b(warn\w*|alert\w*|status|issued|timing)\b", re.I)


def _web_prompt(claim: dict, items: list[dict]) -> str:
    """Claim plus web snippets as quoted data. URL percent-encoded, title and text cleaned."""
    from urllib.parse import quote

    from floodsense_agents.tavily import clean

    rows = "\n".join(
        f'WEB {n} url={quote(i["url"], safe=":/?&=%#@~+,;-._")[:200]} '
        f'title="{clean(i["title"], 80)}": "{clean(i["text"], 300)}"'
        for n, i in enumerate(items, 1)
    )
    return f"CLAIM {claim['claim_id']}: {claim['text']}\n{rows}"


def _web_check(deps: Deps, state: FloodState) -> dict | None:
    """Does web context support or contradict ONE alert-timing/status claim? Silent when off.

    Web text is fenced untrusted data. The result is context only: it never changes a
    hypothesis verdict and the web is not an official warning.
    """
    items = (state.get("web") or {}).get("items") or []
    claims = [c for c in state.get("claims", []) if not str(c.get("claim_id", "")).startswith("C-web-")]
    if not (settings.ff_tavily and items and claims):
        return None
    claim = next((c for c in claims if _TIMING.search(c.get("text", ""))), claims[0])
    try:
        text, _ = deps.llm.complete("fast", SKEPTIC_WEB, _web_prompt(claim, items))
        js = parse_json(text)
        if not isinstance(js, dict):
            return None
    except Exception as e:
        log.debug("skeptic: web check skipped (%s)", str(e)[:100])
        return None
    url = str(js.get("url") or "")
    if js.get("verdict") not in ("supports", "contradicts", "neutral") or url not in {i["url"] for i in items}:
        return None
    return {
        "claim_id": claim["claim_id"],
        "verdict": js["verdict"],
        "url": url,
        "note": str(js.get("note") or "")[:160],
        "label": "Web context, not an official warning",
    }


def make(deps: Deps):
    def skeptic(state: FloodState) -> dict:
        t = time.time()
        hyps = [Hypothesis(**h) for h in state["hypotheses"]]
        new_ev: list[Evidence] = []
        model_id = None
        prompts: list[str] = []
        for h in hyps:
            ok, why = _generic_ok(h, state)
            rounds, qids, notes = 0, [], []
            checks = _checks_for(h, state)[: settings.skeptic_max_rounds] if ok else []
            passed_n = skipped_n = 0
            if ok:
                for name, sql, params, *probe in checks:
                    if probe:
                        why_skip, skip_sql, skip_params = probe[0]
                        p = deps.zetaris.run_sql(skip_sql, skip_params or None)
                        new_ev.append(p)
                        qids.append(p.query_id)
                        if p.error:
                            notes.append(f"probe error ({name}): {p.error}")
                        elif p.row_count >= 1:
                            skipped_n += 1
                            notes.append(f"skipped: {name} ({why_skip})")
                            continue
                    rounds += 1
                    e = deps.zetaris.run_sql(sql, params or None)
                    new_ev.append(e)
                    qids.append(e.query_id)
                    passed = e.row_count >= 1 and not e.error
                    notes.append(
                        f"{'ok' if passed else 'FAILED'}: {name}"
                        + (f" (query error: {e.error})" if e.error else "")
                    )
                    passed_n += int(passed)
                    if not passed:
                        ok, why = False, f"counter-check failed: {name}"
                        break
            verdict = "supported" if ok else "not_supported"
            rationale = why or "; ".join(notes)
            # No counter-check ran, so nothing was tested: the hypothesis stays
            # proposed. Live mode never rejects without a failed check.
            if ok and not checks:
                verdict, rationale = "proposed", "unchecked: no counter-check applies to this link"
            elif ok and passed_n == 0 and skipped_n:
                # Skipped checks are not support.
                verdict, rationale = (
                    "proposed",
                    "unchecked: every counter-check was skipped; " + rationale,
                )
            elif not ok and rounds == 0 and is_live(state):
                verdict, rationale = "proposed", f"unchecked: {why}"
            prompt = (
                f"HYPOTHESIS {h.id} ({h.link}): {h.statement}\nCOUNTER-CHECKS:\n"
                f"{rows_block(new_ev[-len(qids) :] if qids else [])}\nDETERMINISTIC RESULT: "
                f"{verdict} ({rationale})"
            )
            h.status, h.rounds, h.evidence, h.rationale = verdict, rounds, qids, rationale
            prompts.append(prompt)
        # Optional model rationales from the same rows: one call per hypothesis,
        # concurrently. Applied in hypothesis order, so the output is the same
        # as the serial loop; model_id is the last call that answered.
        for h, reply in zip(hyps, map_ordered(lambda p: _rationale(deps, p), prompts)):
            if reply is None:
                continue
            extra, model_id = reply
            if extra:
                h.rationale = f"{h.rationale} | model: {extra}"
        n_bad = sum(1 for h in hyps if h.status == "not_supported")
        wc = _web_check(deps, state)
        web_note = f"; web_check {wc['verdict']} {wc['claim_id']} {wc['url']}" if wc else ""
        return {
            **({"web_check": wc} if wc else {}),
            "hypotheses": [h.model_dump() for h in hyps],
            "evidence": add_evidence(state, *new_ev),
            "trace": trace(
                state,
                "skeptic",
                f"{len(hyps) - n_bad} supported, {n_bad} not supported after {len(new_ev)} "
                f"counter-check queries{web_note}",
                lane="sql",
                model_id=model_id,
                started=t,
                evidence_ids=[e.query_id for e in new_ev],
            ),
        }

    return skeptic


def route_after_skeptic(state: FloodState) -> str:
    bad = any(h.get("status") == "not_supported" for h in state["hypotheses"])
    return "revise" if bad and state.get("revise_rounds", 0) < 1 else "exposure"


def bump_revise(state: FloodState) -> dict:
    return {
        "revise_rounds": state.get("revise_rounds", 0) + 1,
        "trace": trace(state, "skeptic", "revise edge -> investigator"),
    }
