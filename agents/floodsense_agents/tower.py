"""Control tower: the autonomous watch loop and its activity feed.

Nothing here calls a model. Each cycle reads the live views through the Zetaris
client (``gauge_levels``, ``eu_watch``, ``hazard_now``), gives every watched
source the same plain status as ``ui/src/lib/places.ts`` ``statusView``, diffs
that against the previous cycle, and for each source that is newly elevated (or
escalated) records what the rule-based agents found:

    Watch     detected          the source and its reading
    Forecast  checked           the forecast lane's own data and screening
                                rules (``nodes/forecast.py``: weather_forecast
                                rain, the river forecast, the gauge level and
                                the fixed 25 / 50 mm cuts), without a graph run
    Exposure  exposure          insured sites of the demo book within about
                                25 km (one aggregate over ``exposure_join``)

The full run lifecycle is hooked in as well, so the feed tells the whole story:
Playbook ``drafted``, Judge ``awaiting_approval``, Human ``approved``. With
``FF_AUTO_ASSESS=true`` (default off) a cycle may start ONE full investigation
for the most severe new source, at most ``WATCH_AUTO_PER_HOUR`` (1) per hour and
``WATCH_AUTO_PER_DAY`` (3) per day. That run lands in the approval queue like
any other; nothing is ever approved here.

Event text comes only from the fixed templates below and the rows read, so no
number is invented. Events live in a bounded in-memory ring (500) and in a
JSONL file, so a restart keeps the history.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from floodsense_agents.events import POINT_NAMES
from floodsense_agents.live import gauge_latest_sql
from floodsense_agents.nodes import forecast as fc
from floodsense_agents.nodes import quick
from floodsense_agents.settings import settings
from floodsense_agents.watch import (
    FORECAST_BY_REF,
    _VALENCIA_POS,
)
from floodsense_agents.zetaris import now_utc

log = logging.getLogger("floodsense.tower")

RING_SIZE = 500
KINDS = ("detected", "checked", "exposure", "drafted", "awaiting_approval", "approved", "info")
AGENTS = ("Watch", "Forecast", "Exposure", "Playbook", "Judge", "Human")
KIND_AGENT = {
    "detected": "Watch",
    "checked": "Forecast",
    "exposure": "Exposure",
    "drafted": "Playbook",
    "awaiting_approval": "Judge",
    "approved": "Human",
    "info": "Watch",
}
HONEST_LABEL = (
    "Rule-based watchers: no model calls. Model-written work only appears when a full "
    "investigation is started."
)
MANUAL_MIN_GAP_S = 5.0
MAX_CHECKS_PER_CYCLE = 20
EXPOSURE_RADIUS_KM = 25.0
# A Valencia point is measured against its own past rows: watch at 2x, over at 4x their median, the median
# floored at 5 m3/s (ui/src/lib/euWatch.ts valenciaCuts, #90).
VALENCIA_WATCH_X = 2.0
VALENCIA_WARNING_X = 4.0
VALENCIA_MEDIAN_FLOOR = 5.0
SQL_SAMPLE = 6000

# --------------------------------------------------------------------- status

RANK = {"unknown": -1, "ok": 0, "near": 1, "over": 2}


def status_view(kind: str, status: str) -> dict[str, Any]:
    """The plain word, tone and sort rank of one source: ui/src/lib/places.ts statusView.

    Never red and never "Warning" for a model band: the tones are normal, watch, elevated,
    neutral and unknown.
    """
    if status == "ok":
        return {"word": "Normal", "tone": "normal", "rank": 8}
    if status not in ("near", "over"):
        return {"word": "No reading", "tone": "unknown", "rank": 9}
    if kind == "gauge":
        if status == "over":
            return {"word": "Above mean high water", "tone": "elevated", "rank": 0}
        return {"word": "Close to mean high water", "tone": "watch", "rank": 2}
    if kind == "model":
        if status == "over":
            return {"word": "Elevated (model)", "tone": "elevated", "rank": 1}
        return {"word": "Watch (model)", "tone": "watch", "rank": 3}
    if status == "over":
        return {"word": "Far above its recent normal (model)", "tone": "elevated", "rank": 4}
    return {"word": "Above its recent normal (model)", "tone": "neutral", "rank": 5}


def valencia_cuts(past: list[float]) -> tuple[float, float]:
    """(watch, warning) of one point from its past rows; ui/src/lib/euWatch.ts valenciaCuts."""
    v = sorted(past)
    n = len(v)
    median = 0.0 if n == 0 else v[(n - 1) // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2
    base = max(median, VALENCIA_MEDIAN_FLOOR)
    return base * VALENCIA_WATCH_X, base * VALENCIA_WARNING_X


def is_elevated(status: str) -> bool:
    return status in ("near", "over")


_WATER = {
    "RHEIN": "Rhine",
    "MOSEL": "Mosel",
    "SAAR": "Saar",
    "MAIN": "Main",
    "NECKAR": "Neckar",
    "ELBE": "Elbe",
    "DONAU": "Danube",
    "ODER": "Oder",
    "WESER": "Weser",
    "EMS": "Ems",
}


def river_name(water: str) -> str:
    return _WATER.get(str(water or "").upper(), str(water or ""))


def station_name(station: str) -> str:
    """Title case for a PEGELONLINE shortname ("FRANKFURT1 (ODER)" -> "Frankfurt1 (Oder)")."""
    return re.sub(
        r"(^|[\s(.-])(\w)", lambda m: m.group(1) + m.group(2).upper(), str(station).lower()
    )


def _num(v: Any) -> float | None:
    return quick._num(v)


def _n(v: float) -> str:
    """A number for a sentence: whole above 100, one decimal below, thousands separated."""
    if abs(v) >= 100 or v == int(v):
        return f"{v:,.0f}"
    return f"{v:,.1f}"


def _hhmm(ts: Any) -> str | None:
    return quick._hhmm(ts)


def _parse_ts(ts: Any) -> datetime | None:
    s = str(ts or "").strip().replace(" ", "T")
    if not s:
        return None
    s = re.sub(r"\.\d+", "", s)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# -------------------------------------------------------------------- sources

Source = dict[str, Any]


def _truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in ("true", "t", "1", "yes")


def gauge_status(row: dict) -> str:
    """The view's band (below / near / above) as the UI reads it (ui/src/lib/gauges.ts asGaugeRow).

    A missing is_stale means stale; a stale reading is "unknown" here, so it is never an event. A band
    outside below / near / above stays unknown: it is not computed from the level. The shared cases are
    contracts/examples/status_cases.json (this file's tests and the UI's both read them).
    """
    if row.get("is_stale") is None or _truthy(row.get("is_stale")):
        return "unknown"
    band = str(row.get("band") or "").strip().lower()
    return {"below": "ok", "near": "near", "above": "over"}.get(band, "unknown")


def gauge_sources(ev) -> list[Source]:
    out: list[Source] = []
    for r in ev.rows_sample:
        station = str(r.get("station") or "").strip()
        if not station:
            continue
        level, mhw = _num(r.get("level_cm")), _num(r.get("mhw_cm"))
        out.append(
            {
                "id": f"gauge:{station}",
                "kind": "gauge",
                "ref": station,
                "name": station_name(station),
                "river": river_name(str(r.get("water") or "")),
                "country": "DE",
                "status": gauge_status(r),
                "ratio": (level / mhw) if level is not None and mhw else None,
                "view": "gauge_levels",
                "query_id": ev.query_id,
                "row": r,
            }
        )
    return out


def model_sources(ev) -> list[Source]:
    out: list[Source] = []
    for r in ev.rows_sample:
        pid = str(r.get("point_id") or "").strip()
        if not pid:
            continue
        band = str(r.get("band") or "").strip().lower()
        fmax, med = _num(r.get("forecast_max_m3s")), _num(r.get("past30_median_m3s"))
        out.append(
            {
                "id": f"model:{pid}",
                "kind": "model",
                "ref": pid,
                "name": str(r.get("name") or pid),
                "river": str(r.get("river") or ""),
                "country": str(r.get("country") or "").upper(),
                "status": {"below": "ok", "near": "near", "above": "over"}.get(band, "unknown"),
                "ratio": (fmax / med) if fmax is not None and med else None,
                "view": "eu_watch",
                "query_id": ev.query_id,
                "row": r,
            }
        )
    return out


def valencia_sources(ev) -> list[Source]:
    """hazard_now per point: the higher of the latest past hour and the 48 h forecast maximum.

    The same rule as ui/src/lib/now.ts summarisePoint + euWatch.fromValencia.
    """
    by_point: dict[str, list[dict]] = {}
    for r in ev.rows_sample:
        by_point.setdefault(str(r.get("point_id") or ""), []).append(r)
    out: list[Source] = []
    for pid, rows in sorted(by_point.items()):
        if pid not in POINT_NAMES or not pid.startswith("VAL"):
            continue
        dated = [(d, r) for r in rows if (d := _parse_ts(r.get("ts_utc"))) is not None]
        past = sorted((x for x in dated if str(x[1].get("horizon")) == "past"), key=lambda x: x[0])
        fore = sorted(
            (x for x in dated if str(x[1].get("horizon")) == "forecast"), key=lambda x: x[0]
        )
        latest = past[-1] if past else None
        horizon = [
            x for x in fore if latest is None or (x[0] - latest[0]).total_seconds() <= 48 * 3600
        ]
        now_q = _num(latest[1].get("discharge_m3s")) if latest else None
        fq = [q for _, r in horizon if (q := _num(r.get("discharge_m3s"))) is not None]
        fmax = max(fq) if fq else None
        pq = [q for _, r in past if (q := _num(r.get("discharge_m3s"))) is not None]
        values = [v for v in (now_q, fmax) if v is not None]
        top = max(values) if values else None
        watch, warning = valencia_cuts(pq)
        status = (
            "unknown"
            if top is None
            else "over"
            if top >= warning
            else "near"
            if top >= watch
            else "ok"
        )
        out.append(
            {
                "id": f"valencia:{pid}",
                "kind": "valencia",
                "ref": pid,
                "name": POINT_NAMES[pid],
                "river": "",
                "country": "ES",
                "status": status,
                "ratio": None if top is None else top / warning,
                "view": "hazard_now",
                "query_id": ev.query_id,
                "row": {
                    "point_id": pid,
                    "top_m3s": top,
                    "now_m3s": now_q,
                    "forecast_max_discharge_m3s": fmax,
                    "past_max_discharge_m3s": max(pq) if pq else None,
                    "watch_m3s": watch,
                    "warning_m3s": warning,
                    "ts_utc": latest[1].get("ts_utc") if latest else None,
                },
            }
        )
    return out


def where(s: Source) -> str:
    """ "Rhine at Köln", "Loire at Orleans", "Paiporta"."""
    return f"{s['river']} at {s['name']}" if s["river"] else s["name"]


# ------------------------------------------------------------------ templates


def _reading(s: Source) -> str:
    r = s["row"]
    if s["kind"] == "gauge":
        level, mhw = _num(r.get("level_cm")), _num(r.get("mhw_cm"))
        if level is None:
            return ""
        text = f"Level {_n(level)} cm"
        if mhw is not None:
            text += f" against a long-term mean high water of {_n(mhw)} cm"
        at = _hhmm(r.get("ts_utc"))
        if at:
            text += f", measured {at} UTC"
        return text + ". Not a warning level."
    if s["kind"] == "model":
        fmax, med = _num(r.get("forecast_max_m3s")), _num(r.get("past30_median_m3s"))
        if fmax is None:
            return ""
        text = f"The 7-day model maximum is {_n(fmax)} m³/s"
        if med:
            text += f", {fmax / med:.1f} times the past-30-day median of {_n(med)} m³/s"
        return text + ". Model, not an official warning."
    top = _num(r.get("top_m3s"))
    if top is None:
        return ""
    return (
        f"Modelled river flow reaches {_n(top)} m³/s (latest hour and next 48 h), measured against "
        f"this point's own past flow (above twice, and far above four times, its median; the "
        f"median is never taken below 5 m³/s). Not official."
    )


def detected_text(s: Source, prev: str | None) -> str:
    word = status_view(s["kind"], s["status"])["word"]
    rise = ""
    if prev and is_elevated(prev):
        rise = f" (up from {status_view(s['kind'], prev)['word'].lower()})"
    return (
        f"{where(s)}: {word.lower() if s['kind'] == 'gauge' else word}{rise}. {_reading(s)}".strip()
    )


def recovered_text(s: Source, prev: str) -> str:
    word = status_view(s["kind"], s["status"])["word"]
    was = status_view(s["kind"], prev)["word"].lower()
    return f"{where(s)} is back to {word.lower()} (was {was})."


_SCREEN = {fc.NORMAL: "normal", fc.WATCH: "watch", fc.ELEVATED: "elevated"}


def checked_text(s: Source, chk: dict) -> str:
    if chk.get("gap"):
        return f"Forecast check for {where(s)}: {chk['gap']}"
    parts = []
    if chk.get("rain_48h_mm") is not None:
        t = f"rain forecast {_n(chk['rain_48h_mm'])} mm over the next 48 h"
        if chk.get("max_hour_mm") is not None:
            t += f" (wettest hour {_n(chk['max_hour_mm'])} mm)"
        parts.append(t)
    if chk.get("forecast_max_m3s") is not None:
        label = (
            "GloFAS 7-day maximum"
            if s["kind"] == "model"
            else "model discharge maximum in the forecast window"
        )
        parts.append(f"{label} {_n(chk['forecast_max_m3s'])} m³/s")
    if chk.get("level_cm") is not None:
        parts.append(f"gauge level {_n(chk['level_cm'])} cm")
    detail = "; ".join(parts) if parts else "no forecast value held for this place"
    return (
        f"Forecast check for {where(s)}: {detail}. FloodSense screening: "
        f"{_SCREEN.get(chk.get('screening'), 'unknown')}. Rule-based, not an official warning."
    )


def exposure_text(s: Source, ex: dict, also: list[str] | tuple[str, ...] = ()) -> str:
    sites = ex["sites"]
    near = f"{where(s)} (also covering {', '.join(also)})" if also else where(s)
    if not sites:
        return (
            f"Exposure near {near}: no insured sites of the demo book within about "
            f"{EXPOSURE_RADIUS_KM:.0f} km (synthetic demo portfolio)."
        )
    total = ex.get("insured_eur")
    money = f", {_n(total)} EUR insured in total" if total is not None else ""
    return (
        f"Exposure near {near}: {sites} insured {'site' if sites == 1 else 'sites'} of the demo "
        f"book within about {EXPOSURE_RADIUS_KM:.0f} km{money} (synthetic demo portfolio)."
    )


def assess_question(s: Source) -> str:
    """The fixed question of an auto-assessment; 'insured sites' sends it to the full lane."""
    r = s["row"]
    if s["kind"] == "gauge":
        level = _num(r.get("level_cm"))
        what = f"the gauge reads {status_view('gauge', s['status'])['word'].lower()}"
        if level is not None:
            what += f" ({_n(level)} cm)"
    elif s["kind"] == "model":
        what = f"the GloFAS model reads {status_view('model', s['status'])['word']}"
    else:
        what = f"the model reads {status_view('valencia', s['status'])['word']}"
    on = f"on the {s['river']} " if s["river"] else ""
    return (
        f"Assess the flood risk to our insured sites near {s['name']} {on}right now: {what}. "
        f"What should the insurer do?"
    )


# ------------------------------------------------------------ feed failures

VIEW_LABEL = {
    "gauge_levels": "river gauge",
    "eu_watch": "river model",
    "hazard_now": "Valencia model",
}
MODEL_VIEWS = ("eu_watch", "hazard_now")


def friendly_error(view: str, msg: str) -> str:
    """Plain words for a failed read. Never a URL, JSON or hostname: those stay in ``detail``."""
    label = VIEW_LABEL.get(view, "data")
    if re.search(r"\b429\b", msg or ""):
        if view in MODEL_VIEWS:
            return (
                "Open-Meteo is rate-limiting the model feed right now, so these sources keep "
                "their last status."
            )
        return (
            f"The {label} feed is rate-limiting requests right now, so these sources keep "
            f"their last status."
        )
    return f"The {label} feed could not be read this scan; sources keep their last status."


# ------------------------------------------------------------------ the store


class EventStore:
    """Bounded ring of events plus a JSONL file that a restart reloads."""

    def __init__(self, directory: str | os.PathLike | None, size: int = RING_SIZE) -> None:
        self.size = size
        self._ring: deque[dict] = deque(maxlen=size)
        self._lock = threading.RLock()
        self._seq = 0
        self.path: Path | None = None
        if directory:
            try:
                d = Path(directory)
                d.mkdir(parents=True, exist_ok=True)
                self.path = d / "watch_events.jsonl"
                self._load()
            except OSError as e:
                log.warning(
                    "watch events: %s is not writable (%s); history is memory only", directory, e
                )
                self.path = None

    @staticmethod
    def seq_of(event_id: str | int | None) -> int:
        m = re.search(r"(\d+)$", str(event_id or ""))
        return int(m.group(1)) if m else 0

    def _load(self) -> None:
        assert self.path is not None
        if not self.path.is_file():
            return
        rows: list[dict] = []
        total = 0
        for line in self.path.read_text(encoding="utf-8", errors="replace").splitlines():
            total += 1
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and row.get("id"):
                rows.append(row)
        for row in rows[-self.size :]:
            self._ring.append(row)
        if rows:
            self._seq = max(self.seq_of(r["id"]) for r in rows)
        if total > self.size * 4:  # compact: the file keeps what the ring keeps
            try:
                self.path.write_text(
                    "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in self._ring),
                    encoding="utf-8",
                )
            except OSError:
                pass

    def append(self, event: dict) -> dict:
        with self._lock:
            self._seq += 1
            row = {"id": f"w{self._seq:08d}", "ts": now_utc(), **event}
            self._ring.append(row)
            if self.path is not None:
                try:
                    with self.path.open("a", encoding="utf-8") as f:
                        f.write(json.dumps(row, ensure_ascii=False) + "\n")
                except OSError as e:
                    log.warning("watch events: could not persist (%s)", e)
            return row

    def since(self, since: str | int | None = None, limit: int = 100) -> list[dict]:
        """Events after ``since`` (an event id or its number), oldest first, at most ``limit``.

        Without ``since`` it is the newest ``limit`` events.
        """
        limit = max(1, min(int(limit), self.size))
        with self._lock:
            rows = list(self._ring)
        if since in (None, ""):
            return rows[-limit:]
        cut = self.seq_of(since)
        return [r for r in rows if self.seq_of(r["id"]) > cut][:limit]

    def latest_id(self) -> str | None:
        with self._lock:
            return self._ring[-1]["id"] if self._ring else None

    def all(self) -> list[dict]:
        with self._lock:
            return list(self._ring)

    def __len__(self) -> int:
        return len(self._ring)


class JsonState:
    """A tiny JSON file: the last statuses and the auto-assess times, so a restart keeps the caps."""

    def __init__(self, directory: str | os.PathLike | None) -> None:
        self.path: Path | None = None
        if directory:
            try:
                d = Path(directory)
                d.mkdir(parents=True, exist_ok=True)
                self.path = d / "watch_state.json"
            except OSError:
                self.path = None

    def load(self) -> dict:
        if self.path is None or not self.path.is_file():
            return {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def save(self, data: dict) -> None:
        if self.path is None:
            return
        try:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.path)
        except OSError as e:
            log.warning("watch state: could not persist (%s)", e)


# ------------------------------------------------------------------ data reads


def read_sources(zetaris, schema: str) -> tuple[list[Source], dict[str, str], dict[str, str]]:
    """(sources, view -> error, view -> query_id). One failed view loses only its own sources."""
    jobs = {
        "gauge_levels": gauge_latest_sql(schema),
        "eu_watch": (
            f"SELECT point_id, name, country, river, lat, lon, discharge_m3s, forecast_max_m3s, "
            f"past30_median_m3s, band, basis, source, as_of_date FROM {schema}.eu_watch"
        ),
        "hazard_now": (
            f"SELECT point_id, ts_utc, discharge_m3s, horizon FROM {schema}.hazard_now "
            f"WHERE horizon IN ('past', 'forecast')"
        ),
    }
    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="tower-read") as pool:
        futs = {v: pool.submit(zetaris.run_sql, sql, None, SQL_SAMPLE) for v, sql in jobs.items()}
        results = {}
        for v, f in futs.items():
            try:
                results[v] = f.result()
            except Exception as e:  # noqa: BLE001 - a failed view degrades on its own
                results[v] = type(
                    "Err",
                    (),
                    {"error": f"{type(e).__name__}: {e}"[:200], "query_id": "", "rows_sample": []},
                )()
    errors = {v: str(ev.error) for v, ev in results.items() if getattr(ev, "error", None)}
    query_ids = {v: ev.query_id for v, ev in results.items()}
    sources: list[Source] = []
    if "gauge_levels" not in errors:
        sources += gauge_sources(results["gauge_levels"])
    if "eu_watch" not in errors:
        sources += model_sources(results["eu_watch"])
    if "hazard_now" not in errors:
        sources += valencia_sources(results["hazard_now"])
    return sources, errors, query_ids


def forecast_checks(zetaris, schema: str, sources: list[Source]) -> dict[str, dict]:
    """The forecast lane's deterministic check for several sources at once; no model, no graph run.

    One ``weather_forecast`` query serves every source (each query re-fetches the whole REST table).
    The river forecast and the gauge level come from the rows this cycle already read, through the
    lane's own claim functions (``nodes/forecast.py``), so the status cuts are the lane's.
    """
    points = {s["id"]: FORECAST_BY_REF.get(s["ref"]) for s in sources}
    wanted = [p for p in points.values() if p is not None]
    out: dict[str, dict] = {}
    weather = None
    if wanted:
        weather = zetaris.run_sql(fc.weather_sql(schema, sorted({p[0] for p in wanted})), None, 200)
    for s in sources:
        p = points[s["id"]]
        chk: dict[str, Any] = {"query_id": None}
        out[s["id"]] = chk
        if p is None:
            chk["gap"] = "not one of the 45 places of the forecast lane."
            continue
        statuses: list[str] = []
        wrow = fc._row(p, "weather", weather) if weather is not None and not weather.error else None
        if wrow is not None:
            r48 = _num(wrow.get(f"rain_{fc.HORIZON_H}h_mm"))
            hour = _num(wrow.get(f"max_hour_{fc.HORIZON_H}h_mm"))
            chk.update(rain_48h_mm=r48, max_hour_mm=hour, query_id=weather.query_id)
            if r48 is not None:
                statuses.append(fc._rain_status(r48, hour))
        if s["kind"] == "gauge":
            got = fc.level_claim(p, s["row"])
            if got:
                statuses.append(got[1])
                chk["level_cm"] = _num(s["row"].get("level_cm"))
        elif s["kind"] == "model":
            got = fc.river_claim(p, s["row"])
            if got:
                statuses.append(got[1])
                chk["forecast_max_m3s"] = _num(s["row"].get("forecast_max_m3s"))
        else:
            got = fc.river_claim(p, s["row"])
            if got:
                statuses.append(got[1])
                chk["forecast_max_m3s"] = _num(s["row"].get("forecast_max_discharge_m3s"))
        if not statuses:
            chk["gap"] = "no forecast rows are held for this place right now."
            continue
        chk["screening"] = max(statuses, key=lambda x: fc._RANK[x])
        chk["query_id"] = chk["query_id"] or s["query_id"]
        if chk.get("rain_48h_mm") is None:
            chk["note"] = "no weather forecast row"
    return out


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def _position(s: Source) -> tuple[float, float] | None:
    r = s["row"]
    lat, lon = _num(r.get("lat")), _num(r.get("lon"))
    if lat is not None and lon is not None:
        return lat, lon
    p = FORECAST_BY_REF.get(s["ref"])
    return (p[5], p[6]) if p else None


def near_demo_book(s: Source) -> bool:
    """A Valencia point, or within the book's radius of one (the demo book covers Valencia only)."""
    if s["kind"] == "valencia":
        return True
    pos = _position(s)
    return bool(pos) and any(
        _km(pos[0], pos[1], v[3], v[4]) <= EXPOSURE_RADIUS_KM for v in _VALENCIA_POS
    )


