"""GET /system: what memory, cache, rate limits and models are doing right now.

Read-only and safe to poll every few seconds. It never returns a URL with
credentials, a key, a token or a .env value. Every dependency is optional: an
engines or agents outage is a field with ``ok: false``, never a failed request.

Sources:
- cache and rate limits: this API process (app/cache.py, app/ratelimit.py,
  app/metrics.py). Counters reset when the API restarts.
- memory and World Model: the engines sidecar (ENGINES_URL, read-only routes
  GET /health, GET /hmem/memories, GET /wm/board). Listing memories does not
  run an H-MEM query, so polling changes no access counts or ledger.
- models: the agents' GET /config and the newest run's model_ids.
- RAG: no cheap count query is exposed yet, so the counts are null.
"""

from __future__ import annotations

import asyncio
import os
from collections import Counter
from typing import Any, Awaitable, Callable

import httpx

SEED_REVIEWER = "demo-seed"
LATEST_MEMORIES = 5
SHORT_TEXT = 160
BOARD_ITEMS = 8
ENGINES_TIMEOUT = httpx.Timeout(2.0, connect=1.0)

AgentsJson = Callable[..., Awaitable[tuple[int, Any]]]


def engines_url() -> str | None:
    raw = (os.environ.get("ENGINES_URL") or "").strip().rstrip("/")
    return raw or None


def _short(text: Any, n: int = SHORT_TEXT) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def is_seeded(memory: dict[str, Any]) -> bool:
    """A memory written by `tasks.py demo-seed`: reviewer demo-seed, or a demo-seed run id."""
    label = str((memory.get("provenance") or {}).get("label") or "")
    run_id = str(memory.get("run_id") or "")
    return f"by {SEED_REVIEWER}" in label or run_id.startswith(SEED_REVIEWER)


def memory_row(memory: dict[str, Any]) -> dict[str, Any]:
    prov = memory.get("provenance") or {}
    return {
        "id": memory.get("memory_id"),
        "run_id": memory.get("run_id"),
        "event_id": memory.get("event_id"),
        "approved_at": prov.get("learned_at"),
        "text": _short(memory.get("content")),
        "label": prov.get("label") or None,
        "seeded": is_seeded(memory),
    }


def board_summary(board: list[dict[str, Any]], run_id: str | None) -> dict[str, Any]:
    """Status counts and the first few links of one run's hypothesis board."""
    rows = [b for b in board if isinstance(b, dict) and (run_id is None or b.get("run_id") == run_id)]
    if run_id is None and rows:
        run_id = max(rows, key=lambda b: str(b.get("updated_at") or "")).get("run_id")
        rows = [b for b in rows if b.get("run_id") == run_id]
    statuses = Counter(str(b.get("status") or "proposed") for b in rows)
    return {
        "run_id": run_id,
        "hypotheses": len(rows),
        "by_status": dict(sorted(statuses.items())),
        "items": [
            {
                "hypothesis_id": b.get("hypothesis_id"),
                "link": b.get("link"),
                "status": b.get("status"),
                "confidence": b.get("confidence"),
                "statement": _short(b.get("statement"), 120),
            }
            for b in rows[:BOARD_ITEMS]
        ],
    }


async def _engines_get(
    client: httpx.AsyncClient, path: str, params: dict | None = None
) -> tuple[bool, Any, str | None]:
    try:
        r = await client.get(path, params=params)
    except httpx.HTTPError as e:
        return False, None, f"engines not reachable ({type(e).__name__})"
    try:
        data = r.json()
    except ValueError:
        data = None
    if r.status_code >= 400 or not isinstance(data, dict):
        return False, None, f"engines GET {path} returned HTTP {r.status_code}"
    return True, data, None


async def _latest_run(agents_json: AgentsJson, timeout) -> dict[str, Any] | None:
    code, past = await agents_json("GET", "/runs/past", params={"limit": 1}, timeout=timeout)
    rows = past.get("runs") if code == 200 and isinstance(past, dict) else None
    if not rows or not isinstance(rows[0], dict) or not rows[0].get("run_id"):
        return None
    row = rows[0]
    code, run = await agents_json("GET", f"/runs/{row['run_id']}", timeout=timeout)
    run = run if code == 200 and isinstance(run, dict) else {}
    return {
        "run_id": row["run_id"],
        "event_id": row.get("event_id") or run.get("event_id"),
        "status": run.get("status") or row.get("status"),
        "served_from": run.get("served_from"),
        "model_ids": [str(m) for m in (run.get("model_ids") or [])],
    }


