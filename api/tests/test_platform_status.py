"""GET /platform/status body (app/platform_status.py) and the latency counters."""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.metrics import Counters  # noqa: E402
from app.platform_status import build_platform_status  # noqa: E402
from app.ratelimit import RateLimiter, RateLimitSettings  # noqa: E402


class PlatformStatusTest(unittest.TestCase):
    def test_shape_and_no_secrets(self):
        c = Counters()
        for ms in (10, 20, 30, 40):
            c.run_latency("quick", ms)
        c.cache_hit()
        c.cache_miss()
        c.rejected()

        async def agents(method, path, **kw):
            if path == "/config":
                return 200, {"llm_backend": "nebius", "tavily": True, "data_backend": "zetaris", "lanes": {"fast": "m1", "deep": "m2"}, "nebius_api_key": "SECRET", "tavily_status": {"enabled": True, "key_configured": True, "calls": 3, "cache_hits": 1, "avg_latency_ms": 900, "last_status": "ok", "last_error": None, "api_key": "SECRET"}}
            return 200, {"counts": {"sources": 9}}

        cache = mock.Mock()
        cache.backend.return_value = "memory"
        body = asyncio.run(
            build_platform_status(
                cache=cache,
                limiter=RateLimiter(RateLimitSettings()),
                counters=c,
                agents_json=agents,
                lookup_timeout=None,
            )
        )
        self.assertEqual(body["llm_backend"], "nebius")
        self.assertEqual(body["lanes"], {"fast": "m1", "deep": "m2"})
        self.assertEqual(body["latency"]["quick"], {"n": 4, "p50_ms": 20, "p95_ms": 40})
        self.assertEqual(body["cache"]["hit_rate"], 0.5)
        self.assertEqual(body["rate_limit"]["rejected_429_recent"], 1)
        self.assertEqual(body["live_sources"], 9)
        self.assertIs(body["tavily"], True)
        self.assertEqual(body["data_backend"], "zetaris")
        self.assertEqual(body["tavily_status"]["calls"], 3)
        self.assertIs(body["tavily_status"]["key_configured"], True)
        self.assertNotIn("SECRET", json.dumps(body))


    def test_tavily_status_absent(self):
        from app.platform_status import _tavily

        self.assertIsNone(_tavily(None))
        self.assertIsNone(_tavily("x"))

    def test_project_web(self):
        from app.project import _project_web

        self.assertIsNone(_project_web({}))
        w = _project_web(
            {
                "web": {"status": "ok", "query": "Koeln flood warning current", "latency_ms": 12, "cached": False,
                        "retrieved_at": "2026-01-01T00:00:00Z", "items": [{"title": "T", "url": "https://e.org/a", "text": "x"}]},
                "web_check": {"claim_id": "C-1", "verdict": "supports", "url": "https://e.org/a", "note": "n", "label": "l"},
            }
        )
        self.assertEqual(w["n_results"], 1)
        self.assertEqual(w["results"][0]["retrieved_at"], "2026-01-01T00:00:00Z")
        self.assertEqual(w["web_check"]["verdict"], "supports")


if __name__ == "__main__":
    unittest.main()
