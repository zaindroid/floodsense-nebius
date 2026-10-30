"""Zetaris is the only data path for agents.

`run_sql(sql) -> Evidence` is the single call every node uses, and the Evidence
it returns is the layer (a) citation.

Live  POST {ZETARIS_REST_URL}/sql-editor/sqls/run, the only documented call
      (zetaris/README.md). SELECT and WITH only; nothing else leaves here.
Fake  the same views as in-memory SQLite, so the graph, the tests and the UI
      run without Zetaris. The rows below are SEED DATA: approximate figures
      from public reporting plus a synthetic portfolio, pending real migrations.

Views, as in the contract; schema floodsense_seed.* or floodsense.* via
FF_LIVE_DATA (default false):
  hazard_timeline(point_id, ts_utc, rain_mm, discharge_m3s, warning_level)
  discharge_daily(point_id, date, discharge_m3s, source)
  exposure_join(policy_id, site_id, lat, lon, in_footprint, sum_insured_eur, segment)
  gauge_levels(station, water, ts_utc, level_cm, source)
  provenance(dataset, source_url, publisher, licence, attribution, fetched_at)
The nodes use nothing else, so switching to the live views is FF_LIVE_DATA plus credentials.
"""

from __future__ import annotations

import asyncio
import logging
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Protocol, Sequence

import httpx

from floodsense_agents.watch import EU_POINTS
from floodsense_agents.events import EVENTS, VALENCIA_POINT_IDS
from floodsense_agents.models import Evidence
from floodsense_agents.settings import settings

log = logging.getLogger("floodsense.zetaris")
_SELECT_ONLY = re.compile(r"^\s*(select|with)\b", re.I)
# Starting with SELECT or WITH is not enough: a WITH that then mutates got
# past the old guard and emptied a table on the fake. Refuse anything that
# could write, and anything carrying a second statement.
_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|"
    r"pragma|vacuum|grant|revoke|reindex|begin|commit|rollback)\b",
    re.I,
)


def check_sql(sql: str) -> str:
    """The one place that decides whether the agents may run a statement."""
    text = (sql or "").strip()
    while text.endswith(";"):
        text = text[:-1].strip()
    if not _SELECT_ONLY.match(text):
        raise ValueError("agents may only run SELECT / WITH statements")
    if ";" in text:
        raise ValueError("one statement per query; ';' is not allowed")
    if _FORBIDDEN.search(text):
        raise ValueError("agents may only read; this statement could write")
    return text


_VIEW = re.compile(r"\b(?:from|join)\s+([A-Za-z_][\w.]*)", re.I)


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _view_of(sql: str) -> str:
    m = _VIEW.search(sql)
    return m.group(1) if m else "?"


# Bound clocks only. A replay timestamp is normalised before it gets here,
# and a date is the YYYY-MM-DD prefix of one. Anything else is refused.
_BOUND = re.compile(r"^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z|\d{4}-\d{2}-\d{2})$")


def inline_bound(
    sql: str, params: tuple[str, ...] | list[str] | None
) -> tuple[str, tuple[str, ...]]:
    """Split a statement into the placeholder form and a rendered copy.

    SQLite runs the placeholder form with the tuple. The live SQL API has no
    parameter channel, so it receives the rendered copy. Rendering quotes only
    values that already match the clock or date pattern, so a replay clock
    cannot change the statement.
    """
    bound = tuple(params or ())
    if not bound:
        if "?" in sql:
            raise ValueError("sql has placeholders but no parameters")
        return sql, ()
    for value in bound:
        if not isinstance(value, str) or not _BOUND.fullmatch(value):
            raise ValueError("bound parameters must be normalised UTC instants or dates")
    parts = sql.split("?")
    if len(parts) != len(bound) + 1:
        raise ValueError("placeholder count does not match parameters")
    rendered: list[str] = []
    for part, value in zip(parts, bound):
        rendered.append(part)
        rendered.append("'" + value + "'")
    rendered.append(parts[-1])
    return "".join(rendered), bound


class Zetaris(Protocol):
    def run_sql(
        self, sql: str, params: tuple[str, ...] | None = None, sample: int = 20
    ) -> Evidence: ...


