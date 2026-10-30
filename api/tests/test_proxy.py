"""API proxies the run lifecycle to the agents service.

The agents app is mounted in-process through httpx's transport, so this needs
no network and no second process.
"""

from __future__ import annotations

import os
import sys
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
from app.ratelimit import RateLimiter, RateLimitSettings  # noqa: E402

try:
    from floodsense_agents import __main__ as agents_service  # noqa: E402
except (
    ImportError
):  # the agents requirements are not installed here; the health test still covers the API
    agents_service = None


@unittest.skipIf(agents_service is None, "agents package not importable")
class ProxyTest(unittest.TestCase):
    def setUp(self) -> None:
        from langgraph.checkpoint.memory import MemorySaver
        from floodsense_agents.graph import build_graph
        from floodsense_agents.nightshift import FakeNightshift
        from floodsense_agents.runtime import Runtime
        from floodsense_agents.state import Deps, NoMemory
        from floodsense_agents.zetaris import FakeZetaris

        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        agents_service.set_runtime(
            Runtime(graph=build_graph(deps, MemorySaver(), ff_judge=True), deps=deps)
        )
        inner = TestClient(agents_service.app)

        async def fake_request(method, path, body=None, params=None, timeout=None):
            # The proxy awaits an async client. Route that into the in-process app.
            return inner.request(method, path, json=body, params=params)

        self._patch = mock.patch.object(api, "_agents_request", side_effect=fake_request)
        self._patch.start()
        self.addCleanup(self._patch.stop)
        # These tests exercise the cache and proxy, not the rate limits.
        unlimited = RateLimiter(RateLimitSettings(runs_per_min=0, max_concurrent_runs=0))
        limits = mock.patch.object(api, "limiter", unlimited)
        limits.start()
        self.addCleanup(limits.stop)
        self.c = TestClient(api.app)

    def test_views_are_proxied_with_headers(self) -> None:
        r = self.c.get("/views/discharge_daily")
        self.assertEqual(r.status_code, 200)
        self.assertIsInstance(r.json(), list)
        self.assertTrue(r.headers.get("x-query-id"))
        self.assertEqual(r.headers.get("cache-control"), "no-store")

    def test_replay_source_is_forwarded(self) -> None:
        r = self.c.get("/views/hazard_timeline", params={"event_id": "EMSR517", "source": "replay"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("x-schema"), "floodsense_seed")
        self.assertEqual(r.headers.get("x-source"), "replay")
        self.assertTrue(all(row["point_id"].startswith("AHR") for row in r.json()))

    def test_unknown_view_is_404_through_the_api(self) -> None:
        self.assertEqual(self.c.get("/views/policies").status_code, 404)

    def test_start_approve_through_the_api(self) -> None:
        r = self.c.post(
            "/runs", json={"question": "Which sites are exposed?", "event_id": "EMSR773"}
        )
        self.assertEqual(r.status_code, 201)
        run = r.json()
        self.assertEqual(run["status"], "awaiting_approval")
        self.assertNotEqual(run["served_from"], "live")
        self.assertEqual(run["served_from"], "replay")
        self.assertIn("contract", run)
        self.assertEqual(run["contract"]["answer"]["served_from"], "replay")
        self.assertIsNotNone(run["contract"]["answer"]["cached_at"])
        self.assertNotIn("urn:floodsense:query:", r.text)
        rid = run["run_id"]
        fetched = self.c.get(f"/runs/{rid}")
        self.assertEqual(fetched.status_code, 200)
        self.assertIn("contract", fetched.json())
        replayed = self.c.get(f"/runs/{rid}/replay")
        self.assertEqual(replayed.status_code, 200)
        self.assertEqual(replayed.json()["served_from"], "replay")
        self.assertEqual(replayed.json()["contract"]["answer"]["served_from"], "replay")
        approval = self.c.get(f"/runs/{rid}/approval")
        self.assertEqual(approval.status_code, 200)
        self.assertNotIn("contract", approval.json())
        done = self.c.post(
            f"/runs/{rid}/approval", json={"action": "approve", "reviewer": "zain"}
        ).json()
        self.assertEqual(done["status"], "approved")
        self.assertNotIn("contract", done)
        citations = self.c.get(f"/runs/{rid}/citations")
        self.assertEqual(citations.status_code, 200)
        self.assertNotIn("contract", citations.json())
        self.assertEqual(self.c.get("/runs/past").json()["runs"][0]["run_id"], rid)
        self.assertEqual(
            self.c.get("/config").json()["lanes"],
            {"fast": "meterless/fast", "deep": "meterless/deep"},
        )

    def test_agents_down_is_a_503(self) -> None:
        self._patch.stop()

        async def down(method, path, body=None, params=None, timeout=None):
            raise httpx.ConnectError("refused")

        with mock.patch.object(api, "_agents_request", side_effect=down):
            self.assertEqual(self.c.get("/runs/past").status_code, 503)
        self._patch.start()


if __name__ == "__main__":
    unittest.main()