def exposure_query(s: Source, schema: str) -> str | None:
    pos = _position(s)
    if pos is None:
        return None
    lat, lon = pos
    dlat = EXPOSURE_RADIUS_KM / 111.0
    dlon = EXPOSURE_RADIUS_KM / (111.0 * max(0.2, math.cos(math.radians(lat))))
    return (
        f"SELECT COUNT(DISTINCT site_id) AS sites, COUNT(*) AS policies, "
        f"SUM(sum_insured_eur) AS insured_eur FROM {schema}.exposure_join "
        f"WHERE lat BETWEEN {lat - dlat:.4f} AND {lat + dlat:.4f} "
        f"AND lon BETWEEN {lon - dlon:.4f} AND {lon + dlon:.4f}"
    )


GROUP_KM = 10.0


def exposure_groups(sources: list[Source]) -> list[tuple[Source, list[Source]]]:
    """Group raised sources that sit within GROUP_KM of the first of the group: (representative, others).

    The demo book's radius covers all of them, so one read serves the group. Order is kept.
    """
    groups: list[tuple[Source, list[Source]]] = []
    for s in sources:
        pos = _position(s)
        for rep, others in groups:
            rp = _position(rep)
            if pos and rp and _km(pos[0], pos[1], rp[0], rp[1]) <= GROUP_KM:
                others.append(s)
                break
        else:
            groups.append((s, []))
    return groups


