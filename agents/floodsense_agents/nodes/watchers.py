"""Watchers. Deterministic SQL over the contract views.

Scans the event window, cut at replay_ts, so the Investigator starts from
anomalies that each carry a query_id. Reads gauge_levels for that window
when the event lists stations, and loads the provenance view once for
layer (b) citations. An event with no stations skips the gauge query.
Gauge rows stay evidence. They are not a new anomaly kind. No model call.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta

from floodsense_agents.events import hazard_schema
from floodsense_agents.governance import DEFINITIONS
from floodsense_agents.live import (
    GAUGE_LIVE_ROWS,
    LIVE_ROWS,
    focus,
    horizon_word,
    is_live,
    points_sql,
)
from floodsense_agents.models import Anomaly, normalize_utc
from floodsense_agents.settings import settings
from floodsense_agents.state import Deps, FloodState, add_evidence, trace
from floodsense_agents.zetaris import run_sql_parallel


def last_complete_day(end_utc: str) -> str:
    """The last date whose daily aggregate is actually known at end_utc.

    S2: discharge_daily was filtered with end[:10], so a replay standing at
    noon read that whole day's total, which nobody had yet. A daily value is
    known once the day is over.
    """
    date, _, clock = end_utc.partition("T")
    if clock.rstrip("Z") >= "23:59":
        return date
    day = datetime.strptime(date, "%Y-%m-%d") - timedelta(days=1)
    return day.strftime("%Y-%m-%d")


def window(state: FloodState) -> tuple[str, str]:
    """The event window, cut at the replay clock.

    The clock is re-checked here because these values are interpolated into
    SQL predicates, and state can be resumed from a checkpoint written by an
    older build.
    """
    ev = state["event"]
    try:
        end = normalize_utc(str(state.get("replay_ts") or ev["window_to_utc"]))
        start = normalize_utc(str(ev["window_from_utc"]))
        cap = normalize_utc(str(ev["window_to_utc"]))
    except ValueError as e:
        raise ValueError(f"replay_ts is not a UTC instant: {state.get('replay_ts')!r}") from e
    return start, min(end, cap)


def _why(wording: str, row: dict, live: bool) -> str:
    """Event mode keeps the definition's wording. Live says past or forecast, and when."""
    if not live:
        return wording
    ts = row.get("ts_utc") or row.get("first_utc")
    return f"{wording}; {horizon_word(row.get('horizon'))} at {ts}"