def _failed_evidence(sql: str, exc: BaseException) -> Evidence:
    """A job that raised, in the same shape as a query Zetaris could not run."""
    return Evidence(
        query_id=str(uuid.uuid4()),
        view=_view_of(sql),
        sql=sql,
        rows_sample=[],
        row_count=0,
        executed_at_utc=now_utc(),
        error=str(exc)[:300],
    )


def run_sql_parallel(
    client: Zetaris,
    jobs: Sequence[tuple[str, tuple[str, ...] | None]],
) -> list[Evidence]:
    """Run independent SELECTs together. Result order matches ``jobs``.

    Each job is the same ``run_sql`` a node would call on its own.
    ``asyncio.gather`` starts them together, up to ``ZETARIS_MAX_PARALLEL``
    at once (``1`` runs them one after another). The graph calls this from a
    sync node, so this function owns the loop. If a loop is already running,
    the gather moves to a worker thread and does not deadlock that loop.

    A job that raises becomes ``Evidence.error`` and does not cancel the
    others. A sequential loop would have stopped, but the siblings are
    already started, and the graph already treats a failed query as evidence
    with ``error`` set. ``KeyboardInterrupt`` still propagates.
    """

    async def _all() -> list[Evidence]:
        limit = max(1, int(settings.zetaris_max_parallel))
        gate = asyncio.Semaphore(limit)

        async def _one(sql: str, params: tuple[str, ...] | None) -> Evidence:
            # Omit a missing parameter tuple. Callers that override run_sql(sql)
            # (the exposure string-coerce tests) still run.
            async with gate:
                if params:
                    return await asyncio.to_thread(client.run_sql, sql, params)
                return await asyncio.to_thread(client.run_sql, sql)

        raw = await asyncio.gather(
            *(_one(sql, params) for sql, params in jobs),
            return_exceptions=True,
        )
        out: list[Evidence] = []
        for (sql, _params), item in zip(jobs, raw):
            if isinstance(item, Exception):
                out.append(_failed_evidence(sql, item))
            else:
                out.append(item)
        return out

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_all())

    box: list[list[Evidence]] = []
    error: list[BaseException] = []

    def _in_thread() -> None:
        try:
            box.append(asyncio.run(_all()))
        except BaseException as exc:
            error.append(exc)

    worker = threading.Thread(target=_in_thread, name="zetaris-parallel")
    worker.start()
    worker.join()
    if error:
        raise error[0]
    return box[0]


class ZetarisClient:
    def __init__(self) -> None:
        self.rest = (settings.zetaris_rest_url or "").rstrip("/")
        self._token: str | None = settings.zetaris_api_key
        self._token_lock = threading.Lock()

    def _login(self) -> str:
        if settings.zetaris_api_key:
            return settings.zetaris_api_key
        with self._token_lock:
            if self._token:
                return self._token
            r = httpx.get(
                f"{self.rest}/auth/login",
                auth=(settings.zetaris_user or "", settings.zetaris_password or ""),
                headers={"X-Org-ID": settings.zetaris_org_id, "X-Request-ID": str(uuid.uuid4())},
                timeout=30,
            )
            r.raise_for_status()
            self._token = r.json()["idToken"]
            return self._token

    def run_sql(
        self, sql: str, params: tuple[str, ...] | None = None, sample: int = 20
    ) -> Evidence:
        # sample: how many rows Evidence keeps. Nodes keep 20; GET /views keeps more.
        # A write is refused here, as an exception, before any request goes out.
        sql = check_sql(sql)
        qid = str(uuid.uuid4())
        try:
            sql, _bound = inline_bound(sql, params)
            sql = check_sql(sql)
        except ValueError as e:
            return Evidence(
                query_id=qid,
                view=_view_of(sql),
                sql=sql,
                rows_sample=[],
                row_count=0,
                executed_at_utc=now_utc(),
                error=str(e)[:300],
            )
        body = {
            "queryId": qid,
            "sql": sql,
            "limit": settings.zetaris_row_limit,
            "source": "SqlEditor",
        }
        try:
            for attempt in (0, 1):
                token = self._token or self._login()
                # TODO: a shared httpx.Client would reuse connections across the
                # parallel fan-out. Left per call so one stuck socket does not
                # pin the process.
                r = httpx.post(
                    f"{self.rest}/sql-editor/sqls/run",
                    json=body,
                    timeout=180,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "X-Org-ID": settings.zetaris_org_id,
                        "X-Request-ID": str(uuid.uuid4()),
                    },
                )
                if attempt == 0 and not settings.zetaris_api_key and r.status_code in (401, 403):
                    # Another call may already have logged in with a new token.
                    # Clear only the token this request presented.
                    with self._token_lock:
                        if self._token == token:
                            self._token = None
                    continue
                if not r.is_success:
                    raise RuntimeError(f"Zetaris HTTP {r.status_code}: {r.text[:300]}")
                break
            rows = self._rows(r.json())
            return Evidence(
                query_id=qid,
                view=_view_of(sql),
                sql=sql,
                rows_sample=rows[:sample],
                row_count=len(rows),
                executed_at_utc=now_utc(),
            )
        except Exception as e:
            log.warning("zetaris query failed: %s", str(e)[:200])
            return Evidence(
                query_id=qid,
                view=_view_of(sql),
                sql=sql,
                rows_sample=[],
                row_count=0,
                executed_at_utc=now_utc(),
                error=str(e)[:300],
            )

    @staticmethod
    def _rows(js) -> list[dict]:
        if isinstance(js, dict) and "data" in js:
            cols = [
                c["name"] if isinstance(c, dict) else c
                for c in (js.get("headers") or js.get("columns") or [])
            ]
            return [dict(zip(cols, r)) if isinstance(r, list) else r for r in js["data"]]
        if isinstance(js, dict) and "rows" in js:
            return js["rows"]
        return js if isinstance(js, list) else []