def read_exposure(zetaris, schema: str, s: Source) -> dict | None:
    sql = exposure_query(s, schema)
    if sql is None:
        return None
    ev = zetaris.run_sql(sql, None, 5)
    if ev.error or not ev.rows_sample:
        return None
    row = ev.rows_sample[0]
    sites = _num(row.get("sites"))
    if sites is None:
        return None
    return {
        "sites": int(sites),
        "insured_eur": _num(row.get("insured_eur")),
        "query_id": ev.query_id,
    }


# ------------------------------------------------------------------ the tower


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


def _env_flag(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v in (None, "") else v.strip().lower() in ("1", "true", "yes", "on")


def default_dir() -> str | None:
    """WATCH_DATA_DIR, else a folder beside the checkpoints (the compose volume); none with CHECKPOINTER=memory."""
    env = os.environ.get("WATCH_DATA_DIR")
    if env:
        return env
    if settings.checkpointer == "memory":
        return None
    return os.path.join(settings.checkpoint_dir, "watch")


class ControlTower:
    def __init__(
        self,
        zetaris: Callable[[], Any],
        runtime: Callable[[], Any] | None = None,
        *,
        data_dir: str | os.PathLike | None = None,
        interval_s: float | None = None,
        loop_enabled: bool | None = None,
        auto_assess: bool | None = None,
        per_hour: int | None = None,
        per_day: int | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._zetaris = zetaris
        self._runtime = runtime
        self.clock = clock
        self.store = EventStore(data_dir if data_dir is not None else default_dir())
        self.state = JsonState(data_dir if data_dir is not None else default_dir())
        self.interval_s = float(
            interval_s if interval_s is not None else (os.environ.get("WATCH_INTERVAL_S") or 900)
        )
        self.loop_enabled = (
            _env_flag("FF_WATCH_LOOP", True) if loop_enabled is None else loop_enabled
        )
        self.auto_assess = (
            _env_flag("FF_AUTO_ASSESS", False) if auto_assess is None else auto_assess
        )
        self.per_hour = per_hour if per_hour is not None else _env_int("WATCH_AUTO_PER_HOUR", 1)
        self.per_day = per_day if per_day is not None else _env_int("WATCH_AUTO_PER_DAY", 3)
        saved = self.state.load()
        self.prev: dict[str, str] = dict(saved.get("statuses") or {})
        # No state file yet: the first scan only learns what is raised. It never auto-assesses.
        self._baseline = not saved.get("statuses")
        # The caps live in the state file. Without it a restart would forget them, so auto-assess
        # fails closed (it stays off, and /watch/status says why).
        self.persisted_reason: str | None = None
        if self.state.path is None:
            self.persisted_reason = (
                "Nothing is saved between restarts here (CHECKPOINTER=memory or an unwritable "
                "WATCH_DATA_DIR), so the auto-assess caps could not survive one."
            )
            if self.auto_assess:
                log.warning("auto-assess stays off: %s", self.persisted_reason)
                self.auto_assess = False
        self.auto_times: list[float] = [float(t) for t in saved.get("auto_times") or []]
        self.last_cycle: dict | None = None
        self.sources_now: list[dict] = []
        self.started_at = now_utc()
        self._cycle_lock = threading.Lock()
        self._last_manual = 0.0
        self._first_cycle_done = False
        self._view_down: dict[str, dict] = {}
        self._announced: set[str] = set()
        self.auto_runs: dict[str, Source] = {}
        self._thread: threading.Thread | None = None
        self._scan_thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.scanning = False
        self.next_cycle_at: str | None = None

    # ------------------------------------------------------------ events

    def emit(
        self,
        kind: str,
        text: str,
        *,
        source: Source | None = None,
        status: str | None = None,
        view: str = "runs",
        query_id: str | None = None,
        run_id: str | None = None,
        place: str | None = None,
        river: str = "",
        country: str = "",
        place_id: str | None = None,
        data: dict | None = None,
        agent: str | None = None,
        detail: str | None = None,
    ) -> dict:
        assert kind in KINDS, kind
        tone_status = status
        if source is not None:
            place = place or source["name"]
            river = river or source["river"]
            country = country or source["country"]
            place_id = place_id or source["id"]
            tone_status = tone_status or source["status"]
            kind_of = source["kind"]
        else:
            kind_of = "model"
        sv = status_view(kind_of, tone_status or "unknown") if tone_status else None
        event = {
            "kind": kind,
            "agent": agent or KIND_AGENT[kind],
            "place_id": place_id,
            "place": place or "",
            "river": river,
            "country": country,
            "status": sv["word"] if sv else "",
            "tone": sv["tone"] if sv else "unknown",
            "text": text,
            "run_id": run_id,
            "source": {"view": view, "query_id": query_id},
            "data": data or {},
        }
        if detail:
            event["detail"] = detail
        return self.store.append(event)

    # ------------------------------------------------------------- cycle

    def cycle(self, trigger: str = "loop") -> dict:
        """One scan. Returns a summary; ``ran`` is False when another scan is in progress."""
        if not self._cycle_lock.acquire(blocking=False):
            return {"ran": False, "reason": "a scan is already running"}
        self.scanning = True
        try:
            return self._cycle(trigger)
        finally:
            self.scanning = False
            self._cycle_lock.release()

    def force(self, block: bool = False) -> dict:
        """POST /watch/cycle: a scan now, at most once per MANUAL_MIN_GAP_S.

        By default it returns at once ({"started": True}) and the scan runs on a thread; the feed and
        /watch/status show it. block=True waits for the scan (tests).
        """
        now = self.clock()
        if now - self._last_manual < MANUAL_MIN_GAP_S:
            return {
                "ran": False,
                "reason": "a scan was just requested",
                "retry_after_s": int(MANUAL_MIN_GAP_S - (now - self._last_manual)) + 1,
            }
        if self.scanning:
            return {"ran": False, "reason": "a scan is already running"}
        self._last_manual = now
        if block:
            return self.cycle("manual")
        self.scanning = True  # visible at once; the thread's cycle() owns it from here
        # Kept so a shutdown can wait for it: the scan writes into data_dir, and
        # a caller that drops the directory first races a half-written file.
        self._scan_thread = threading.Thread(target=self._forced, name="control-tower-scan", daemon=True)
        self._scan_thread.start()
        return {"ran": None, "started": True}

    def _forced(self) -> None:
        try:
            self.cycle("manual")
        except Exception:  # noqa: BLE001
            log.exception("forced watch cycle failed")

    def _cycle(self, trigger: str) -> dict:
        t0 = self.clock()
        started = now_utc()
        schema = settings.schema
        z = self._zetaris()
        sources, errors, _qids = read_sources(z, schema)
        # A view that cannot be read keeps its sources' last status (no false "recovered").
        for view, msg in errors.items():
            text = friendly_error(view, msg)
            down = self._view_down.get(view)
            if down is None or down["text"] != text:
                stamp = now_utc()
                down = {
                    "text": text,
                    "count": 0,
                    "since": _hhmm(stamp) or "",
                    "key": f"down:{view}:{self.store.latest_id()}",
                }
                self._view_down[view] = down
            down["count"] += 1
            # Identical consecutive failures share a dedupe key: the feed shows one row, "x N since HH:MM".
            self.emit(
                "info",
                text,
                view=view,
                detail=msg[:300],
                data={"dedupe_key": down["key"], "repeats": down["count"], "since": down["since"]},
            )
        for view in list(self._view_down):
            if view not in errors:
                self._view_down.pop(view, None)
                self.emit(
                    "info",
                    f"The {VIEW_LABEL.get(view, 'data')} feed can be read again.",
                    view=view,
                    data={"recovered": True},
                )
        view_kind = {"gauge_levels": "gauge", "eu_watch": "model", "hazard_now": "valencia"}
        down_kinds = {view_kind[v] for v in errors}
        new_prev = {sid: st for sid, st in self.prev.items() if sid.split(":")[0] in down_kinds}

        try:
            return self._scan(trigger, t0, started, schema, z, sources, errors, new_prev)
        finally:
            # Even when the rest of the scan raised, what was read is what the next scan diffs against.
            self.prev = new_prev
            if (
                new_prev or not self._baseline
            ):  # an empty first read writes no state that would mark everything new
                self._save()

    def _scan(self, trigger, t0, started, schema, z, sources, errors, new_prev) -> dict:
        flagged: list[tuple[Source, str | None]] = []
        for s in sources:
            was = self.prev.get(s["id"])
            now = s["status"]
            new_prev[s["id"]] = now
            if is_elevated(now) and (was is None or RANK.get(was, -1) < RANK[now]):
                flagged.append((s, was))
            elif was and is_elevated(was) and now == "ok":
                self.emit(
                    "info", recovered_text(s, was), source=s, view=s["view"], query_id=s["query_id"]
                )
        self.sources_now = [
            {
                "id": s["id"],
                "kind": s["kind"],
                "name": s["name"],
                "river": s["river"],
                "country": s["country"],
                "status": s["status"],
                "word": status_view(s["kind"], s["status"])["word"],
                "tone": status_view(s["kind"], s["status"])["tone"],
                "view": s["view"],
                "query_id": s["query_id"],
            }
            for s in sources
        ]
        elevated = sum(1 for s in sources if is_elevated(s["status"]))
        # Worst first, so a long list reads in order (and the auto-assess pick is the first).
        flagged.sort(key=lambda x: (-RANK[x[0]["status"]], -(x[0]["ratio"] or 0), x[0]["name"]))
        checks: dict[str, dict] = {}
        exposures: dict[str, tuple[dict, list[str]]] = {}
        if flagged:
            batch = [s for s, _ in flagged][:MAX_CHECKS_PER_CYCLE]
            try:
                checks = forecast_checks(z, schema, batch)
            except Exception as e:  # noqa: BLE001 - the scan goes on without the check
                log.warning("forecast check failed: %s", e)
                self.emit(
                    "info",
                    f"The forecast check could not run this scan ({type(e).__name__}).",
                    view="weather_forecast",
                )
            # Raised points that sit together (the Valencia points) share one exposure read.
            for rep, others in exposure_groups([s for s in batch if near_demo_book(s)]):
                try:
                    ex = read_exposure(z, schema, rep)
                except Exception as e:  # noqa: BLE001
                    log.warning("exposure read failed: %s", e)
                    ex = None
                if ex is not None:
                    exposures[rep["id"]] = (ex, [o["name"] for o in others])

        # One short story per source, in order: detected, forecast checked, exposure counted.
        for s, was in flagged:
            self.emit(
                "detected",
                detected_text(s, was),
                source=s,
                view=s["view"],
                query_id=s["query_id"],
                data={"previous": was, "ratio": s["ratio"]},
            )
            chk = checks.get(s["id"])
            if chk is not None:
                self.emit(
                    "checked",
                    checked_text(s, chk),
                    source=s,
                    view="weather_forecast",
                    query_id=chk.get("query_id"),
                    data={
                        k: v
                        for k, v in chk.items()
                        if k not in ("query_id", "gap") and v is not None
                    },
                )
            if s["id"] in exposures:
                ex, also = exposures[s["id"]]
                self.emit(
                    "exposure",
                    exposure_text(s, ex, also),
                    source=s,
                    view="exposure_join",
                    query_id=ex["query_id"],
                    data={
                        "sites": ex["sites"],
                        "insured_eur": ex["insured_eur"],
                        "radius_km": EXPOSURE_RADIUS_KM,
                        "also_covers": also,
                    },
                )

        assessed = None
        if flagged and not self._baseline:
            assessed = self._maybe_auto_assess([s for s, _ in flagged])
        summary = {
            "ran": True,
            "trigger": trigger,
            "started_at": started,
            "finished_at": now_utc(),
            "duration_ms": int((self.clock() - t0) * 1000),
            "sources": len(sources),
            "elevated": elevated,
            "new": len(flagged),
            "errors": errors,
            "auto_assess_run_id": assessed,
        }
        if trigger == "manual" or not self._first_cycle_done:
            lead = "Scan requested from the console" if trigger == "manual" else "First scan"
            self.emit(
                "info",
                f"{lead}: {len(sources)} sources watched, {elevated} elevated, {len(flagged)} new or higher."
                + (" Rule-based, no model calls." if not assessed else ""),
                view="watch",
                data={"sources": len(sources), "elevated": elevated, "new": len(flagged)},
            )
        self._first_cycle_done = True
        if (
            sources
        ):  # a scan that read nothing (every view down) has learned nothing: stay in baseline
            self._baseline = False
        self.last_cycle = summary
        return summary

    def _save(self) -> None:
        self.state.save(
            {"statuses": self.prev, "auto_times": self.auto_times[-20:], "saved_at": now_utc()}
        )

    # ------------------------------------------------------- auto-assess

    def auto_status(self) -> dict:
        now = self.clock()
        day = [t for t in self.auto_times if now - t < 86400]
        hour = [t for t in day if now - t < 3600]
        nxt = None
        if self.per_hour and len(hour) >= self.per_hour:
            nxt = min(hour) + 3600
        if self.per_day and len(day) >= self.per_day:
            nxt = max(nxt or 0, min(day) + 86400)
        return {
            "enabled": self.auto_assess,
            "per_hour": self.per_hour,
            "per_day": self.per_day,
            "used_hour": len(hour),
            "used_day": len(day),
            "next_allowed_at": datetime.fromtimestamp(nxt, timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
            if nxt and nxt > now
            else None,
            "uses_model_calls": True,
            "blocked": self.persisted_reason,
        }

    def auto_allowed(self) -> bool:
        a = self.auto_status()
        return a["enabled"] and a["used_hour"] < self.per_hour and a["used_day"] < self.per_day

    def _maybe_auto_assess(self, new: list[Source]) -> str | None:
        """Start ONE full run for the most severe new source, when the switch and the caps allow."""
        if not self.auto_assess or self._runtime is None or not new:
            return None
        if not self.auto_allowed():
            return None
        pick = sorted(new, key=lambda s: (-RANK[s["status"]], -(s["ratio"] or 0), s["name"]))[0]
        from floodsense_agents.models import RunContext, RunRequest

        ctx: dict[str, Any] = {"role": "insurer", "page": "control-tower", "auto": True}
        if re.fullmatch(r"[\w .,'()-]{1,64}", pick["name"]):
            ctx["place"] = pick["name"]
        if pick["kind"] == "valencia":
            ctx["point_id"] = pick["ref"]
        elif pick["kind"] == "gauge" and re.fullmatch(r"[A-Za-zÄÖÜäöüß .-]{2,40}", pick["ref"]):
            ctx["station"] = pick["ref"]
        # Count it and save BEFORE the run starts: a crash right after must not forget the cap.
        self.auto_times.append(self.clock())
        self._save()
        try:
            req = RunRequest(question=assess_question(pick), context=RunContext(**ctx))
            accepted = self._runtime().start_async(req)
        except Exception as e:  # noqa: BLE001
            self.auto_times.pop()
            self._save()
            log.warning("auto-assess could not start: %s", e)
            self.emit(
                "info",
                f"Auto-assess could not start a run for {pick['name']} ({type(e).__name__}).",
                source=pick,
            )
            return None
        run_id = accepted["run_id"]
        self.auto_runs[run_id] = pick
        self.emit(
            "info",
            f"Auto-assess started a full investigation for {where(pick)} (model calls, capped at "
            f"{self.per_hour} per hour and {self.per_day} per day). It will wait for a person.",
            source=pick,
            view="runs",
            run_id=run_id,
            data={"auto": True},
        )
        return run_id

    # ------------------------------------------------------- run lifecycle

    def on_run(self, kind: str, run_id: str) -> None:
        """Runtime observer: ``paused`` (a run left the graph call) and ``resumed`` (a decision landed)."""
        if self._runtime is None:
            return
        try:
            snap = self._runtime().snapshot(run_id)
        except Exception:  # noqa: BLE001
            return
        src = self.auto_runs.get(run_id)
        ctx = (snap.get("request") or {}).get("context") or {}
        place = (src or {}).get("name") or ctx.get("place") or ""
        base = dict(
            run_id=run_id,
            view="runs",
            place=place,
            river=(src or {}).get("river", ""),
            country=(src or {}).get("country", ""),
            place_id=(src or {}).get("id"),
        )
        if kind == "paused":
            if snap.get("status") != "awaiting_approval" or run_id in self._announced:
                return
            self._announced.add(run_id)
            actions = snap.get("playbook") or []
            outbound = sum(1 for a in actions if a.get("outbound"))
            where_ = f" for {place}" if place else ""
            self.emit(
                "drafted",
                f"Playbook drafted {len(actions)} proposed {'action' if len(actions) == 1 else 'actions'}{where_} "
                f"({outbound} outbound, each waiting for a person). Nothing has been sent.",
                data={"actions": len(actions), "outbound": outbound},
                **base,
            )
            js = snap.get("judge_summary") or {}
            overall = _num(js.get("overall"))
            n_claims = len(snap.get("claims") or [])
            verdict = "passed" if js.get("passes") else "flagged some claims"
            self.emit(
                "awaiting_approval",
                f"Judge checked {n_claims} {'claim' if n_claims == 1 else 'claims'}"
                + (f" (overall score {overall:.2f})" if overall is not None else "")
                + f" and {verdict}. Waiting for a person in Approvals.",
                data={"claims": n_claims, "overall": overall, "passes": bool(js.get("passes"))},
                **base,
            )
        elif kind == "resumed":
            decision = ((snap.get("approval") or {}).get("decision")) or (
                snap.get("approval") or {}
            ).get("status")
            where_ = f" for {place}" if place else ""
            if decision in ("approve", "approved", "edit", "edited"):
                edited = decision in ("edit", "edited")
                self.emit(
                    "approved",
                    f"A person {'edited and approved' if edited else 'approved'} the run{where_}. "
                    f"Outbound drafts are released; FloodSense sends nothing itself.",
                    data={"decision": "edit" if edited else "approve"},
                    **base,
                )
            elif decision in ("reject", "rejected"):
                self.emit(
                    "info",
                    f"A person rejected the run{where_}; nothing was released.",
                    agent="Human",
                    data={"decision": "reject"},
                    **base,
                )

    # ----------------------------------------------------------- reading

    def awaiting_run_ids(self) -> list[str]:
        waiting: dict[str, int] = {}
        for e in self.store.all():
            rid = e.get("run_id")
            if not rid:
                continue
            if e["kind"] == "awaiting_approval":
                waiting[rid] = 1
            elif e["kind"] == "approved" or (e["kind"] == "info" and e["agent"] == "Human"):
                waiting.pop(rid, None)
        return list(waiting)

    def status(self) -> dict:
        lc = self.last_cycle
        return {
            "note": HONEST_LABEL,
            "loop": {
                "enabled": self.loop_enabled,
                "alive": bool(self._thread and self._thread.is_alive()),
                "interval_s": self.interval_s,
                "next_cycle_at": self.next_cycle_at,
            },
            "scanning": self.scanning,
            "started_at": self.started_at,
            "last_cycle": lc,
            "counts": {
                "sources": len(self.sources_now),
                "elevated": sum(1 for s in self.sources_now if is_elevated(s["status"])),
                "events": len(self.store),
                "awaiting_approval": len(self.awaiting_run_ids()),
            },
            "latest_event_id": self.store.latest_id(),
            "awaiting_run_ids": self.awaiting_run_ids(),
            "auto_assess": self.auto_status(),
            "persisted": self.persisted_reason is None and self.store.path is not None,
            "persisted_reason": self.persisted_reason
            or (None if self.store.path is not None else "The event history is not saved to disk."),
        }

    def set_auto_assess(self, enabled: bool) -> dict:
        if enabled and self.persisted_reason is not None:
            return self.auto_status()  # fails closed: the caps would not survive a restart
        self.auto_assess = bool(enabled)
        self.emit(
            "info",
            "Auto-assess switched ON by a person: the single most severe new source may start a full "
            f"investigation (model calls), at most {self.per_hour} per hour and {self.per_day} per day."
            if enabled
            else "Auto-assess switched OFF by a person: the watchers stay rule-based, with no model calls.",
            view="watch",
            agent="Human",
        )
        return self.auto_status()

    # ------------------------------------------------------------- loop

    def start(self) -> bool:
        """Start the background loop (a daemon thread). False when disabled or already running."""
        if not self.loop_enabled or (self._thread and self._thread.is_alive()):
            return False
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="control-tower", daemon=True)
        self._thread.start()
        return True

    def stop(self, wait_s: float = 0.0) -> None:
        """Signal the loop to end. With wait_s, also wait for a scan still writing to data_dir."""
        self._stop.set()
        if wait_s <= 0:
            return
        for thread in (self._thread, self._scan_thread):
            if thread and thread.is_alive():
                thread.join(wait_s)

    def _run(self) -> None:
        wait = 1.0  # first scan right after startup
        while not self._stop.wait(wait):
            try:
                self.cycle("loop")
            except Exception:  # noqa: BLE001 - the loop never dies
                log.exception("watch cycle failed")
            wait = max(5.0, self.interval_s)
            self.next_cycle_at = datetime.fromtimestamp(self.clock() + wait, timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
