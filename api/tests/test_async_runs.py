"""POST /runs?wait=false through the API: 202, rate limits, slot held until the run ends."""

from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

os.environ.setdefault("VIEWS_CACHE_WARM", "0")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as api  # noqa: E402
from app.ratelimit import RateLimiter, RateLimitSettings  # noqa: E402


class AsyncRunTest(unittest.TestCase):
    def setUp(self) -> None:
        self.limiter = RateLimiter(
            RateLimitSettings(runs_per_min=3, max_concurrent_runs=1, concurrency_retry_after_s=7)
        )
        self.status = {"r1": "running"}
        self.calls: list[tuple[str, str, dict | None]] = []

        async def fake_request(method, path, body=None, params=None, timeout=None):
            self.calls.append((method, path, params))
            if path == "/runs" and method == "POST":
                if params == {"wait": "false", "front_door": "false"}:
                    return httpx.Response(202, json={"run_id": "r1", "status": "running"})
                return httpx.Response(201, json={"run_id": "r9", "status": "awaiting_approval"})
            if path.startswith("/runs/"):
                rid = path.split("/")[2]
                return httpx.Response(200, json={"run_id": rid, "status": self.status.get(rid)})
            return httpx.Response(200, json={})

        for target, value in (
            ("limiter", self.limiter),
            ("SLOT_POLL_S", 0.01),
        ):
            p = mock.patch.object(api, target, value)
            p.start()
            self.addCleanup(p.stop)
        q = mock.patch.object(api, "_agents_request", side_effect=fake_request)
        q.start()
        self.addCleanup(q.stop)

    def _until(self, cond, timeout: float = 5.0) -> None:
        t0 = time.time()
        while time.time() - t0 < timeout:
            if cond():
                return
            time.sleep(0.01)
        raise AssertionError("condition not met")

    def test_202_and_the_slot_is_held_until_the_run_leaves_running(self) -> None:
        with TestClient(api.app) as c:
            r = c.post("/runs?wait=false", json={"question": "q"})
            self.assertEqual(r.status_code, 202)
            self.assertEqual(r.json(), {"run_id": "r1", "status": "running"})
            self.assertIn(("POST", "/runs", {"wait": "false", "front_door": "false"}), self.calls)
            # The run is still going: the one slot is taken, a second run is refused.
            self.assertEqual(self.limiter.slots.in_flight, 1)
            busy = c.post("/runs?wait=false", json={"question": "q2"})
            self.assertEqual(busy.status_code, 429)
            self.assertEqual(busy.headers["Retry-After"], "7")
            self.status["r1"] = "awaiting_approval"
            self._until(lambda: self.limiter.slots.in_flight == 0)
            self.assertEqual(c.post("/runs?wait=false", json={"question": "q3"}).status_code, 202)

    def test_async_runs_use_the_token_bucket(self) -> None:
        self.status["r1"] = "awaiting_approval"  # each run ends at once
        with TestClient(api.app) as c:
            for _ in range(3):
                self.assertEqual(
                    c.post("/runs?wait=false", json={"question": "q"}).status_code, 202
                )
                self._until(lambda: self.limiter.slots.in_flight == 0)
            r = c.post("/runs?wait=false", json={"question": "q"})
            self.assertEqual(r.status_code, 429)
            self.assertIn("Retry-After", r.headers)

    def test_slot_released_when_the_run_is_gone(self) -> None:
        self.status.pop("r1")

        async def gone(method, path, body=None, params=None, timeout=None):
            if method == "POST":
                return httpx.Response(202, json={"run_id": "r1", "status": "running"})
            return httpx.Response(404, json={"detail": "not found"})

        with mock.patch.object(api, "_agents_request", side_effect=gone):
            with TestClient(api.app) as c:
                self.assertEqual(
                    c.post("/runs?wait=false", json={"question": "q"}).status_code, 202
                )
                self._until(lambda: self.limiter.slots.in_flight == 0)

    def test_agent_refusal_releases_the_slot(self) -> None:
        async def refuse(method, path, body=None, params=None, timeout=None):
            return httpx.Response(422, json={"detail": "unknown event"})

        with mock.patch.object(api, "_agents_request", side_effect=refuse):
            with TestClient(api.app) as c:
                self.assertEqual(
                    c.post("/runs?wait=false", json={"question": "q"}).status_code, 422
                )
        self.assertEqual(self.limiter.slots.in_flight, 0)

    def test_agents_down_releases_the_slot(self) -> None:
        async def down(method, path, body=None, params=None, timeout=None):
            raise httpx.ConnectError("refused")

        with mock.patch.object(api, "_agents_request", side_effect=down):
            with TestClient(api.app) as c:
                self.assertEqual(
                    c.post("/runs?wait=false", json={"question": "q"}).status_code, 503
                )
        self.assertEqual(self.limiter.slots.in_flight, 0)

    def test_cache_hit_still_answers_200(self) -> None:
        async def hit(body):
            return {"run_id": "r0", "status": "approved", "served_from": "cache"}

        settings = api.cache.settings
        with (
            mock.patch.object(settings, "semantic_cache", True),
            mock.patch.object(api, "_from_cache", side_effect=hit),
            TestClient(api.app) as c,
        ):
            r = c.post("/runs?wait=false", json={"question": "q"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["served_from"], "cache")
        self.assertEqual(self.limiter.slots.in_flight, 0)

    def test_default_stays_synchronous(self) -> None:
        with TestClient(api.app) as c:
            r = c.post("/runs", json={"question": "q"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["run_id"], "r9")
        self.assertEqual(self.limiter.slots.in_flight, 0)

    def test_slot_freed_once_the_agents_stay_down(self) -> None:
        async def flaky(method, path, body=None, params=None, timeout=None):
            if method == "POST":
                return httpx.Response(202, json={"run_id": "r1", "status": "running"})
            raise httpx.ConnectError("refused")

        with (
            mock.patch.object(api, "_agents_request", side_effect=flaky),
            mock.patch.object(api, "SLOT_DOWN_RELEASE_S", 0.1),
            TestClient(api.app) as c,
        ):
            self.assertEqual(c.post("/runs?wait=false", json={"question": "q"}).status_code, 202)
            self.assertEqual(self.limiter.slots.in_flight, 1)
            self._until(lambda: self.limiter.slots.in_flight == 0)


class ProjectCardFieldsTest(unittest.TestCase):
    def test_card_fields_are_copied_when_well_typed(self) -> None:
        from app.project import _card_fields

        out = _card_fields(
            {
                "action_type": "notify-policyholders",
                "target_region": "Valencia province",
                "affected_site_count": 7,
                "draft_message": "Hello.",
                "outbound": True,
                "released": False,
            }
        )
        self.assertEqual(out["affected_site_count"], 7)
        self.assertEqual(out["action_type"], "notify-policyholders")
        self.assertEqual(_card_fields({"action_type": "spam", "affected_site_count": True}), {})


if __name__ == "__main__":
    unittest.main()
