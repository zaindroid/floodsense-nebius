"""Rate limits: per-client token bucket and the cap on live runs in flight."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as api  # noqa: E402
from app.ratelimit import RateLimiter, RateLimitSettings, TokenBuckets  # noqa: E402


class TokenBucketTest(unittest.TestCase):
    def test_burst_then_refill(self) -> None:
        now = [0.0]
        b = TokenBuckets(2, clock=lambda: now[0])
        self.assertIsNone(b.take("a"))
        self.assertIsNone(b.take("a"))
        self.assertEqual(b.take("a"), 30)  # 2/min -> one token per 30s
        self.assertIsNone(b.take("b"))  # per client
        now[0] = 30.0
        self.assertIsNone(b.take("a"))

    def test_fractional_rate_still_allows_one(self) -> None:
        now = [0.0]
        b = TokenBuckets(0.5, clock=lambda: now[0])
        self.assertIsNone(b.take("a"))
        self.assertEqual(b.take("a"), 120)
        now[0] = 120.0
        self.assertIsNone(b.take("a"))

    def test_zero_is_off(self) -> None:
        b = TokenBuckets(0)
        for _ in range(50):
            self.assertIsNone(b.take("a"))


class RouteLimitTest(unittest.TestCase):
    def setUp(self) -> None:
        self.now = [0.0]
        self.limiter = RateLimiter(
            RateLimitSettings(runs_per_min=3, max_concurrent_runs=1, concurrency_retry_after_s=7),
            clock=lambda: self.now[0],
        )
        p = mock.patch.object(api, "limiter", self.limiter)
        p.start()
        self.addCleanup(p.stop)

        async def fake_request(method, path, body=None, params=None, timeout=None):
            if path == "/runs" and method == "POST":
                return httpx.Response(201, json={"run_id": "r1", "status": "awaiting_approval"})
            return httpx.Response(200, json={"runs": [], "status": "approved"})

        q = mock.patch.object(api, "_agents_request", side_effect=fake_request)
        q.start()
        self.addCleanup(q.stop)
        self.c = TestClient(api.app)

    def test_post_runs_429_with_retry_after(self) -> None:
        for _ in range(3):
            self.assertEqual(self.c.post("/runs", json={"question": "q"}).status_code, 201)
        r = self.c.post("/runs", json={"question": "q"})
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.headers["Retry-After"], "20")
        self.assertIsNone(r.json()["served_from"])
        self.assertIsNone(r.json()["cached_at"])
        # approval is never throttled by the run bucket
        for _ in range(5):
            self.assertEqual(
                self.c.post("/runs/r1/approval", json={"action": "approve"}).status_code, 200
            )
        self.assertEqual(self.limiter.slots.in_flight, 0)

    def test_get_routes_unlimited(self) -> None:
        for _ in range(20):
            self.assertEqual(self.c.get("/health").status_code, 200)
            self.assertEqual(self.c.get("/runs/past").status_code, 200)

    def test_concurrency_cap(self) -> None:
        self.assertTrue(self.limiter.slots.try_acquire())  # a run already in flight
        r = self.c.post("/runs", json={"question": "q"})
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.headers["Retry-After"], "7")
        self.limiter.slots.release()
        self.assertEqual(self.c.post("/runs", json={"question": "q"}).status_code, 201)
        self.assertEqual(self.limiter.slots.in_flight, 0)

    def test_cache_hit_takes_no_slot(self) -> None:
        self.assertTrue(self.limiter.slots.try_acquire())  # full

        async def hit(body):
            return {"run_id": "r0", "status": "approved", "served_from": "cache"}

        settings = api.cache.settings
        with (
            mock.patch.object(settings, "semantic_cache", True),
            mock.patch.object(api, "_from_cache", side_effect=hit),
        ):
            r = self.c.post("/runs", json={"question": "q"})
        self.assertEqual(r.status_code, 200)
        self.limiter.slots.release()

    def test_full_cap_serves_labelled_replay(self) -> None:
        self.assertTrue(self.limiter.slots.try_acquire())  # full

        async def replay(body, reason, **kw):
            self.assertIn("in flight", reason)
            return {"run_id": "r0", "status": "approved", "served_from": "replay"}

        settings = api.cache.settings
        with (
            mock.patch.object(settings, "cached_replay", True),
            mock.patch.object(api, "_replay_for", side_effect=replay),
        ):
            r = self.c.post("/runs", json={"question": "q"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["served_from"], "replay")
        self.assertEqual(self.limiter.slots.in_flight, 1)
        self.limiter.slots.release()

    def test_slot_released_when_agents_down(self) -> None:
        async def down(method, path, body=None, params=None, timeout=None):
            raise httpx.ConnectError("refused")

        with mock.patch.object(api, "_agents_request", side_effect=down):
            self.assertEqual(self.c.post("/runs", json={"question": "q"}).status_code, 503)
        self.assertEqual(self.limiter.slots.in_flight, 0)


if __name__ == "__main__":
    unittest.main()
