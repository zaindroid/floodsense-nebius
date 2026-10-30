"""Live runs: POST /runs?wait=false, the SSE feed, trace fields, memory_used, card fields."""

from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from fastapi.testclient import TestClient  # noqa: E402
from langgraph.checkpoint.memory import MemorySaver  # noqa: E402

from floodsense_agents import __main__ as service  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import PlaybookAction  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes import playbook  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory, memory_used  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402

Q = {"question": "Why did the Poyo flood and which insured sites are exposed?"}
CARD_TYPES = set(playbook.ACTION_TYPES)


def _client(memory=None) -> TestClient:
    deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=memory or NoMemory())
    service.set_runtime(Runtime(graph=build_graph(deps, MemorySaver(), ff_judge=True), deps=deps))
    return TestClient(service.app)


def _wait(c: TestClient, run_id: str, timeout: float = 60.0) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        body = c.get(f"/runs/{run_id}").json()
        if body["status"] != "running":
            return body
        time.sleep(0.05)
    raise AssertionError("run did not leave running")


def _sse(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        out.append((lines["event"], json.loads(lines["data"])))
    return out


class AsyncStartTest(unittest.TestCase):
    def test_wait_false_returns_202_then_the_run_finishes(self) -> None:
        c = _client()
        r = c.post("/runs?wait=false", json=Q)
        self.assertEqual(r.status_code, 202)
        body = r.json()
        self.assertEqual(body["status"], "running")
        self.assertRegex(body["run_id"], r"^[0-9a-f]{12}$")
        done = _wait(c, body["run_id"])
        self.assertEqual(done["status"], "awaiting_approval")
        self.assertTrue(done["playbook"])

    def test_default_is_still_synchronous(self) -> None:
        r = _client().post("/runs", json=Q)
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["status"], "awaiting_approval")

    def test_bad_event_is_refused_before_accepting(self) -> None:
        r = _client().post("/runs?wait=false", json={**Q, "event_id": "NOPE"})
        self.assertEqual(r.status_code, 422)

    def test_events_stream_started_trace_and_status(self) -> None:
        c = _client()
        run_id = c.post("/runs?wait=false", json=Q).json()["run_id"]
        _wait(c, run_id)
        events = _sse(c.get(f"/runs/{run_id}/events").text)
        kinds = [k for k, _ in events]
        self.assertEqual(kinds[-1], "status")
        self.assertEqual(events[-1][1]["status"], "awaiting_approval")
        started = [e for k, e in events if k == "started"]
        self.assertIn("watchers", [e["node"] for e in started])
        self.assertTrue(all(e["phase"] == "started" for e in started))
        traces = [e for k, e in events if k == "trace"]
        self.assertTrue(traces)
        for ev in traces:
            for key in ("node", "phase", "model_id", "duration_ms", "summary", "lane", "seq"):
                self.assertIn(key, ev)
            self.assertEqual(ev["phase"], "finished")
        pb = next(e for e in traces if e["node"] == "playbook")
        self.assertTrue(pb["model_id"])
        self.assertEqual(pb["duration_ms"], pb["latency_ms"])

    def test_a_pending_run_reads_as_running_not_404(self) -> None:
        c = _client()
        rt = service.runtime()
        rt.live["abc123abc123"] = {"started": [], "done": False}
        body = c.get("/runs/abc123abc123").json()
        self.assertEqual(body["status"], "running")
        self.assertEqual(body["trace"], [])
        rt.live["abc123abc123"]["done"] = True
        self.assertEqual(c.get("/runs/abc123abc123").status_code, 404)