# Fake Zetaris: the contract views in SQLite. ATTACH gives the
# floodsense_seed.<view> names, so the nodes' SQL is identical.
# in_footprint is INTEGER because SQLite stores TRUE as 1. The warehouse
# column is boolean, so the predicate is `= TRUE`, not `= 1`.
_DDL = """
CREATE TABLE {s}.hazard_timeline(point_id TEXT, ts_utc TEXT, rain_mm REAL, discharge_m3s REAL, warning_level TEXT);
CREATE TABLE {s}.hazard_now(point_id TEXT, ts_utc TEXT, rain_mm REAL, discharge_m3s REAL, warning_level TEXT, horizon TEXT);
CREATE TABLE {s}.discharge_daily(point_id TEXT, date TEXT, discharge_m3s REAL, source TEXT);
CREATE TABLE {s}.exposure_join(policy_id TEXT, site_id TEXT, lat REAL, lon REAL, in_footprint INTEGER, sum_insured_eur REAL, segment TEXT);
CREATE TABLE {s}.gauge_levels(station TEXT, water TEXT, ts_utc TEXT, level_cm REAL, source TEXT);
CREATE TABLE {s}.eu_watch(point_id TEXT, name TEXT, country TEXT, river TEXT, lat REAL, lon REAL, discharge_m3s REAL, forecast_max_m3s REAL, past30_median_m3s REAL, band TEXT, basis TEXT, source TEXT, as_of_date TEXT);
CREATE TABLE {s}.weather_forecast(point_id TEXT, kind TEXT, name TEXT, river TEXT, lat REAL, lon REAL, lead_h INTEGER, ts_utc TEXT, precip_mm REAL, model TEXT, source TEXT);
CREATE TABLE {s}.provenance(dataset TEXT, source_url TEXT, publisher TEXT, licence TEXT, attribution TEXT, fetched_at TEXT);
"""


def _gauge_seed_rows() -> list[tuple]:
    """One row per station on each event that lists gauges. level_cm stays empty.

    The station names are EventSpec.gauges, which for the Ahr is RHINE_GAUGES.
    Events with an empty list contribute nothing. There is no second copy of
    the station names here.
    """
    rows: list[tuple] = []
    for event in EVENTS.values():
        for station, water in event.gauges:
            rows.append((station, water, event.window_from_utc, None, "seed:pegelonline"))
    return rows


