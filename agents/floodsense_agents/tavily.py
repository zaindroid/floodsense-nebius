"""Tavily Search as a labelled, cited web-context source (FF_TAVILY, default off).

POST https://api.tavily.com/search, `Authorization: Bearer <key>`, JSON body with
`query`; the 200 reply has `results[]` with title, url, content, score
(https://docs.tavily.com/documentation/api-reference/endpoint/search).

Never raises into a run: any failure is `unavailable`. Web text is context, not
an official warning, and never supplies a number to a claim.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx

from floodsense_agents.settings import settings

log = logging.getLogger("floodsense.tavily")
URL = "https://api.tavily.com/search"
LABEL = "Web context, not an official warning"
TTL_S = 900.0
MAX_WAIT_S = 1.0  # longest a call queues behind the guard before it reports unavailable
MIN_GAP_S = 1.0  # per-process rate guard: at most one live call a second
# Social posts came back as "news" for a Paiporta question (two of three results
# were Facebook). They are not evidence a reviewer can weigh, so they are not asked for.
EXCLUDE_DOMAINS = [
    "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com",
    "youtube.com", "reddit.com", "threads.net", "linkedin.com", "pinterest.com",
]
_lock = threading.Lock()
_cache: dict[tuple[str, str], tuple[float, list[dict], str]] = {}
_last_call = 0.0
# Process counters for /config -> /platform/status. Never holds the key.
_stats = {"calls": 0, "cache_hits": 0, "live_calls": 0, "live_ms": 0, "last_status": None, "last_error": None, "last_at": None}


@dataclass
class WebResult:
    status: str  # ok | empty | unavailable
    items: list[dict] = field(default_factory=list)  # title, url, content
    reason: str = ""
    query: str = ""
    latency_ms: int = 0
    cached: bool = False
    retrieved_at: str = ""  # UTC ISO of the live fetch (kept on cache hits)


def _ms(t0: float) -> int:
    return int((time.monotonic() - t0) * 1000)


# Region terms per place (country plus native-language words). shortcut: no include_domains,
# a second narrower call would double latency; official sites are only ranked by the query words.
_REGIONS = {
    "ES": "Spain inundaciones aviso AEMET",
    "DE": "Germany Hochwasser Warnung",
}


def _region(place: str) -> str | None:
    from floodsense_agents.events import _GERMAN_RE, _VALENCIA_RE

    return "DE" if _GERMAN_RE.search(place) else "ES" if _VALENCIA_RE.search(place) else None


def _query(place: str) -> str:
    r = _region(place)
    if re.search(r"\b(ahr|ahrtal|altenahr|ahrweiler)\b", place, re.I):
        return "Ahrtal Ahrweiler Hochwasser Warnung Rheinland-Pfalz"
    return f"{place} {_REGIONS[r]}" if r else f"{place} flood warning current"


# Demo events carry no context.place; their search place comes from the event. Live/other: none.
_EVENT_PLACE = {"EMSR773": "Valencia", "EMSR517": "Ahr"}


def web_place(state) -> str:
    """Place for the web check: context.place if given, else the known event's place, else ''."""
    place = ((state.get("request") or {}).get("context") or {}).get("place")
    if isinstance(place, str) and place.strip():
        return place.strip()
    return _EVENT_PLACE.get(str(state.get("event_id") or ""), "")


def should_search(state) -> bool:
    """The Investigator's gate: flag on, not the watch event, and a place (given or from the event)."""
    from floodsense_agents.events import WATCH_EVENT

    return bool(settings.ff_tavily and state.get("event_id") != WATCH_EVENT and web_place(state))


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def stats() -> dict:
    """Counters since process start: calls, cache hits, avg live latency, last status and error reason."""
    with _lock:
        s = dict(_stats)
    n = s.pop("live_calls")
    ms = s.pop("live_ms")
    return {**s, "avg_latency_ms": round(ms / n) if n else None}


def search(place: str, *, transport: httpx.BaseTransport | None = None) -> WebResult:
    place = place.strip()[:80]  # untrusted request text: capped before it leaves
    res = _search(place, transport=transport)
    with _lock:
        _stats["calls"] += 1
        _stats["cache_hits"] += int(res.cached)
        if not res.cached and res.latency_ms:
            _stats["live_calls"] += 1
            _stats["live_ms"] += res.latency_ms
        _stats.update(last_status=res.status, last_at=_now(), last_error=res.reason or None if res.status == "unavailable" else None)
    return res


