"""Official Token Factory model metadata: price, rate limits, region.

``GET {NEBIUS_BASE_URL}/models?verbose=true`` lists, per model, ``pricing``
(USD per token, as strings), ``per_request_limits`` and ``regions``. Cached
for an hour. Never raises: any failure gives an empty catalog and the caller
falls back to "price not configured" and its own defaults.
"""

from __future__ import annotations

import threading
import time
from typing import Callable

import httpx

from floodsense_agents.settings import settings

TTL_S = 3600.0
FAIL_TTL_S = 60.0  # do not hammer a failing endpoint

_lock = threading.Lock()
_cache: tuple[float, dict[str, dict]] | None = None  # (expires at, id.lower() -> info)


def _f(v: object) -> float | None:
    try:
        x = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return x if x >= 0 and x == x and x != float("inf") else None


def parse_models(body: object) -> dict[str, dict]:
    out: dict[str, dict] = {}
    data = body.get("data") if isinstance(body, dict) else None
    for m in data if isinstance(data, list) else []:
        if not isinstance(m, dict) or not isinstance(m.get("id"), str):
            continue
        p = m.get("pricing") if isinstance(m.get("pricing"), dict) else {}
        lim = m.get("per_request_limits") if isinstance(m.get("per_request_limits"), dict) else {}
        regs = [r for r in (m.get("regions") or []) if isinstance(r, dict)]
        out[m["id"].lower()] = {
            "model_id": m["id"],
            "prompt": _f(p.get("prompt")),
            "completion": _f(p.get("completion")),
            "cache_read": _f(p.get("input_cache_read")),
            "rpm": _f(lim.get("requests_per_minute")),
            "tpm": _f(lim.get("tokens_per_minute")),
            "regions": [{"country": r.get("country_code"), "name": r.get("name")} for r in regs],
            "context_length": m.get("context_length") if isinstance(m.get("context_length"), int) else None,
        }
    return out


def catalog(
    *, get: Callable[..., httpx.Response] | None = None, now: Callable[[], float] = time.monotonic
) -> dict[str, dict]:
    """The cached model table (lower-cased id -> info); {} when not nebius or never fetched.

    The HTTP fetch runs outside the lock. A failed refresh keeps the last good
    table (stale-while-error) and retries after FAIL_TTL_S.
    """
    global _cache
    if settings.llm_backend != "nebius" or not settings.nebius_api_key:
        return {}
    with _lock:
        cur = _cache
        if cur and now() < cur[0]:
            return cur[1]
    try:
        r = (get or httpx.get)(
            f"{settings.nebius_base_url.rstrip('/')}/models",
            params={"verbose": "true"},
            headers={"Authorization": f"Bearer {settings.nebius_api_key}"},
            timeout=5.0,
        )
        table = parse_models(r.json()) if r.status_code == 200 else {}
    except Exception:  # noqa: BLE001 - metadata is best effort
        table = {}
    with _lock:
        if table:
            _cache = (now() + TTL_S, table)
        else:
            _cache = (now() + FAIL_TTL_S, cur[1] if cur else {})
        return _cache[1]


def prewarm() -> None:
    """Fill the cache in a daemon thread so /config never waits on the first fetch."""
    threading.Thread(target=catalog, daemon=True, name="tokenfactory-prewarm").start()


def reset() -> None:
    global _cache
    with _lock:
        _cache = None


def info(model_id: str | None, **kw) -> dict | None:
    return catalog(**kw).get((model_id or "").lower())


def cost_usd(inf: dict | None, prompt: int, completion: int, cached: int = 0) -> float | None:
    """Cost of the given tokens at ``inf``'s prices; cached tokens use the cache-read price only if it exists."""
    if not inf or inf.get("prompt") is None or inf.get("completion") is None:
        return None
    cached = min(cached, prompt) if inf.get("cache_read") is not None else 0
    return (
        (prompt - cached) * inf["prompt"]
        + cached * (inf["cache_read"] or 0)
        + completion * inf["completion"]
    )