class CardFieldsTest(unittest.TestCase):
    def test_approval_payload_and_snapshot_carry_card_fields(self) -> None:
        c = _client()
        run = c.post("/runs", json=Q).json()
        appr = c.get(f"/runs/{run['run_id']}/approval").json()
        claims = {x["claim_id"]: x for x in run["claims"]}
        outbound = [a for a in appr["playbook"] if a["outbound"]]
        self.assertTrue(outbound)
        for a in appr["playbook"]:
            self.assertIn(a["action_type"], CARD_TYPES | {None})
            self.assertTrue(a["title"])
            self.assertEqual(a["target_region"], run["event"]["region"])
            self.assertIn("affected_site_count", a)
        for a in outbound:
            self.assertTrue(a["draft_message"])
            # Every number in the draft comes from a claim the action cites.
            allowed = set()
            for cid in a["claim_ids"]:
                allowed |= {round(float(n), 3) for n in playbook.numbers_in(claims[cid]["text"])}
                allowed |= {round(float(n), 3) for n in claims[cid]["numbers"]}
            for n in playbook.numbers_in(a["draft_message"]):
                self.assertIn(round(float(n), 3), allowed)
        self.assertEqual(run["playbook"], appr["playbook"])

    def test_site_count_comes_from_exposure(self) -> None:
        c = _client()
        run = c.post("/runs", json=Q).json()
        exp = run["exposure"]
        sites = {a["site_id"] for a in exp["assets"]}
        want = len(sites) if exp["policies"] <= len(exp["assets"]) else None
        for a in run["playbook"]:
            self.assertEqual(a["affected_site_count"], want)

    def test_edit_can_change_a_draft_message(self) -> None:
        c = _client()
        run = c.post("/runs", json=Q).json()
        aid = next(a["action_id"] for a in run["playbook"] if a["outbound"])
        r = c.post(
            f"/runs/{run['run_id']}/approval",
            json={"action": "edit", "draft_messages": {aid: "Reviewer wording."}},
        )
        self.assertEqual(r.status_code, 200)
        out = r.json()
        self.assertEqual(out["approval"]["status"], "edited")
        act = next(a for a in out["playbook"] if a["action_id"] == aid)
        self.assertEqual(act["draft_message"], "Reviewer wording.")
        self.assertTrue(act["released"])
        self.assertEqual(out["summary"], run["summary"])

    def test_empty_edit_is_still_422(self) -> None:
        c = _client()
        run = c.post("/runs", json=Q).json()
        r = c.post(f"/runs/{run['run_id']}/approval", json={"action": "edit"})
        self.assertEqual(r.status_code, 422)

    def test_model_draft_text_never_reaches_the_draft(self) -> None:
        state = {
            "claims": [{"claim_id": "C1", "text": "VAL03 reached 5 m3/s.", "numbers": [5]}],
            "event": {"name": "Valencia", "region": "Valencia"},
            "exposure": {},
        }
        act = PlaybookAction(
            action_id="A1",
            horizon_h=6,
            text="Tell policyholders in Paris about 9 deaths.",
            claim_ids=["C1"],
            outbound=True,
        )
        # Same number, other unit, a place and an organisation nobody cited.
        out = playbook.fill_card(
            act, state, {"draft_message": "5 deaths in Paris, says Red Cross."}
        )
        for bad in ("deaths", "Paris", "Red Cross", "9"):
            self.assertNotIn(bad, out.draft_message)
        self.assertEqual(
            out.draft_message,
            "FloodSense EU flood update (Valencia). VAL03 reached 5 m3/s. "
            + playbook.STEPS["notify-policyholders"],
        )
        self.assertEqual(out.action_type, "notify-policyholders")
        self.assertIsNone(out.affected_site_count)  # exposure unknown
        quiet = PlaybookAction(
            action_id="A2", horizon_h=24, text="Keep watching.", claim_ids=["C1"]
        )
        self.assertIsNone(playbook.fill_card(quiet, state).draft_message)

    def test_old_actions_still_load(self) -> None:
        a = PlaybookAction(action_id="A1", horizon_h=6, text="x")
        self.assertIsNone(a.action_type)
        self.assertIsNone(a.draft_message)


class EditValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.c = _client()
        self.run = self.c.post("/runs", json=Q).json()
        self.url = f"/runs/{self.run['run_id']}/approval"
        self.out = next(a for a in self.run["playbook"] if a["outbound"])
        self.inner = next((a for a in self.run["playbook"] if not a["outbound"]), None)

    def _edit(self, **kw) -> int:
        return self.c.post(self.url, json={"action": "edit", **kw}).status_code

    def test_bad_edits_are_422_and_the_run_still_waits(self) -> None:
        aid = self.out["action_id"]
        self.assertEqual(self._edit(draft_messages={aid: "   "}), 422)
        self.assertEqual(self._edit(draft_messages={"A99": "text"}), 422)
        if self.inner:
            self.assertEqual(self._edit(draft_messages={self.inner["action_id"]: "x"}), 422)
        self.assertEqual(self._edit(draft_messages={aid: self.out["draft_message"]}), 422)
        self.assertEqual(self._edit(edits=self.run["summary"]), 422)
        self.assertEqual(
            self.c.post(
                self.url, json={"action": "approve", "draft_messages": {aid: "x"}}
            ).status_code,
            422,
        )
        self.assertEqual(
            self.c.get(f"/runs/{self.run['run_id']}").json()["status"], "awaiting_approval"
        )
        self.assertEqual(self._edit(edits="A reviewer's summary."), 200)