# Valencia 29 Oct 2024 (seed, approximate), stored under the warehouse point
# ids. Chiva is VAL07. Paiporta on the Barranco del Poyo is VAL01. Turís is
# not on ingestion/prep/valencia_points.csv, so it is not a row. AEMET reported
# ~491 mm in ~8 h at Chiva; CHJ estimated the Poyo ravine peak above 2,000 m3/s
# around 17:55 UTC, with the sensor failing after 1,686 m3/s at 16:45 UTC;
# AEMET red warning 06:30 UTC; ES-Alert to phones 19:11 UTC.
# Ahr 2021, under AHR01 (Altenahr) and AHR02 (Ahrweiler): Altenahr > 5.7 m on
# 14 Jul evening, gauge failed; DWD 100-150 mm / 24 h; discharge estimated
# ~1,000 m3/s. floodsense_seed hazard views do not hold these rows.
# in_footprint is 1 or 0 because SQLite stores TRUE as 1. The warehouse column
# is boolean. Queries use in_footprint = TRUE / FALSE (governance).
_VAL_RIVER = EVENTS["EMSR773"].river_points[0]
_VAL_RAIN = EVENTS["EMSR773"].rain_points[0]
_AHR_RIVER = EVENTS["EMSR517"].river_points[0]
_AHR_RAIN = EVENTS["EMSR517"].rain_points[0]
_CHIVA = [
    (9, 18),
    (10, 35),
    (11, 52),
    (12, 70),
    (13, 88),
    (14, 96),
    (15, 74),
    (16, 58),
    (17, 31),
    (18, 12),
]
_POYO = [(12, 6), (13, 9), (14, 40), (15, 310), (16, 1686), (17, 2282), (18, None)]
_SEED = {
    "hazard_timeline": [
        (_VAL_RAIN, f"2024-10-29T{h:02d}:00:00Z", mm, None, "red" if h >= 7 else None)
        for h, mm in _CHIVA
    ]
    + [
        (_VAL_RIVER, f"2024-10-29T{h:02d}:00:00Z", None, q, "es-alert" if h >= 19 else None)
        for h, q in _POYO
    ]
    + [(_VAL_RIVER, "2024-10-29T19:11:00Z", None, None, "es-alert")]
    + [
        # 13:00: the rain was under way before 14:00, so a 15:00 replay sees two hours.
        (_AHR_RAIN, "2021-07-14T13:00:00Z", 12.0, None, None),
        (_AHR_RAIN, "2021-07-14T14:00:00Z", 38.0, None, "3"),
        (_AHR_RAIN, "2021-07-14T16:00:00Z", 61.0, None, "4"),
        (_AHR_RAIN, "2021-07-14T18:00:00Z", 43.0, None, "4"),
        (_AHR_RIVER, "2021-07-13T06:00:00Z", None, 8.2, None),
        (_AHR_RIVER, "2021-07-14T19:00:00Z", None, 1000.0, "4"),
        (_AHR_RIVER, "2021-07-14T20:00:00Z", None, None, "4"),
    ],
    "discharge_daily": [
        (_VAL_RIVER, "2024-10-28", 3.0, "GloFAS via Open-Meteo"),
        (_VAL_RIVER, "2024-10-29", 2100.0, "GloFAS via Open-Meteo"),
        (_VAL_RIVER, "2024-10-30", 240.0, "GloFAS via Open-Meteo"),
        (_AHR_RIVER, "2021-07-13", 8.0, "GloFAS via Open-Meteo"),
        (_AHR_RIVER, "2021-07-14", 1000.0, "GloFAS via Open-Meteo"),
        (_AHR_RIVER, "2021-07-15", 210.0, "GloFAS via Open-Meteo"),
    ],
    "gauge_levels": _gauge_seed_rows(),
    # The twelve points of migration 062: positions only, no discharge, band unknown.
    # A test that needs a reading sets one.
    "eu_watch": [
        (
            p,
            name,
            cc,
            river,
            lat,
            lon,
            None,
            None,
            None,
            "unknown",
            "model, not an official warning: seed row, no reading",
            "seed:openmeteo_flood",
            None,
        )
        for p, name, cc, river, lat, lon in EU_POINTS
    ],
    # Synthetic portfolio of the demo insurer around the EMSR773 footprint.
    # in_footprint comes from the Copernicus layer.
    "exposure_join": [
        ("P-1001", "S-001", 39.4275, -0.4178, 1, 4_200_000, "warehouse"),
        ("P-1002", "S-002", 39.4036, -0.4039, 1, 1_900_000, "retail"),
        ("P-1003", "S-003", 39.4215, -0.3906, 1, 6_500_000, "retail"),
        ("P-1004", "S-004", 39.4280, -0.3850, 1, 800_000, "retail"),
        ("P-1005", "S-005", 39.4370, -0.4680, 1, 3_100_000, "industrial"),
        ("P-1006", "S-006", 39.4360, -0.4350, 1, 2_400_000, "healthcare"),
        ("P-1007", "S-007", 39.4720, -0.7200, 0, 1_200_000, "industrial"),
        ("P-1008", "S-008", 39.4699, -0.3763, 0, 9_000_000, "office"),
        ("P-1009", "S-009", 39.1900, -0.4350, 1, 2_700_000, "industrial"),
        ("P-1010", "S-010", 39.4600, -0.3300, 0, 1_500_000, "hospitality"),
    ],
    "provenance": [
        (
            "hazard_timeline",
            "https://opendata.aemet.es",
            "AEMET",
            "AEMET OpenData terms (to confirm)",
            "© AEMET",
            "2026-10-22",
        ),
        (
            "hazard_timeline",
            "https://saih.chj.es",
            "SAIH Júcar (CHJ)",
            "to verify",
            "SAIH Júcar / Confederación Hidrográfica del Júcar",
            "2026-10-22",
        ),
        (
            "discharge_daily",
            "https://open-meteo.com/en/docs/flood-api",
            "Open-Meteo / GloFAS",
            "CC BY 4.0",
            "Weather data by Open-Meteo.com",
            "2026-10-22",
        ),
        (
            "exposure_join",
            "https://mapping.emergency.copernicus.eu/activations/EMSR773",
            "European Commission / Copernicus EMS",
            "CEMS On-Demand Mapping Terms and Conditions (07/06/2023)",
            "Copernicus Emergency Management Service (© 2024 European Union), EMSR773",
            "2026-10-22",
        ),
        (
            "exposure_join",
            "https://www.openstreetmap.org",
            "OpenStreetMap",
            "ODbL",
            "© OpenStreetMap contributors",
            "2026-10-22",
        ),
        (
            "exposure_join",
            None,
            "FloodSense (synthetic portfolio)",
            "n/a",
            "Synthetic insurer portfolio, clearly labelled",
            "2026-10-22",
        ),
        (
            "hazard_now",
            "https://open-meteo.com/en/docs/flood-api",
            "Open-Meteo / GloFAS",
            "CC BY 4.0",
            "Weather data by Open-Meteo.com",
            "2026-10-22",
        ),
        (
            "weather_forecast",
            "https://open-meteo.com/en/docs/dwd-api",
            "Open-Meteo.com; model by Deutscher Wetterdienst (DWD)",
            "CC BY 4.0",
            "Weather data by Open-Meteo.com, model DWD ICON",
            "2026-10-27",
        ),
        (
            "gauge_levels",
            "https://www.pegelonline.wsv.de/",
            "Wasserstrassen- und Schifffahrtsverwaltung des Bundes (WSV)",
            "DL-DE->Zero-2.0",
            "Quelle: WSV, PEGELONLINE",
            "2026-10-24",
        ),
    ],
}