def _models(config: dict[str, Any] | None, latest: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(config, dict):
        return {"ok": False, "error": "agents /config not reachable"}
    flags = config.get("flags") or {}
    return {
        "ok": True,
        "lanes": {k: str(v) for k, v in (config.get("lanes") or {}).items()},
        "flags": {k: bool(v) for k, v in flags.items()},
        "latest_model_ids": (latest or {}).get("model_ids") or [],
        "llm_check": config.get("llm_check"),
        "llm_usage": config.get("llm_usage"),
    }


def _watch(status: dict[str, Any] | None) -> dict[str, Any]:
    """The control tower, from the agents' GET /watch/status. Counts and switches only."""
    if not isinstance(status, dict) or "loop" not in status:
        return {"ok": False, "error": "agents /watch/status not reachable"}
    last = status.get("last_cycle") or {}
    auto = status.get("auto_assess") or {}
    counts = status.get("counts") or {}
    return {
        "ok": True,
        "loop_enabled": bool((status.get("loop") or {}).get("enabled")),
        "interval_s": (status.get("loop") or {}).get("interval_s"),
        "last_cycle_at": last.get("finished_at"),
        "sources": counts.get("sources"),
        "elevated": counts.get("elevated"),
        "events": counts.get("events"),
        "awaiting_approval": counts.get("awaiting_approval"),
        "auto_assess": {
            "enabled": bool(auto.get("enabled")),
            "per_hour": auto.get("per_hour"),
            "per_day": auto.get("per_day"),
            "used_hour": auto.get("used_hour"),
            "used_day": auto.get("used_day"),
        },
        "model_calls": "none in the loop; only an auto-assessed full run uses the model",
    }


async def build_system(
    *,
    cache,
    limiter,
    counters,
    agents_json: AgentsJson,
    lookup_timeout,
    engines_base: str | None = None,
    engines_transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """The /system body. Each section degrades on its own."""
    engines_base = engines_base if engines_base is not None else engines_url()

    async def config():
        code, data = await agents_json("GET", "/config", timeout=lookup_timeout)
        return data if code == 200 and isinstance(data, dict) else None

    async def watch():
        code, data = await agents_json("GET", "/watch/status", timeout=lookup_timeout)
        return data if code == 200 and isinstance(data, dict) else None

    cfg, latest, watch_status = await asyncio.gather(
        config(), _latest_run(agents_json, lookup_timeout), watch()
    )

    memory: dict[str, Any]
    world: dict[str, Any]
    engines: dict[str, Any]
    if not engines_base:
        engines = {"configured": False, "ok": False, "error": "ENGINES_URL is not set on the API"}
        memory = {"ok": False, "count": None, "latest": [], "seeded": 0}
        world = {"ok": False, "run_id": None, "hypotheses": 0, "by_status": {}, "items": []}
    else:
        async with httpx.AsyncClient(
            base_url=engines_base, timeout=ENGINES_TIMEOUT, transport=engines_transport
        ) as client:
            run_id = (latest or {}).get("run_id")
            (h_ok, health, h_err), (m_ok, mems, m_err), (b_ok, board, b_err) = await asyncio.gather(
                _engines_get(client, "/health"),
                _engines_get(client, "/hmem/memories", {"limit": LATEST_MEMORIES}),
                _engines_get(client, "/wm/board", {"run_id": run_id} if run_id else None),
            )
        hmem = (health or {}).get("hmem") or {}
        wm = (health or {}).get("world_model") or {}
        engines = {
            "configured": True,
            "ok": h_ok,
            "error": h_err,
            "hmem_memories": hmem.get("memories"),
            "wm_events": wm.get("events"),
            "wm_hypotheses": wm.get("hypotheses"),
        }
        rows = [memory_row(m) for m in ((mems or {}).get("memories") or []) if isinstance(m, dict)]
        memory = {
            "ok": m_ok,
            "error": m_err,
            "count": (mems or {}).get("total", hmem.get("memories")),
            "latest": rows,
            "seeded": sum(1 for r in rows if r["seeded"]),
        }
        world = {"ok": b_ok, "error": b_err, **board_summary((board or {}).get("board") or [], run_id)}

    keys, backend = await asyncio.gather(
        asyncio.to_thread(cache.key_counts), asyncio.to_thread(cache.backend)
    )
    seeded_runs = await asyncio.to_thread(cache.demo_seeded_live)
    snap = counters.snapshot()
    rl = limiter.settings
    flags = (cfg or {}).get("flags") or {}
    return {
        "counters_since_utc": snap["since_utc"],
        "cache": {
            "backend": backend,
            "semantic_cache": cache.settings.semantic_cache,
            "cached_replay": cache.settings.cached_replay,
            "keys": keys,
            "hits": snap["cache_hits"],
            "misses": snap["cache_misses"],
            "replays_served": snap["replays_served"],
            "seeded_runs": seeded_runs,
        },
        "rate_limit": {
            "runs_per_min_per_client": rl.runs_per_min,
            "max_concurrent_runs": rl.max_concurrent_runs,
            "in_flight": limiter.slots.in_flight,
            "rejected_429_recent": counters.recent_rejections(),
            "rejected_429_total": snap["rejected_429_total"],
            "recent_window_s": 300,
        },
        "engines": engines,
        "memory": memory,
        "world_model": world,
        "models": _models(cfg, latest),
        "latest_run": latest,
        "watch": _watch(watch_status),
        "rag": {
            "enabled": bool(flags.get("FF_RAG_DOCS")) if cfg else None,
            "documents": None,
            "passages": None,
            "note": "no cheap count query is exposed yet",
        },
    }
