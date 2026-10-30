"""The desk: events in, a decision, artifacts out.

The gate matters most. Nothing an approval produces may exist before the
approval, and dispatch must stay inert until an operator nominates a target.
"""

from __future__ import annotations

import csv
import io
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
from floodsense_agents import desk  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


class DeskTest(unittest.TestCase):
    def setUp(self) -> None:
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        service.set_runtime(Runtime(graph=build_graph(deps), deps=deps))
        self.c = TestClient(service.app)
        os.environ.pop(desk.WEBHOOK_ENV, None)

    def tearDown(self) -> None:
        os.environ.pop(desk.WEBHOOK_ENV, None)

    def open_case(self, event_id: str = "EMSR773") -> dict:
        return self.c.get(f"/desk/events/{event_id}").json()

    def approve(self, run_id: str) -> None:
        r = self.c.post(f"/runs/{run_id}/approval", json={"action": "approve", "reviewer": "zain"})
        self.assertEqual(r.status_code, 200)

    # --- the desk opens on events, not runs ----------------------------

    def test_the_desk_lists_known_events_before_any_case_exists(self) -> None:
        events = self.c.get("/desk/events").json()["events"]
        self.assertEqual([e["event_id"] for e in events], ["EMSR773", "EMSR517"])
        self.assertTrue(all(e["run_id"] is None for e in events))
        self.assertTrue(all(e["name"] and e["region"] for e in events))

    def test_opening_an_event_starts_its_case_once(self) -> None:
        first = self.open_case()
        self.assertEqual(first["run"]["status"], "awaiting_approval")
        self.assertEqual(first["figures"]["policies"], 7)
        self.assertFalse(first["released"])
        again = self.open_case()
        self.assertEqual(again["run"]["run_id"], first["run"]["run_id"])

    def test_the_desk_then_shows_the_case_as_waiting(self) -> None:
        self.open_case()
        events = {e["event_id"]: e for e in self.c.get("/desk/events").json()["events"]}
        self.assertEqual(events["EMSR773"]["approval"], "awaiting")
        self.assertIsNone(events["EMSR517"]["run_id"])

    def test_an_unknown_event_is_refused_rather_than_invented(self) -> None:
        self.assertEqual(self.c.get("/desk/events/EMSR999").status_code, 400)

    # --- the gate --------------------------------------------------------

    def test_no_artifact_exists_before_the_decision(self) -> None:
        run_id = self.open_case()["run"]["run_id"]
        for path in ("/outbound", "/exposure.csv"):
            r = self.c.get(f"/runs/{run_id}{path}")
            self.assertEqual(r.status_code, 409, path)
        self.assertEqual(self.c.post(f"/runs/{run_id}/dispatch").status_code, 409)

    def test_rejecting_keeps_the_artifacts_shut(self) -> None:
        run_id = self.open_case()["run"]["run_id"]
        self.c.post(f"/runs/{run_id}/approval", json={"action": "reject", "reviewer": "zain"})
        self.assertEqual(self.c.get(f"/runs/{run_id}/outbound").status_code, 409)

    # --- what an approval produces ----------------------------------------

    def test_approving_produces_one_message_per_exposed_site(self) -> None:
        run_id = self.open_case()["run"]["run_id"]
        self.approve(run_id)
        msgs = self.c.get(f"/runs/{run_id}/outbound").json()["messages"]
        self.assertEqual(len(msgs), 7)
        # Largest sum insured first, so the biggest exposure is contacted first.
        self.assertEqual(msgs[0]["policy_id"], "P-1003")
        self.assertEqual(
            [m["sum_insured_eur"] for m in msgs],
            sorted([m["sum_insured_eur"] for m in msgs], reverse=True),
        )
        # The wording is the approved action text, not a paraphrase of it.
        run = self.c.get(f"/runs/{run_id}").json()
        approved = [a["text"] for a in run["playbook"] if a["outbound"] and a["released"]]
        self.assertTrue(approved)
        for text in approved:
            self.assertIn(text, msgs[0]["body"])

    def test_the_csv_carries_the_policies_and_the_signature(self) -> None:
        run_id = self.open_case()["run"]["run_id"]
        self.approve(run_id)
        r = self.c.get(f"/runs/{run_id}/exposure.csv")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/csv", r.headers["content-type"])
        self.assertIn("attachment", r.headers["content-disposition"])
        rows = list(csv.DictReader(io.StringIO(r.text)))
        self.assertEqual(len(rows), 7)
        self.assertEqual({row["decided_by"] for row in rows}, {"zain"})
        self.assertEqual({row["in_footprint"] for row in rows}, {"1"})
        self.assertEqual(sum(float(row["sum_insured_eur"]) for row in rows), 21_600_000)

    def test_the_record_stands_on_its_own(self) -> None:
        run_id = self.open_case()["run"]["run_id"]
        self.approve(run_id)
        rec = self.c.get(f"/runs/{run_id}/record").json()
        self.assertEqual(rec["approval"]["reviewer"], "zain")
        # One rain series (VAL07). Turís is not a warehouse point id.
        self.assertEqual(len(rec["claims"]), 9)
        self.assertTrue(rec["sources"])
        self.assertTrue(any("to confirm" in (s["licence"] or "") for s in rec["sources"]))
        self.assertEqual(rec["figures"]["policies"], 7)
        self.assertTrue(rec["definitions"])

    def test_the_record_is_readable_before_a_decision_too(self) -> None:
        # Audit may need to see a case that was never approved.
        run_id = self.open_case()["run"]["run_id"]
        rec = self.c.get(f"/runs/{run_id}/record").json()
        self.assertEqual(rec["approval"]["status"], "awaiting")

    # --- dispatch stays off until someone nominates a target ---------------

    def test_dispatch_is_off_by_default_and_says_what_it_would_send(self) -> None:
        run_id = self.open_case()["run"]["run_id"]
        self.approve(run_id)
        out = self.c.post(f"/runs/{run_id}/dispatch").json()
        self.assertFalse(out["sent"])
        self.assertIn("no endpoint nominated", out["reason"])
        self.assertEqual(out["payload"]["reviewer"], "zain")
        self.assertEqual(len(out["payload"]["policies"]), 7)

    def test_dispatch_refuses_a_target_that_is_not_https(self) -> None:
        run_id = self.open_case()["run"]["run_id"]
        self.approve(run_id)
        os.environ[desk.WEBHOOK_ENV] = "http://example.invalid/hook"
        out = self.c.post(f"/runs/{run_id}/dispatch").json()
        self.assertFalse(out["sent"])
        self.assertIn("https", out["reason"])
        for bad in ("javascript:alert(1)", "https://", "https:///no-host", "https://[::1"):
            os.environ[desk.WEBHOOK_ENV] = bad
            refused = self.c.post(f"/runs/{run_id}/dispatch").json()
            self.assertFalse(refused["sent"], bad)
            self.assertIn("https", refused["reason"])

    def test_the_app_reports_whether_a_target_is_set(self) -> None:
        self.assertFalse(self.c.get("/desk/dispatch-target").json()["configured"])
        os.environ[desk.WEBHOOK_ENV] = "https://example.invalid/hook"
        body = self.c.get("/desk/dispatch-target").json()
        self.assertTrue(body["configured"])
        self.assertEqual(body["target"], "https://example.invalid/hook")

    # --- what was knowable, and when ---------------------------------------

    def test_the_timeline_replays_the_event_at_each_declared_moment(self) -> None:
        service._TIMELINE.clear()
        body = self.c.get("/desk/events/EMSR773/timeline").json()
        self.assertEqual(body["event_id"], "EMSR773")
        self.assertEqual(body["served_from"], "replay")
        self.assertNotEqual(body["served_from"], "live")
        self.assertIsNotNone(body["cached_at"])
        again = self.c.get("/desk/events/EMSR773/timeline").json()
        self.assertEqual(again["served_from"], "cache")
        self.assertEqual(again["cached_at"], body["cached_at"])
        self.assertFalse(again["label"]["live"])
        self.assertEqual(len(body["moments"]), 7)
        for m in body["moments"]:
            self.assertNotIn("error", m)
            self.assertTrue(m["label"])
            self.assertTrue(m["replay_ts"])

    def test_the_footprint_claim_appears_only_once_it_was_published(self) -> None:
        moments = self.c.get("/desk/events/EMSR773/timeline").json()["moments"]
        before = [m for m in moments if m["replay_ts"] < "2024-10-30T00:00:00Z"]
        after = [m for m in moments if m["replay_ts"] >= "2024-10-30T00:00:00Z"]
        self.assertTrue(before and after)
        # Nobody had the mapping on the 29th, so nothing may claim exposure.
        self.assertTrue(all(m["policies"] == 0 for m in before), before)
        self.assertTrue(all(m["sum_insured_eur"] == 0 for m in before))
        self.assertEqual(after[-1]["policies"], 7)
        self.assertEqual(after[-1]["sum_insured_eur"], 21_600_000)

    def test_the_chain_fills_in_as_the_event_unfolds(self) -> None:
        moments = self.c.get("/desk/events/EMSR773/timeline").json()["moments"]
        self.assertLess(moments[0]["anomalies"], moments[-1]["anomalies"])
        self.assertLessEqual(moments[0]["links_supported"], moments[-1]["links_supported"])
        self.assertEqual(moments[-1]["links_supported"], 4)

    def test_an_unknown_event_has_no_timeline(self) -> None:
        self.assertEqual(self.c.get("/desk/events/EMSR999/timeline").status_code, 400)

    def test_drawing_the_timeline_does_not_replace_the_open_case(self) -> None:
        # The replay starts seven more runs on the same event. The case the
        # reviewer is deciding has to survive that.
        case = self.c.get("/desk/events/EMSR773").json()
        self.c.get("/desk/events/EMSR773/timeline")
        again = self.c.get("/desk/events/EMSR773").json()
        self.assertEqual(again["run"]["run_id"], case["run"]["run_id"])
        self.assertEqual(again["figures"], case["figures"])
        row = next(
            e for e in self.c.get("/desk/events").json()["events"] if e["event_id"] == "EMSR773"
        )
        self.assertEqual(row["run_id"], case["run"]["run_id"])

    def test_an_ad_hoc_question_does_not_replace_the_open_case(self) -> None:
        case = self.c.get("/desk/events/EMSR773").json()
        asked = self.c.post(
            "/runs",
            json={"question": "How much rain fell at Chiva?", "event_id": "EMSR773"},
        ).json()
        self.assertNotEqual(asked["run_id"], case["run"]["run_id"])
        again = self.c.get("/desk/events/EMSR773").json()
        self.assertEqual(again["run"]["run_id"], case["run"]["run_id"])

    def test_the_product_ui_is_not_this_service(self) -> None:
        page = self.c.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("Secondary operator page", page.text)
        self.assertIn("Vite console", page.text)
        self.assertIn("no-store", page.headers["cache-control"])
        for path in ("/app/", "/mock/", "/mock/analyst"):
            self.assertEqual(self.c.get(path).status_code, 404, path)


if __name__ == "__main__":
    unittest.main()