def make(deps: Deps):
    def watchers(state: FloodState) -> dict:
        t = time.time()
        s = settings.schema
        rain_at = DEFINITIONS["anomaly_rain"]
        flow_at = DEFINITIONS["anomaly_discharge"]
        total_at = DEFINITIONS["anomaly_rain_total"]
        live = is_live(state)
        # The replay's hazard rows: floodsense_seed for the Ahr even when live data is on.
        hs = hazard_schema(state["event"], s)
        # The user's selection (context), mapped to known ids only.
        fx = focus(state)
        at_point = f" AND point_id = '{fx['point_id']}'" if fx["point_id"] else ""
        at_station = f" AND station = '{fx['station']}'" if fx["station"] else ""
        if live:
            # hazard_now is a rolling window (past ~3 days, forecast ~48 h).
            # No clock predicate: the view already is "now". Same thresholds.
            pts = points_sql(state["event"], fx["point_id"])
            t0, t1 = "now-past", "now+forecast"
            live_q = {
                "rain": (
                    f"SELECT point_id, ts_utc, rain_mm, horizon FROM {s}.hazard_now WHERE "
                    f"point_id IN ({pts}) AND {LIVE_ROWS} AND rain_mm >= {rain_at.value} ORDER BY rain_mm DESC",
                    None,
                ),
                "discharge": (
                    f"SELECT point_id, ts_utc, discharge_m3s, horizon FROM {s}.hazard_now WHERE "
                    f"point_id IN ({pts}) AND {LIVE_ROWS} AND discharge_m3s >= {flow_at.value} "
                    f"ORDER BY discharge_m3s DESC",
                    None,
                ),
                "warning": (
                    f"SELECT point_id, MIN(ts_utc) AS first_utc, warning_level, horizon FROM "
                    f"{s}.hazard_now WHERE point_id IN ({pts}) AND {LIVE_ROWS} AND warning_level IS NOT NULL "
                    f"GROUP BY point_id, warning_level, horizon ORDER BY first_utc",
                    None,
                ),
            }
        else:
            t0, t1 = window(state)
        clock = (t0, t1)
        q = (
            live_q
            if live
            else {
                "rain": (
                    f"SELECT point_id, ts_utc, rain_mm FROM {hs}.hazard_timeline WHERE ts_utc "
                    f"BETWEEN ? AND ? AND rain_mm >= {rain_at.value}{at_point} ORDER BY rain_mm DESC",
                    clock,
                ),
                # A long storm under the hourly line (Ahr 2021): the window total per point.
                "rain_total": (
                    f"SELECT point_id, SUM(rain_mm) AS total_mm, MIN(ts_utc) AS first_utc FROM "
                    f"{hs}.hazard_timeline WHERE ts_utc BETWEEN ? AND ? AND rain_mm > 0{at_point} "
                    f"GROUP BY point_id HAVING SUM(rain_mm) >= {total_at.value} ORDER BY total_mm DESC",
                    clock,
                ),
                "discharge": (
                    f"SELECT point_id, ts_utc, discharge_m3s FROM {hs}.hazard_timeline WHERE "
                    f"ts_utc BETWEEN ? AND ? AND discharge_m3s >= {flow_at.value}{at_point} "
                    f"ORDER BY discharge_m3s DESC",
                    clock,
                ),
                "warning": (
                    f"SELECT point_id, MIN(ts_utc) AS first_utc, warning_level FROM "
                    f"{hs}.hazard_timeline "
                    f"WHERE ts_utc BETWEEN ? AND ? "
                    f"AND warning_level IS NOT NULL{at_point} GROUP BY point_id, warning_level "
                    f"ORDER BY first_utc",
                    clock,
                ),
            }
        )
        # Valencia lists none. The Ahr lists the Rhine gauges between Koblenz and Bonn.
        if state["event"].get("gauges") and live:
            # The Rhine right now: live PEGELONLINE rows only, newest first.
            q["gauges"] = (
                f"SELECT station, water, ts_utc, level_cm, source FROM {s}.gauge_levels "
                f"WHERE {GAUGE_LIVE_ROWS}{at_station} ORDER BY ts_utc DESC, station",
                None,
            )
        elif state["event"].get("gauges"):
            q["gauges"] = (
                f"SELECT station, water, ts_utc, level_cm, source FROM {s}.gauge_levels "
                f"WHERE ts_utc BETWEEN ? AND ? ORDER BY station, ts_utc",
                clock,
            )
        # View queries, in dict order, then provenance. None of them depend
        # on another, so they run together. Evidence order follows this list.
        ordered = [
            *q.items(),
            (
                "provenance",
                (
                    f"SELECT dataset, source_url, publisher, licence, attribution, fetched_at FROM "
                    f"{s}.provenance",
                    None,
                ),
            ),
        ]
        ran = run_sql_parallel(deps.zetaris, [job for _name, job in ordered])
        by_name = {name: evidence for (name, _job), evidence in zip(ordered, ran)}
        evid = {name: by_name[name] for name in q}
        prov = by_name["provenance"]
        items: list[Anomaly] = []
        for r in evid["rain"].rows_sample[:5]:
            items.append(
                Anomaly(
                    id=f"A{len(items) + 1}",
                    kind="rain",
                    point_id=r["point_id"],
                    ts_utc=r["ts_utc"],
                    value=r["rain_mm"],
                    unit="mm/h",
                    why=_why(rain_at.wording, r, live),
                    horizon=r.get("horizon") if live else None,
                    query_id=evid["rain"].query_id,
                )
            )
        hourly = {r["point_id"] for r in evid["rain"].rows_sample[:5]}
        total_rows = evid["rain_total"].rows_sample[:3] if "rain_total" in evid else []
        for r in total_rows:
            if r["point_id"] in hourly:
                continue  # already flagged by the hourly line
            items.append(
                Anomaly(
                    id=f"A{len(items) + 1}",
                    kind="rain",
                    point_id=r["point_id"],
                    ts_utc=r["first_utc"],
                    value=r["total_mm"],
                    unit="mm",
                    why=total_at.wording,
                    query_id=evid["rain_total"].query_id,
                )
            )
        for r in evid["discharge"].rows_sample[:3]:
            items.append(
                Anomaly(
                    id=f"A{len(items) + 1}",
                    kind="discharge",
                    point_id=r["point_id"],
                    ts_utc=r["ts_utc"],
                    value=r["discharge_m3s"],
                    unit="m3/s",
                    why=_why(flow_at.wording, r, live),
                    horizon=r.get("horizon") if live else None,
                    query_id=evid["discharge"].query_id,
                )
            )
        for r in evid["warning"].rows_sample:
            items.append(
                Anomaly(
                    id=f"A{len(items) + 1}",
                    kind="warning",
                    point_id=r["point_id"],
                    ts_utc=r["first_utc"],
                    why=_why(f"warning level {r['warning_level']}", r, live),
                    horizon=r.get("horizon") if live else None,
                    query_id=evid["warning"].query_id,
                )
            )
        return {
            "anomalies": [i.model_dump() for i in items],
            "evidence": add_evidence(state, *evid.values(), prov),
            "provenance": prov.rows_sample,
            "status": "running",
            "trace": trace(
                state,
                "watchers",
                (
                    f"live: {len(items)} anomalies in hazard_now past + forecast "
                    f"({len(evid)} view queries)"
                    if live
                    else f"{len(items)} anomalies in window {t0[:16]}..{t1[:16]} "
                    f"({len(evid)} view queries)"
                ),
                lane="sql",
                started=t,
                evidence_ids=[e.query_id for e in evid.values()],
            ),
        }

    return watchers
