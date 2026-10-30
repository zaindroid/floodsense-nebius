"""Agents HTTP service against the API contract.

start -> approval payload -> decision -> resume, over the fakes. No network.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from fastapi.testclient import TestClient  # noqa: E402
from langgraph.checkpoint.memory import MemorySaver  # noqa: E402

from floodsense_agents import __main__ as service  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


class ServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        service.set_runtime(
            Runtime(graph=build_graph(deps, MemorySaver(), ff_judge=True), deps=deps)
        )
        self.c = TestClient(service.app)

    def test_health_and_config(self) -> None:
        body = self.c.get("/health").json()
        self.assertEqual(body["service"], "floodsense-agents")
        self.assertEqual(body["graph"], "compiled")
        self.assertEqual(body["served_from"], "live")
        cfg = self.c.get("/config").json()
        self.assertIn("FF_HITL", cfg["flags"])
        self.assertEqual(cfg["lanes"]["fast"], "meterless/fast")
        self.assertEqual(cfg["lanes"]["deep"], "meterless/deep")

    def test_console_is_served_at_the_root(self) -> None:
        r = self.c.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/html", r.headers["content-type"])
        self.assertIn("FloodSense EU", r.text)
        self.assertIn("Secondary operator page", r.text)
        self.assertIn("no-store", r.headers["cache-control"])
        self.assertEqual(self.c.get("/console").status_code, 200)

    def test_the_static_desk_is_not_shipped(self) -> None:
        for path in (
            "/app",
            "/app/",
            "/app/app.js",
            "/mock",
            "/mock/",
            "/mock/analyst",
            "/mock/data.js",
        ):
            self.assertEqual(self.c.get(path).status_code, 404, path)

    def test_ready_and_version(self) -> None:
        ready = self.c.get("/ready").json()
        self.assertEqual(ready["status"], "ready")
        self.assertEqual(ready["zetaris"], "FakeZetaris")
        ver = self.c.get("/version").json()
        self.assertIn("sha", ver)
        self.assertIn("built", ver)

    def test_ready_is_503_when_the_probe_returns_an_error(self) -> None:
        from floodsense_agents.models import Evidence
        from floodsense_agents.zetaris import now_utc

        class Down:
            def run_sql(self, sql, params=None):
                return Evidence(
                    query_id="probe",
                    view="?",
                    sql=sql,
                    executed_at_utc=now_utc(),
                    error="connection reset by peer",
                )

        service.runtime().deps.zetaris = Down()
        response = self.c.get("/ready")
        self.assertEqual(response.status_code, 503)
        self.assertIn("connection reset", response.json()["detail"])

    def test_run_review_approve(self) -> None:
        r = self.c.post(
            "/runs",
            json={
                "question": "Which sites are exposed?",
                "event_id": "EMSR773",
                "customer_id": "demo-insurer",
            },
        )
        self.assertEqual(r.status_code, 201)
        run = r.json()
        self.assertEqual(run["status"], "awaiting_approval")
        self.assertEqual(run["approval"]["status"], "awaiting")
        self.assertEqual(run["served_from"], "replay")
        self.assertIsNotNone(run["cached_at"])
        for k in (
            "run_id",
            "thread_id",
            "event_id",
            "customer_id",
            "replay_ts",
            "anomalies",
            "hypotheses",
            "exposure",
            "playbook",
            "judge",
            "approval",
            "trace",
        ):
            self.assertIn(k, run)
        rid = run["run_id"]

        approval = self.c.get(f"/runs/{rid}/approval").json()
        self.assertEqual(approval["run_id"], rid)
        self.assertTrue(approval["claims"] and approval["judge_summary"]["passes"])

        cits = self.c.get(f"/runs/{rid}/citations").json()
        self.assertTrue(
            cits["citations"] and all(c["layer"] in ("a", "b", "c") for c in cits["citations"])
        )
        self.assertTrue(
            all(c["query_id"] in cits["evidence"] for c in cits["citations"] if c["layer"] == "a")
        )

        self.assertEqual(
            self.c.post(f"/runs/{rid}/approval", json={"action": "edit"}).status_code, 422
        )
        done = self.c.post(
            f"/runs/{rid}/approval", json={"action": "approve", "reviewer": "saleeta"}
        ).json()
        self.assertEqual(done["status"], "approved")
        self.assertEqual(done["approval"]["decision"], "approve")

        self.assertEqual(
            self.c.post(f"/runs/{rid}/approval", json={"action": "approve"}).status_code, 409
        )
        self.assertEqual(self.c.get(f"/runs/{rid}/approval").status_code, 409)
        past = self.c.get("/runs/past").json()["runs"]
        self.assertEqual(past[0]["run_id"], rid)
        self.assertEqual(past[0]["approval"], "approved")
        self.assertEqual(self.c.get("/runs/nope").status_code, 404)
        self.assertEqual(
            self.c.post("/runs", json={"question": "x", "event_id": "EMSR000"}).status_code, 422
        )

    def test_events_stream_sends_trace_events_then_status(self) -> None:
        rid = self.c.post("/runs", json={"question": "q", "event_id": "EMSR773"}).json()["run_id"]
        with self.c.stream("GET", f"/runs/{rid}/events") as s:
            text = "".join(s.iter_text())
        self.assertIn("event: trace", text)
        self.assertIn('"node": "watchers"', text)
        self.assertIn('"status": "awaiting_approval"', text)

    def test_get_run_does_not_rebuild_the_checkpoint_index(self) -> None:
        """GET /runs/{id} must not list every checkpoint.

        _stored used to call past() -> _rebuild_index(), which walks the
        whole checkpointer. That is what wedged a read behind a long POST.
        """
        rid = self.c.post("/runs", json={"question": "q", "event_id": "EMSR773"}).json()["run_id"]
        body = self._get_run_counting_index_scans(rid)
        self.assertEqual(body["run_id"], rid)
        self.assertEqual(body["served_from"], "cache")
        self.assertFalse(body["label"]["live"])

    def test_get_run_after_restart_snapshots_only_that_run(self) -> None:
        """A cold index (process restart) still must not list every checkpoint."""
        rid = self.c.post("/runs", json={"question": "q", "event_id": "EMSR773"}).json()["run_id"]
        service.runtime().index.clear()
        body = self._get_run_counting_index_scans(rid)
        self.assertEqual(body["served_from"], "cache")
        self.assertEqual(body["run_id"], rid)
        self.assertIn(rid, service.runtime().index)
        self.assertEqual(len(service.runtime().index), 1)

    def _get_run_counting_index_scans(self, rid: str) -> dict:
        rt = service.runtime()
        calls = {"rebuild": 0, "list": 0}
        real_rebuild = rt._rebuild_index
        real_list = rt.graph.checkpointer.list

        def rebuild():
            calls["rebuild"] += 1
            return real_rebuild()

        def list_checkpoints(*args, **kwargs):
            calls["list"] += 1
            return real_list(*args, **kwargs)

        rt._rebuild_index = rebuild
        rt.graph.checkpointer.list = list_checkpoints
        try:
            response = self.c.get(f"/runs/{rid}")
        finally:
            rt._rebuild_index = real_rebuild
            rt.graph.checkpointer.list = real_list
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(calls["rebuild"], 0)
        self.assertEqual(calls["list"], 0)
        return response.json()


if __name__ == "__main__":
    unittest.main()