def _search(place: str, *, transport: httpx.BaseTransport | None = None) -> WebResult:
    global _last_call
    key = settings.tavily_api_key
    if not key:
        return WebResult("unavailable", reason="TAVILY_API_KEY not set")
    ck = (place.strip().lower(), _query(place))
    now = time.monotonic()
    with _lock:
        hit = _cache.get(ck)
        if hit and now - hit[0] < TTL_S:
            return WebResult("ok" if hit[1] else "empty", hit[1], query=_query(place), cached=True, retrieved_at=hit[2])
        slot = max(now, _last_call + MIN_GAP_S)  # queue behind the previous live call
        if slot - now > MAX_WAIT_S:
            return WebResult("unavailable", reason="rate guard")
        _last_call = slot
    if slot > now:
        time.sleep(slot - now)
    t0 = time.monotonic()
    try:
        with httpx.Client(timeout=settings.tavily_timeout_s, transport=transport) as c:
            r = c.post(
                URL,
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "query": _query(place),
                    "topic": "news",
                    "time_range": "month",
                    "max_results": 5,
                    "search_depth": "basic",
                    "exclude_domains": EXCLUDE_DOMAINS,
                },
            )
        if r.status_code != 200:
            return WebResult("unavailable", reason=f"HTTP {r.status_code}", query=_query(place), latency_ms=_ms(t0))
        raw = r.json().get("results") or []
    except Exception as exc:  # timeout, transport, bad JSON
        log.warning("tavily unavailable: %s", type(exc).__name__)
        return WebResult("unavailable", reason=type(exc).__name__, query=_query(place), latency_ms=_ms(t0))
    got_at = _now()
    items = [
        {"title": str(x.get("title") or ""), "url": x["url"], "content": str(x.get("content") or "")}
        for x in raw
        if isinstance(x, dict)
        and str(x.get("url") or "").startswith(("http://", "https://"))
        and str(x.get("content") or "").strip()
    ]
    with _lock:
        _cache[ck] = (time.monotonic(), items, got_at)
    return WebResult("ok" if items else "empty", items, query=_query(place), latency_ms=_ms(t0), retrieved_at=got_at)


_NUM = re.compile(r"\d[\d.,:/-]*\s*[A-Za-zµ%°]*")
_JUNK = re.compile(r"[\x00-\x1f\x7f<>{}\[\]`\\\"]+")


def clean(text: str, cap: int) -> str:
    """Untrusted web text as inert data: one line, no markup or quotes, no digits or units.

    Digits go because a claim's `numbers` list is empty and the Judge would not check them.
    """
    t = _NUM.sub("[n]", _JUNK.sub(" ", text))
    return " ".join(t.split())[:cap].strip()


def passages(items: list[dict], retrieved_at: str, limit: int = 220) -> list[dict]:
    """Result rows as layer (c) passage dicts (the shape investigator._cite_passage reads)."""
    out = []
    for n, it in enumerate(items, 1):
        text = clean(it["content"], 1500)
        quote = text
        if len(quote) > limit:
            quote = quote[:limit]
            quote = quote[: quote.rfind(" ")] if " " in quote else quote
        host = urlparse(it["url"]).netloc
        out.append(
            {
                "query_id": f"web-{n}",
                "chunk_id": f"web-{n}",
                "source_url": it["url"],
                "title": clean(it["title"], 80) or host,
                "publisher": host,
                "attribution": f"{LABEL}; retrieved {retrieved_at} via Tavily",
                "locator": {"page": 1, "paragraph": n, "lines": "web snippet"},
                "quote": quote,
                "content_sha256": hashlib.sha256(quote.encode()).hexdigest(),
                "text": text,
                "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
        )
    return out


def tavily_line(res: WebResult) -> str:
    """Trace summary for the call: query, result count, latency, cached. Never the key."""
    if res.status == "unavailable":
        return f"tavily unavailable ({res.reason}); query {res.query or '-'}"
    return (
        f"tavily query {res.query!r}; {len(res.items)} results; {res.latency_ms} ms; "
        f"cached {'yes' if res.cached else 'no'}"
    )


def tavily_state(res: WebResult) -> dict:
    """What the Skeptic may read: cleaned, digit-free quoted data, never instructions."""
    items = [
        {"title": clean(i["title"], 80), "url": i["url"], "text": clean(i["content"], 300)}
        for i in res.items
    ]
    return {
        "status": res.status,
        "query": res.query,
        "latency_ms": res.latency_ms,
        "cached": res.cached,
        "retrieved_at": res.retrieved_at or None,
        "items": items,
    }


def live_check(*, transport: httpx.BaseTransport | None = None) -> dict:
    """One real tiny search for readiness: no cache, no rate guard, no run counters. Never the key."""
    key = settings.tavily_api_key
    if not key:
        return {"configured": False, "ok": False, "status": "unavailable", "n_results": 0, "latency_ms": 0, "error": "TAVILY_API_KEY not set"}
    t0 = time.monotonic()
    try:
        with httpx.Client(timeout=settings.tavily_timeout_s, transport=transport) as c:
            r = c.post(URL, headers={"Authorization": f"Bearer {key}"}, json={"query": "Valencia flood", "max_results": 1})
        if r.status_code != 200:
            return {"configured": True, "ok": False, "status": "unavailable", "n_results": 0, "latency_ms": _ms(t0), "error": f"HTTP {r.status_code}"}
        n = len(r.json().get("results") or [])
    except Exception as exc:  # reported, never raised
        return {"configured": True, "ok": False, "status": "unavailable", "n_results": 0, "latency_ms": _ms(t0), "error": type(exc).__name__}
    return {"configured": True, "ok": True, "status": "ok" if n else "empty", "n_results": n, "latency_ms": _ms(t0), "error": None}
