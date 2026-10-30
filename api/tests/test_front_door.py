"""POST /runs front door: small talk is a 200 reply; no slot, no cache, one bucket token."""

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
from app.ratelimit import RateLimiter, RateLimitSettings  # noqa: E402

REPLY = {
    "kind": "reply",
    "intent": "greeting",
    "answer": "Hello! I'm FloodSense.",
    "suggestions": ["Is Valencia at risk of flooding in the next 48 hours?"],
    "model_id": "rules",
    "latency_ms": 2,
}


class FrontDoorProxyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.now = [0.0]
        self.limiter = RateLimiter(
            RateLimitSettings(runs_per_min=2, max_concurrent_runs=1, concurrency_retry_after_s=5),
            clock=lambda: self.now[0],
        )
        p = mock.patch.object(api, "limiter", self.limiter)
        p.start()
        self.addCleanup(p.stop)
        self.calls: list[tuple[str, str, dict | None]] = []
        self.slots_seen: list[int] = []

        async def fake_request(method, path, body=None, params=None, timeout=None):
            self.calls.append((method, path, params))
            if path == "/front-door":
                self.slots_seen.append(self.limiter.slots.in_flight)
                q = (body or {}).get("question", "")
                return httpx.Response(200, json=REPLY if q == "hello" else {"kind": "run"})
            if path == "/runs" and method == "POST":
                return httpx.Response(201, json={"run_id": "r1", "status": "awaiting_approval"})
            return httpx.Response(200, json={"runs": []})

        q = mock.patch.object(api, "_agents_request", side_effect=fake_request)
        q.start()
        self.addCleanup(q.stop)
        self.c = TestClient(api.app)

    def test_reply_is_proxied_as_200_without_a_run(self) -> None:
        r = self.c.post("/runs", json={"question": "hello"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), REPLY)
        self.assertNotIn("run_id", r.json())
        self.assertFalse(any(p == "/runs" for _, p, _ in self.calls))

    def test_async_reply_is_also_200(self) -> None:
        r = self.c.post("/runs?wait=false", json={"question": "hello"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["kind"], "reply")

    def test_reply_takes_a_token_but_no_slot(self) -> None:
        self.limiter.slots.in_flight = 1  # the only slot is busy
        self.assertEqual(self.c.post("/runs", json={"question": "hello"}).status_code, 200)
        self.assertEqual(self.limiter.slots.in_flight, 1)
        self.assertEqual(self.c.post("/runs", json={"question": "hello"}).status_code, 200)
        r = self.c.post("/runs", json={"question": "hello"})  # bucket of 2 is empty
        self.assertEqual(r.status_code, 429)

    def test_flood_question_runs_unchanged(self) -> None:
        r = self.c.post("/runs", json={"question": "Is Valencia at risk?"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["run_id"], "r1")
        self.assertIn(("POST", "/runs", {"front_door": "false"}), self.calls)
        self.assertEqual(self.slots_seen, [0])  # checked before a slot was taken
        self.assertEqual(self.limiter.slots.in_flight, 0)

    def test_front_door_down_falls_through_to_the_run(self) -> None:
        async def down(method, path, body=None, params=None, timeout=None):
            if path == "/front-door":
                raise httpx.ConnectError("down")
            return httpx.Response(201, json={"run_id": "r2", "status": "awaiting_approval"})

        with mock.patch.object(api, "_agents_request", side_effect=down):
            r = self.c.post("/runs", json={"question": "hello"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["run_id"], "r2")

    def test_reply_is_never_cached(self) -> None:
        with (
            mock.patch.object(api.cache, "remember") as store,
            mock.patch.object(api, "_from_cache") as lookup,
        ):
            self.c.post("/runs", json={"question": "hello"})
        store.assert_not_called()
        lookup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
