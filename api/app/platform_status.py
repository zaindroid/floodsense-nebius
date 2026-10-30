"""GET /platform/status: one small read-only body for the UI "Platform" strip.

No keys, URLs or .env values. Counters are this API process's (reset on restart).
Latency is of synchronous POST /runs seen here, per lane (app/metrics.py).
"""

from __future__ import annotations

import asyncio
from typing import Any



def _tavily(t: Any) -> dict[str, Any] | None:
    if not isinstance(t, dict):
        return None
    return {
        "enabled": t.get("enabled") is True,
        "key_configured": t.get("key_configured") is True,
        "calls": int(t.get("calls") or 0),
        "cache_hits": int(t.get("cache_hits") or 0),
        "avg_latency_ms": t.get("avg_latency_ms") if isinstance(t.get("avg_latency_ms"), int) else None,
        "last_status": t.get("last_status") if t.get("last_status") in ("ok", "empty", "unavailable") else None,
        "last_error": str(t["last_error"])[:80] if t.get("last_error") else None,
        "last_at": t.get("last_at"),
    }


async def build_platform_status(*, cache, limiter, counters, agents_json, lookup_timeout) -> dict[str, Any]:
    async def get(path: str) -> dict[str, Any]:
        code, data = await agents_json("GET", path, timeout=lookup_timeout)
        return data if code == 200 and isinstance(data, dict) else {}

    cfg, watch = await asyncio.gather(get("/config"), get("/watch/status"))
    snap = counters.snapshot()
    lookups = snap["cache_hits"] + snap["cache_misses"]
    rl = limiter.settings
    return {
        "agents_ok": bool(cfg),
        "llm_backend": cfg.get("llm_backend"),
        "lanes": {k: str(v) for k, v in (cfg.get("lanes") or {}).items()},
        "data_backend": cfg.get("data_backend") or "zetaris",
        "tavily": cfg.get("tavily") is True,
        # Additive: switch, key-configured boolean (never the key) and agents-process counters.
        "tavily_status": _tavily(cfg.get("tavily_status")),
        "latency": counters.latency_stats(),
        # Additive: last POST /llm/check on the agents (null until run) and token usage since agents start.
        "llm_check": cfg.get("llm_check"),
        "llm_usage": cfg.get("llm_usage"),
        "cache": {
            "backend": await asyncio.to_thread(cache.backend),
            "hits": snap["cache_hits"],
            "misses": snap["cache_misses"],
            "hit_rate": round(snap["cache_hits"] / lookups, 3) if lookups else None,
        },
        "rate_limit": {
            "in_flight": limiter.slots.in_flight,
            "max_concurrent": rl.max_concurrent_runs,
            "runs_per_min": rl.runs_per_min,
            "rejected_429_recent": counters.recent_rejections(),
            "rejected_429_total": snap["rejected_429_total"],
        },
        "live_sources": (watch.get("counts") or {}).get("sources"),
        "counters_since_utc": snap["since_utc"],
    }
