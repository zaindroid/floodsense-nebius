"""Cached and replayed answers are never presented as live.

GAMEPLAN "Caching and the honest demo". The wording lives in the service so
that this console, the team's console and the video all say the same thing.
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

from floodsense_agents import __main__ as service  # noqa: E402
from floodsense_agents import labelling  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


class LabelTest(unittest.TestCase):
    def test_a_live_answer_carries_no_banner(self) -> None:
        got = labelling.label("live", None, "r1")
        self.assertTrue(got["live"])
        self.assertIsNone(got["text"])

    def test_a_cached_answer_says_so_with_the_time_and_the_run(self) -> None:
        got = labelling.label("cache", "2026-10-24T14:32:51Z", "R-123")
        self.assertFalse(got["live"])
        self.assertEqual(got["at"], "14:32")
        self.assertEqual(got["text"], "Cached answer from 14:32 · not live · original run R-123")

    def test_a_replay_says_it_is_a_replay(self) -> None:
        got = labelling.label("replay", "2026-10-24T09:05:00Z", "R-9")
        self.assertFalse(got["live"])
        self.assertIn("Replay of a recorded run from 09:05", got["text"])
        self.assertIn("not live", got["text"])

    def test_a_missing_timestamp_still_refuses_to_claim_live(self) -> None:
        got = labelling.label("cache", None, None)
        self.assertFalse(got["live"])
        self.assertEqual(got["text"], "Cached answer · not live")

    def test_anything_unrecognised_is_not_called_live(self) -> None:
        for value in (None, "", "fresh", "LIVE", "true"):
            got = labelling.label(value, None, None)
            self.assertFalse(got["live"], value)
            self.assertIn("not live", got["text"])

    def test_a_malformed_timestamp_is_dropped_rather_than_printed(self) -> None:
        got = labelling.label("cache", "yesterday", "R-1")
        self.assertIsNone(got["at"])
        self.assertNotIn("yesterday", got["text"])


class LabelOverTheApiTest(unittest.TestCase):
    def setUp(self) -> None:
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        service.set_runtime(Runtime(graph=build_graph(deps), deps=deps))
        self.c = TestClient(service.app)

    def test_every_response_carries_a_label(self) -> None:
        for path in ("/health", "/config", "/readiness", "/desk/events"):
            body = self.c.get(path).json()
            self.assertIn("label", body, path)
            self.assertIn("served_from", body, path)

    def test_a_fake_run_is_not_live_and_a_re_read_is_cache(self) -> None:
        first = self.c.get("/desk/events/EMSR773").json()["run"]
        self.assertNotEqual(first["served_from"], "live")
        self.assertFalse(first["label"]["live"])
        self.assertEqual(first["served_from"], "replay")
        self.assertIsNotNone(first["cached_at"])

        # The same answer served again was computed earlier.
        again = self.c.get("/desk/events/EMSR773").json()["run"]
        self.assertEqual(again["run_id"], first["run_id"])
        self.assertFalse(again["label"]["live"])
        self.assertEqual(again["label"]["kind"], "cache")
        self.assertEqual(again["served_from"], "cache")
        self.assertIn("not live", again["label"]["text"])
        self.assertIn(again["run_id"], again["label"]["text"])

    def test_the_snapshot_record_and_verify_endpoints_agree(self) -> None:
        run_id = self.c.get("/desk/events/EMSR773").json()["run"]["run_id"]
        for path in (f"/runs/{run_id}", f"/runs/{run_id}/record", f"/runs/{run_id}/verify"):
            body = self.c.get(path).json()
            self.assertFalse(body["label"]["live"], path)
            self.assertEqual(body["label"]["kind"], "cache", path)

    def test_the_decision_record_carries_its_own_provenance(self) -> None:
        run_id = self.c.get("/desk/events/EMSR773").json()["run"]["run_id"]
        rec = self.c.get(f"/runs/{run_id}/record").json()
        self.assertIn(rec["served_from"], ("live", "cache", "replay"))
        self.assertIsNotNone(rec["cached_at"])

    def test_a_replay_clock_on_a_run_is_not_labelled_live(self) -> None:
        run = self.c.post(
            "/runs",
            json={
                "question": "Which sites are exposed?",
                "event_id": "EMSR773",
                "replay_ts": "2024-10-29T12:00:00Z",
            },
        ).json()
        self.assertEqual(run["served_from"], "replay")
        self.assertNotEqual(run["served_from"], "live")
        self.assertFalse(run["label"]["live"])
        self.assertEqual(run["cached_at"], "2024-10-29T12:00:00Z")

    def test_a_clocked_replay_stays_a_replay_when_it_is_read_back(self) -> None:
        run = self.c.post(
            "/runs",
            json={
                "question": "Which sites are exposed?",
                "event_id": "EMSR773",
                "replay_ts": "2024-10-29T12:00:00Z",
            },
        ).json()
        again = self.c.get(f"/runs/{run['run_id']}").json()
        self.assertEqual(again["served_from"], "replay")
        self.assertEqual(again["label"]["kind"], "replay")
        self.assertNotIn("Cached answer", again["label"]["text"])
        self.assertIn("Replay", again["label"]["text"])
        self.assertEqual(again["cached_at"], "2024-10-29T12:00:00Z")

    def test_fake_zetaris_envelopes_are_not_live(self) -> None:
        for path in (
            "/ready",
            "/config",
            "/version",
            "/runs/past",
            "/desk/events",
            "/desk/dispatch-target",
        ):
            body = self.c.get(path).json()
            self.assertNotEqual(body["served_from"], "live", path)
            self.assertFalse(body["label"]["live"], path)
            self.assertEqual(body["served_from"], "replay", path)
            self.assertIsNotNone(body["cached_at"], path)
        health = self.c.get("/health").json()
        self.assertEqual(health["served_from"], "live")
        self.assertTrue(health["label"]["live"])

    def test_an_unlabelled_body_does_not_default_to_live_on_the_stand_in(self) -> None:
        got = labelling.labelled({"status": "ready"}, zetaris=FakeZetaris())
        self.assertEqual(got["served_from"], "replay")
        self.assertFalse(got["label"]["live"])

    def test_an_explicit_live_label_is_kept_for_liveness(self) -> None:
        got = labelling.labelled({"status": "ok", "served_from": "live"}, zetaris=FakeZetaris())
        self.assertEqual(got["served_from"], "live")
        self.assertTrue(got["label"]["live"])
        self.assertIsNone(got["cached_at"])


if __name__ == "__main__":
    unittest.main()