class FailureTest(unittest.TestCase):
    def test_failure_stands_when_the_checkpoint_write_fails(self) -> None:
        c = _client()
        rt = service.runtime()

        def boom(*a, **kw):
            raise RuntimeError("graph broke")

        with (
            mock.patch.object(rt.graph, "stream", side_effect=boom),
            mock.patch.object(rt.graph, "update_state", side_effect=OSError("disk full")),
        ):
            run_id = c.post("/runs?wait=false", json=Q).json()["run_id"]
            body = _wait(c, run_id)
        self.assertEqual(body["status"], "failed")
        self.assertIn("graph broke", body["error"])
        events = _sse(c.get(f"/runs/{run_id}/events").text)
        self.assertEqual(events[-1], ("status", {**events[-1][1], "status": "failed"}))

    def test_sse_on_a_vanished_run_ends_with_not_found(self) -> None:
        c = _client()
        rt = service.runtime()
        rt.live["feedfeedfeed"] = {"started": [], "done": False}
        calls = {"n": 0}
        real = rt.snapshot

        def flaky(run_id):
            calls["n"] += 1
            if calls["n"] == 1:
                return real(run_id)
            from floodsense_agents.runtime import RunNotFound

            raise RunNotFound(run_id)

        with mock.patch.object(rt, "snapshot", side_effect=flaky):
            events = _sse(c.get("/runs/feedfeedfeed/events").text)
        self.assertEqual(events[-1][0], "status")
        self.assertEqual(events[-1][1]["status"], "not_found")

    def test_live_is_pruned(self) -> None:
        from floodsense_agents import runtime as rtmod

        _client()
        rt = service.runtime()
        for i in range(rtmod.LIVE_MAX + 10):
            rt._track(f"r{i}")
            rt.live[f"r{i}"]["done"] = True
        rt._track("last")
        self.assertLessEqual(len(rt.live), rtmod.LIVE_MAX)
        self.assertIn("last", rt.live)


class FakeMemory:
    def recall(self, request):
        return [
            {
                "memory_id": "m-1",
                "content": "VAL03 peaked at 471 m3/s on 29 Oct.",
                "relevance": 0.9,
                "run_id": "oldrun000001",
                "claim_id": "C2",
                "tags": ["event:EMSR773"],
                "provenance": {"learned_at": "2026-10-01T10:00:00.000Z"},
            }
        ]

    def store(self, run_id, request, claims, approval):
        return {"stored": [], "already_stored": []}


class MemoryUsedTest(unittest.TestCase):
    def test_memory_used_is_run_level(self) -> None:
        with mock.patch.object(settings, "ff_hmem", True):
            c = _client(FakeMemory())
            run = c.post("/runs", json=Q).json()
            appr = c.get(f"/runs/{run['run_id']}/approval").json()
        self.assertEqual(
            run["memory_used"],
            [
                {
                    "memory_id": "m-1",
                    "run_id": "oldrun000001",
                    "claim_id": "C2",
                    "approved_at": "2026-10-01T10:00:00.000Z",
                    "text": "VAL03 peaked at 471 m3/s on 29 Oct.",
                    "relevance": 0.9,
                    "reviewer": None,
                    "seeded": False,
                }
            ],
        )
        self.assertEqual(appr["memory_used"], run["memory_used"])

    def test_no_memory_means_an_empty_list(self) -> None:
        run = _client().post("/runs", json=Q).json()
        self.assertEqual(run["memory_used"], [])
        self.assertEqual(memory_used(None), [])


if __name__ == "__main__":
    unittest.main()