def live_hazard_rows(now: datetime | None = None) -> list[tuple]:
    """floodsense.hazard_now in the fake: 72 past hours and 48 forecast hours.

    Generated against the clock at construction, like the rolling warehouse view
    (migration 042). Paiporta (VAL01) crosses the 100 m3/s anomaly line in the
    forecast, peaking at 180 m3/s 20 h out; Chiva (VAL07) has a 34 mm forecast
    hour 18 h out. Every other point stays quiet. warning_level is NULL, as in 042.
    """
    base = (now or datetime.now(timezone.utc)).replace(minute=0, second=0, microsecond=0)
    rows: list[tuple] = []
    for pid in VALENCIA_POINT_IDS:
        for h in range(-71, 49):
            ts = (base + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ")
            horizon = "forecast" if h > 0 else "past"
            rain, flow = 0.2, 4.0
            if pid == "VAL01":
                flow = 4.0 if h < 12 else max(4.0, 180.0 - 20.0 * abs(h - 20))
            if pid == "VAL07" and 14 <= h <= 21:
                rain = (34.0 - 6.0 * abs(h - 18)) if abs(h - 18) <= 3 else 2.0
            rows.append((pid, ts, rain, flow, None, horizon))
    return rows


def weather_forecast_rows(now: datetime | None = None, seed: bool = False) -> list[tuple]:
    """floodsense.weather_forecast in the fake: 45 places x 72 hours from the current hour.

    Test data, not a forecast: 0.1 mm every hour everywhere, except Chiva (VAL07),
    whose rain follows the fake hazard_now (a 34 mm hour 18 h out). The seed twin
    (072) is one row per place with no forecast.
    """
    from floodsense_agents.watch import FORECAST_POINTS

    base = (now or datetime.now(timezone.utc)).replace(minute=0, second=0, microsecond=0)
    model = "DWD ICON (icon_seamless) via Open-Meteo"
    rows: list[tuple] = []
    for pid, kind, _ref, name, river, lat, lon in FORECAST_POINTS:
        if seed:
            rows.append((pid, kind, name, river, lat, lon, None, None, None, model, "seed:openmeteo_forecast"))
            continue
        for h in range(72):
            ts = (base + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ")
            rain = 0.1
            if pid == "VAL07" and 14 <= h <= 21:
                rain = (34.0 - 6.0 * abs(h - 18)) if abs(h - 18) <= 3 else 2.0
            rows.append((pid, kind, name, river, lat, lon, h, ts, rain, model, "fake"))
    return rows


class FakeZetaris:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        for schema in ("floodsense_seed", "floodsense"):
            self._conn.execute(f"ATTACH DATABASE ':memory:' AS {schema}")
            self._conn.executescript(_DDL.format(s=schema))
            for table, rows in _SEED.items():
                self._conn.executemany(
                    f"INSERT INTO {schema}.{table} VALUES ({','.join('?' * len(rows[0]))})", rows
                )
            self._conn.executemany(
                f"INSERT INTO {schema}.weather_forecast VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                weather_forecast_rows(seed=schema != "floodsense"),
            )
            # The seed twin (040) is the frozen window labelled replay. Only the
            # live schema has a past and a forecast.
            if schema == "floodsense":
                self._conn.executemany(
                    f"INSERT INTO {schema}.hazard_now VALUES (?,?,?,?,?,?)", live_hazard_rows()
                )
            else:
                self._conn.execute(
                    f"INSERT INTO {schema}.hazard_now SELECT point_id, ts_utc, rain_mm, "
                    f"discharge_m3s, warning_level, 'replay' FROM {schema}.hazard_timeline"
                )
        self._conn.commit()

    def run_sql(
        self, sql: str, params: tuple[str, ...] | None = None, sample: int = 20
    ) -> Evidence:
        # sample: how many rows Evidence keeps. Nodes keep 20; GET /views keeps more.
        # A write is refused here, as an exception. A bad clock comes back as
        # Evidence.error so one predicate cannot take down the whole run.
        placeholder = check_sql(sql)
        qid = str(uuid.uuid4())
        try:
            rendered, bound = inline_bound(placeholder, params)
            check_sql(rendered)
            with self._lock:
                rows = [dict(r) for r in self._conn.execute(placeholder, bound).fetchall()]
            return Evidence(
                query_id=qid,
                view=_view_of(rendered),
                sql=rendered,
                rows_sample=rows[:sample],
                row_count=len(rows),
                executed_at_utc=now_utc(),
                source="zetaris-fake",
            )
        except (sqlite3.Error, ValueError) as e:
            return Evidence(
                query_id=qid,
                view=_view_of(sql),
                sql=sql,
                rows_sample=[],
                row_count=0,
                executed_at_utc=now_utc(),
                source="zetaris-fake",
                error=str(e),
            )


def build_zetaris() -> Zetaris:
    if settings.zetaris_mode == "fake" or (
        settings.zetaris_mode == "auto" and not settings.zetaris_rest_url
    ):
        log.warning("Zetaris: ZETARIS_REST_URL unset -> FakeZetaris (SQLite seed views)")
        return FakeZetaris()
    return ZetarisClient()
