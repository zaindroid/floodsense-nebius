"""Server-side cache for GET /views/{name}.

The live views (eu_watch, hazard_now, ...) are Zetaris REST tables that call
Open-Meteo at query time. Without a cache every page load, reviewer browser,
tower scan and agent run repeats those calls, and Open-Meteo answers 429.

- Keyed by view name and query string. TTL 600 s for the live REST views,
  120 s for gauge_levels (the poller writes every 10 minutes), 1 h for
  ``source=replay`` (static). Other views pass through uncached.
- Single flight: concurrent requests for one key share one upstream call.
- Stale-if-error: when the upstream fails (5xx, 429, timeout) and a copy up to
  24 h old exists, it is served with ``x-views-cache: stale`` and
  ``x-views-age-s``; the copy keeps its own ``x-query-id`` and
  ``x-executed-at``. A stale copy is never labelled fresh. With no copy the
  upstream error goes through unchanged. Errors are never cached.
- Persisted in Redis when the answer cache has it (same client, ``views``
  namespace under the ``v1`` prefix style), and always held in memory, so a
  restart with Redis keeps the last good copies.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode

log = logging.getLogger("floodsense.views_cache")

VIEWS_PREFIX = "floodsense:views:v1:"
LIVE_TTL_S = 600.0
GAUGE_TTL_S = 120.0
REPLAY_TTL_S = 3600.0
MAX_STALE_S = 24 * 3600.0
LIVE_VIEWS = ("eu_watch", "hazard_now", "weather_forecast", "discharge_daily", "rain_hourly", "hazard_timeline")
TTLS = {**{v: LIVE_TTL_S for v in LIVE_VIEWS}, "gauge_levels": GAUGE_TTL_S}
WARM_VIEWS = (*LIVE_VIEWS, "gauge_levels")
WARM_GAP_S = 5.0
MEMORY_MAX = 200

# (status, body text, content type, upstream x-* headers); raises on a transport failure.
Raw = tuple[int, str, str, dict[str, str]]
Upstream = Callable[[], Awaitable[Raw]]


def ttl_for(name: str, params: dict[str, str] | None) -> float | None:
    """Seconds a copy stays fresh, or None for a view that is not cached."""
    if (params or {}).get("source") == "replay":
        return REPLAY_TTL_S
    return TTLS.get(name)


def query_of(params: dict[str, str] | None) -> str:
    return urlencode(sorted((params or {}).items()))


def _failure(status: int) -> bool:
    return status >= 500 or status == 429


def _empty(body: str) -> bool:
    """An empty list, empty rows or no body: a live REST view that answers this has lost its data."""
    text = body.strip()
    if text in ("", "[]", "{}", "null"):
        return True
    try:
        value = json.loads(text)
    except ValueError:
        return False
    return isinstance(value, dict) and value.get("rows") == []


@dataclass
class Copy:
    status: int
    body: str
    content_type: str
    headers: dict[str, str]
    stored_at: float

    def as_json(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "body": self.body,
            "content_type": self.content_type,
            "headers": self.headers,
            "stored_at": self.stored_at,
        }


@dataclass
class Served:
    status: int
    body: str
    content_type: str
    headers: dict[str, str]
    cache: str | None  # hit | miss | stale | None (not cached)
    age_s: int = 0

    def response_headers(self) -> dict[str, str]:
        out = dict(self.headers)
        if self.cache:
            out["x-views-cache"] = self.cache
            out["x-views-age-s"] = str(self.age_s)
        return out


def _blank() -> dict[str, Any]:
    return {"hits": 0, "misses": 0, "stale_serves": 0, "last_upstream_error": None, "last_ok_at": None}


class ViewsCache:
    def __init__(self, store: Any = None, clock: Callable[[], float] = time.time) -> None:
        self._store = store  # app.cache._RedisStore or None
        self._clock = clock
        self._mem: dict[str, Copy] = {}
        self._lock = threading.Lock()
        self._flights: dict[str, asyncio.Future] = {}
        self._stats: dict[str, dict[str, Any]] = {}

    # -- storage -----------------------------------------------------------
    @staticmethod
    def slot(name: str, query: str) -> str:
        return VIEWS_PREFIX + hashlib.sha256(f"{name}?{query}".encode()).hexdigest()

    def backend(self) -> str:
        return "redis" if self._store is not None and self._store.up else "memory"

    def lookup(self, name: str, query: str) -> Copy | None:
        slot = self.slot(name, query)
        with self._lock:
            copy = self._mem.get(slot)
        if copy is None and self._store is not None:
            answered, value = self._store.get_json(slot)
            if answered and value:
                try:
                    copy = Copy(
                        int(value["status"]),
                        str(value["body"]),
                        str(value["content_type"]),
                        {str(k): str(v) for k, v in dict(value["headers"]).items()},
                        float(value["stored_at"]),
                    )
                except (KeyError, TypeError, ValueError):
                    copy = None
                if copy is not None:
                    with self._lock:
                        self._mem[slot] = copy
        if copy is not None and self._clock() - copy.stored_at > MAX_STALE_S:
            return None
        return copy

    def store(self, name: str, query: str, copy: Copy) -> None:
        slot = self.slot(name, query)
        with self._lock:
            # store() runs only on a successful upstream read
            self._stats.setdefault(name, _blank())["last_ok_at"] = time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(self._clock())
            )
            if len(self._mem) >= MEMORY_MAX and slot not in self._mem:
                oldest = min(self._mem, key=lambda k: self._mem[k].stored_at)
                del self._mem[oldest]
            self._mem[slot] = copy
        if self._store is not None:
            self._store.set_json(slot, copy.as_json(), MAX_STALE_S)

    # -- stats -------------------------------------------------------------
    def _bump(self, name: str, field: str) -> None:
        with self._lock:
            self._stats.setdefault(name, _blank())[field] += 1

    def _error(self, name: str, detail: str) -> None:
        with self._lock:
            self._stats.setdefault(name, _blank())["last_upstream_error"] = {
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self._clock())),
                "detail": detail[:200],
            }

    def stats(self) -> dict[str, Any]:
        with self._lock:
            views = {k: dict(v) for k, v in self._stats.items()}
        return {
            "backend": self.backend(),
            "hits": sum(v["hits"] for v in views.values()),
            "misses": sum(v["misses"] for v in views.values()),
            "stale_serves": sum(v["stale_serves"] for v in views.values()),
            "ttl_s": {"live": LIVE_TTL_S, "gauge_levels": GAUGE_TTL_S},
            "views": views,
        }

    # -- serving -----------------------------------------------------------
    def _fresh(self, copy: Copy | None, ttl: float) -> bool:
        return copy is not None and self._clock() - copy.stored_at < ttl

    def _from_copy(self, copy: Copy, label: str) -> Served:
        age = max(0, int(self._clock() - copy.stored_at))
        return Served(copy.status, copy.body, copy.content_type, dict(copy.headers), label, age)

    async def _call(self, name: str, query: str, upstream: Upstream) -> Copy | Raw:
        """One upstream call; a 200 is stored. Returns the Copy, or the raw failure."""
        result = await upstream()
        status, body, ctype, headers = result
        if status == 200 and not _empty(body):
            copy = Copy(status, body, ctype, headers, self._clock())
            await asyncio.to_thread(self.store, name, query, copy)
            return copy
        return result

    async def get(self, name: str, params: dict[str, str] | None, upstream: Upstream) -> Served:
        """Serve from cache, or call ``upstream`` once for all concurrent callers.

        Raises whatever ``upstream`` raises when it fails and no copy exists.
        """
        ttl = ttl_for(name, params)
        if ttl is None:
            status, body, ctype, headers = await upstream()
            return Served(status, body, ctype, headers, None)
        query = query_of(params)
        copy = await asyncio.to_thread(self.lookup, name, query)
        if self._fresh(copy, ttl):
            self._bump(name, "hits")
            assert copy is not None
            return self._from_copy(copy, "hit")
        slot = self.slot(name, query)
        flight = self._flights.get(slot)
        leader = flight is None
        if flight is None:
            # The call runs in its own task: a cancelled leader does not cancel the waiters' result.
            flight = asyncio.ensure_future(self._call(name, query, upstream))
            self._flights[slot] = flight

            def _done(t: asyncio.Future, slot: str = slot) -> None:
                self._flights.pop(slot, None)
                if not t.cancelled():
                    t.exception()  # mark retrieved when nobody awaits

            flight.add_done_callback(_done)
        try:
            outcome = await asyncio.shield(flight)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - transport failure of the shared call
            if leader:
                self._error(name, f"{type(exc).__name__}: {exc}")
            if copy is not None:
                if leader:
                    self._bump(name, "stale_serves")
                return self._from_copy(copy, "stale")
            raise
        if isinstance(outcome, Copy):
            if leader:
                self._bump(name, "misses")
            else:
                self._bump(name, "hits")
            return self._from_copy(outcome, "miss" if leader else "hit")
        status, body, ctype, headers = outcome
        bad = _failure(status) or (status == 200 and _empty(body))
        if leader and bad:
            self._error(name, "empty 200 body" if status == 200 else f"HTTP {status}")
        if bad and copy is not None:
            if leader:
                self._bump(name, "stale_serves")
            return self._from_copy(copy, "stale")
        return Served(status, body, ctype, headers, None)

    # -- warm-up -----------------------------------------------------------
    def warm(
        self,
        fetch: Callable[[str], Raw],
        names: tuple[str, ...] = WARM_VIEWS,
        gap_s: float = WARM_GAP_S,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """Blocking: one call per view, serialized, ``gap_s`` apart. Skips views already fresh."""
        called = False
        for name in names:
            ttl = ttl_for(name, None)
            if ttl is None or self._fresh(self.lookup(name, ""), ttl):
                continue
            if called:
                sleep(gap_s)
            called = True
            try:
                status, body, ctype, headers = fetch(name)
            except Exception as exc:  # noqa: BLE001 - warm-up never stops the API
                self._error(name, f"warm-up {type(exc).__name__}")
                log.warning("views cache warm-up for %s failed: %s", name, type(exc).__name__)
                continue
            if status == 200 and not _empty(body):
                self.store(name, "", Copy(status, body, ctype, headers, self._clock()))
            else:
                self._error(name, f"warm-up HTTP {status}")
