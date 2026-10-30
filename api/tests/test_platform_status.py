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
                return 200, {"llm_backend": "nebius", "tavily": True, "data_backend": "zetaris", "lanes": {"fast": "m1", "deep": "m2"}, "nebius_api_key": "SECRET"}
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
        self.assertNotIn("SECRET", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
