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
MIN_GAP_S = 1.0  # per-process rate guard: at most one live call a second
_lock = threading.Lock()
_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}
_last_call = 0.0


@dataclass
class WebResult:
    status: str  # ok | empty | unavailable
    items: list[dict] = field(default_factory=list)  # title, url, content
    reason: str = ""
    query: str = ""
    latency_ms: int = 0
    cached: bool = False


def _ms(t0: float) -> int:
    return int((time.monotonic() - t0) * 1000)


def _query(place: str) -> str:
    return f"{place} flood warning current"


def search(place: str, *, transport: httpx.BaseTransport | None = None) -> WebResult:
    global _last_call
    key = settings.tavily_api_key
    if not key:
        return WebResult("unavailable", reason="TAVILY_API_KEY not set")
    ck = (place.strip().lower(), _query(place))
    now = time.monotonic()
    with _lock:
        hit = _cache.get(ck)
        if hit and now - hit[0] < TTL_S:
            return WebResult("ok" if hit[1] else "empty", hit[1], query=_query(place), cached=True)
        if now - _last_call < MIN_GAP_S:
            return WebResult("unavailable", reason="rate guard")
        _last_call = now
    t0 = time.monotonic()
    try:
        with httpx.Client(timeout=settings.tavily_timeout_s, transport=transport) as c:
            r = c.post(
                URL,
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "query": _query(place),
                    "topic": "news",
                    "time_range": "week",
                    "max_results": 3,
                    "search_depth": "basic",
                },
            )
        if r.status_code != 200:
            return WebResult("unavailable", reason=f"HTTP {r.status_code}", query=_query(place), latency_ms=_ms(t0))
        raw = r.json().get("results") or []
    except Exception as exc:  # timeout, transport, bad JSON
        log.warning("tavily unavailable: %s", type(exc).__name__)
        return WebResult("unavailable", reason=type(exc).__name__, query=_query(place), latency_ms=_ms(t0))
    items = [
        {"title": str(x.get("title") or ""), "url": x["url"], "content": str(x.get("content") or "")}
        for x in raw
        if isinstance(x, dict)
        and str(x.get("url") or "").startswith(("http://", "https://"))
        and str(x.get("content") or "").strip()
    ]
    with _lock:
        _cache[ck] = (time.monotonic(), items)
    return WebResult("ok" if items else "empty", items, query=_query(place), latency_ms=_ms(t0))


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
    return {"status": res.status, "query": res.query, "latency_ms": res.latency_ms, "cached": res.cached, "items": items}
