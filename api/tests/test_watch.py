"""Control tower through the API: the passthrough, the scan bucket, and the /system field."""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "agents"))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as api  # noqa: E402
from app.cache import AnswerCache, CacheSettings  # noqa: E402
from app.metrics import Counters  # noqa: E402
from app.ratelimit import RateLimiter, RateLimitSettings, TokenBuckets  # noqa: E402
from app.system import build_system  # noqa: E402

try:
    from floodsense_agents import __main__ as agents_service  # noqa: E402
    from floodsense_agents import tower  # noqa: E402
except ImportError:
    agents_service = None


@unittest.skipIf(agents_service is None, "agents package not importable")
class WatchProxyTest(unittest.TestCase):
    def setUp(self) -> None:
        from langgraph.checkpoint.memory import MemorySaver
        from floodsense_agents.graph import build_graph
        from floodsense_agents.nightshift import FakeNightshift
        from floodsense_agents.runtime import Runtime
        from floodsense_agents.state import Deps, NoMemory
        from floodsense_agents.zetaris import FakeZetaris

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        rt = Runtime(graph=build_graph(deps, MemorySaver(), ff_judge=True), deps=deps)
        agents_service.set_runtime(rt)
        t = tower.ControlTower(lambda: deps.zetaris, lambda: rt, data_dir=tmp.name, loop_enabled=False)
        agents_service.set_tower(t)
        # A manual scan runs in its own thread and writes into data_dir, so it has
        # to finish before the directory goes. Cleanups run last-registered-first,
        # so this one runs before the TemporaryDirectory above is removed.
        self.addCleanup(lambda: t.stop(5))
        self.addCleanup(lambda: agents_service.set_tower(None))
        inner = TestClient(agents_service.app)

        async def fake_request(method, path, body=None, params=None, timeout=None, headers=None):
            return inner.request(method, path, json=body, params=params, headers=headers)

        for p in (
            mock.patch.object(api, "_agents_request", side_effect=fake_request),
            mock.patch.object(api, "watch_buckets", TokenBuckets(3)),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.c = TestClient(api.app)

    def test_status_events_and_scan_are_proxied(self) -> None:
        self.assertEqual(self.c.get("/watch/events").json()["events"], [])
        agents_service.control_tower().force(block=True)  # the agents' own 5 s gap is not what this tests
        status = self.c.get("/watch/status").json()
        self.assertFalse(status["auto_assess"]["enabled"])
        self.assertEqual(status["auto_assess"]["per_hour"], 1)
        events = self.c.get("/watch/events").json()
        self.assertGreaterEqual(len(events["events"]), 1)
        newest = events["latest_id"]
        self.assertEqual(self.c.get("/watch/events", params={"since": newest}).json()["events"], [])
        self.assertEqual(len(self.c.get("/watch/events", params={"limit": 1}).json()["events"]), 1)

    def test_scan_now_has_its_own_bucket_and_429_carries_retry_after(self) -> None:
        codes = [self.c.post("/watch/cycle").status_code for _ in range(4)]
        # the first scan runs; a second within the agents' gap is their 429; the bucket (3) ends it at the API
        self.assertEqual(codes[0], 202)  # answered at once; the scan runs on the agents' thread
        self.assertEqual(codes[-1], 429)
        r = self.c.post("/watch/cycle")
        self.assertEqual(r.status_code, 429)
        self.assertIn("Retry-After", r.headers)

    def test_auto_assess_switch_is_proxied_and_validated(self) -> None:
        on = self.c.post("/watch/auto-assess", json={"enabled": True})
        self.assertEqual(on.status_code, 200)
        self.assertTrue(on.json()["auto_assess"]["enabled"])
        self.assertEqual(self.c.post("/watch/auto-assess", json={"enabled": "x"}).status_code, 422)
        self.assertEqual(self.c.post("/watch/auto-assess", content=b"\xff").status_code, 400)

    def test_the_admin_token_is_enforced_and_passed_on(self) -> None:
        import os

        with mock.patch.dict(os.environ, {"WATCH_ADMIN_TOKEN": "s3cret"}):
            self.assertEqual(self.c.post("/watch/auto-assess", json={"enabled": True}).status_code, 401)
            ok = self.c.post("/watch/auto-assess", json={"enabled": True}, headers={"x-watch-admin-token": "s3cret"})
            self.assertEqual(ok.status_code, 200)
            self.assertTrue(ok.json()["auto_assess"]["enabled"])

    def test_a_scan_does_not_spend_a_run_token(self) -> None:
        limiter = RateLimiter(RateLimitSettings(runs_per_min=1, max_concurrent_runs=2))
        with mock.patch.object(api, "limiter", limiter):
            self.c.post("/watch/cycle")
            self.assertIsNone(limiter.buckets.take("testclient"))  # the run bucket is still full

    def test_unreachable_agents_is_a_503(self) -> None:
        async def down(*a, **k):
            raise httpx.ConnectError("down")

        with mock.patch.object(api, "_agents_request", side_effect=down):
            self.assertEqual(self.c.get("/watch/status").status_code, 503)


class SystemWatchTest(unittest.TestCase):
    STATUS = {
        "loop": {"enabled": True, "alive": True, "interval_s": 300.0},
        "last_cycle": {"finished_at": "2026-10-27T13:00:00Z"},
        "counts": {"sources": 45, "elevated": 5, "events": 12, "awaiting_approval": 1},
        "auto_assess": {"enabled": False, "per_hour": 1, "per_day": 3, "used_hour": 0, "used_day": 0},
    }

    def build(self, status):
        async def agents(method, path, params=None, timeout=None):
            if path == "/watch/status":
                return (200, status) if status is not None else (503, None)
            return 404, None

        return asyncio.run(
            build_system(
                cache=AnswerCache(CacheSettings(), redis_client=None),
                limiter=RateLimiter(RateLimitSettings(10, 2, 30)),
                counters=Counters(),
                agents_json=agents,
                lookup_timeout=1.0,
                engines_base="",
            )
        )

    def test_system_reports_the_control_tower(self) -> None:
        w = self.build(self.STATUS)["watch"]
        self.assertTrue(w["ok"])
        self.assertEqual((w["sources"], w["elevated"], w["awaiting_approval"]), (45, 5, 1))
        self.assertEqual(w["last_cycle_at"], "2026-10-27T13:00:00Z")
        self.assertEqual(w["auto_assess"], {"enabled": False, "per_hour": 1, "per_day": 3, "used_hour": 0, "used_day": 0})
        self.assertIn("none in the loop", w["model_calls"])

    def test_system_degrades_when_the_agents_do_not_answer(self) -> None:
        w = self.build(None)["watch"]
        self.assertFalse(w["ok"])
        self.assertIn("error", w)


if __name__ == "__main__":
    unittest.main()
