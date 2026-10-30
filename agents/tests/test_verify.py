"""Per-agent step verification, and which data path the run actually used.

Same discipline as test_readiness: every step is broken on purpose and
asserted to notice. The Judge's checks matter most, because they recompute
its own summary from its own per-claim scores.
"""

from __future__ import annotations

import copy
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents import verify  # noqa: E402
from floodsense_agents.models import ApprovalDecision, RunRequest  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402


class VerifyTest(unittest.TestCase):
    snap: dict
    rt: Runtime

    @classmethod
    def setUpClass(cls) -> None:
        cls._judge_was = settings.ff_judge
        settings.ff_judge = True
        cls.rt = Runtime()
        started = cls.rt.start(RunRequest(question="Why are we at risk?", event_id="EMSR773"))
        cls.snap = cls.rt.resume(
            started["run_id"], ApprovalDecision(action="approve", reviewer="zain")
        )

    @classmethod
    def tearDownClass(cls) -> None:
        settings.ff_judge = cls._judge_was

    def fresh(self) -> dict:
        return copy.deepcopy(self.snap)

    # --- the run as it stands --------------------------------------------

    def test_every_agent_is_verified_on_a_clean_run(self) -> None:
        rep = verify.report(self.snap)
        self.assertEqual(
            [s["agent"] for s in rep["steps"]],
            ["watchers", "investigator", "skeptic", "exposure", "playbook", "judge", "hitl"],
        )
        self.assertEqual(rep["verified"], 7, rep["failures"])
        self.assertEqual(rep["failures"], [])
        self.assertGreater(rep["checks_run"], 20)
        self.assertEqual(rep["checks_passed"], rep["checks_run"])

    def test_every_step_carries_a_name_a_person_can_read(self) -> None:
        rep = verify.report(self.snap)
        titles = {s["agent"]: s["title"] for s in rep["steps"]}
        # "hitl" is the node id; nobody outside the team reads it as a word.
        self.assertEqual(titles["hitl"], "Human approval")
        self.assertEqual(titles["watchers"], "Hazard scan agent")
        for agent, title in titles.items():
            self.assertTrue(title and title != agent, agent)
            self.assertTrue(title[0].isupper(), title)

    def test_each_step_shows_the_queries_it_ran_with_their_source(self) -> None:
        rep = verify.report(self.snap)
        by = {s["agent"]: s for s in rep["steps"]}
        self.assertTrue(by["watchers"]["queries"])
        self.assertTrue(by["skeptic"]["queries"])
        watcher_views = [" ".join(q["views"]) for q in by["watchers"]["queries"]]
        self.assertTrue(any("hazard_timeline" in v for v in watcher_views))
        # EMSR773 lists no PEGELONLINE stations, so the gauge view is not queried.
        self.assertFalse(any("gauge_levels" in v for v in watcher_views))
        for q in by["watchers"]["queries"]:
            self.assertTrue(q["resolved"])
            joined = " ".join(q["views"])
            self.assertIn("hazard_timeline", joined)
            self.assertTrue(q["sql"])
            self.assertEqual(q["source"], "zetaris-fake")

    # --- the data path ----------------------------------------------------

    def test_the_data_path_says_plainly_that_zetaris_was_not_reached(self) -> None:
        path = verify.report(self.snap)["data_path"]
        self.assertFalse(path["reached_zetaris"])
        self.assertFalse(path["rest_url_set"])
        self.assertIn("offline stand-in", path["verdict"])
        self.assertEqual(path["by_source"], {"zetaris-fake": path["queries"]})
        self.assertEqual(path["errors"], 0)
        self.assertGreater(path["rows"], 0)

    def test_the_data_path_would_say_so_if_zetaris_had_answered(self) -> None:
        run = self.fresh()
        for e in run["evidence"].values():
            e["source"] = "zetaris"
        path = verify.data_path(run)
        self.assertTrue(path["reached_zetaris"])
        self.assertIn("every query went to Zetaris", path["verdict"])

    def test_a_half_live_run_is_called_mixed_rather_than_live(self) -> None:
        run = self.fresh()
        for i, e in enumerate(run["evidence"].values()):
            e["source"] = "zetaris" if i % 2 else "zetaris-fake"
        path = verify.data_path(run)
        self.assertFalse(path["reached_zetaris"])
        self.assertIn("mixed", path["verdict"])

    # --- break each agent -------------------------------------------------

    def test_watchers_notices_an_anomaly_pointing_at_no_query(self) -> None:
        run = self.fresh()
        run["anomalies"][0]["query_id"] = "gone"
        step = verify.watchers(run)
        self.assertEqual(step.status, "partial")
        self.assertTrue(any("dangling" in c.detail for c in step.checks if not c.ok))

    def test_watchers_notices_a_value_below_the_threshold_it_claims(self) -> None:
        run = self.fresh()
        rain = next(a for a in run["anomalies"] if a["kind"] == "rain")
        rain["value"] = 1.0
        step = verify.watchers(run)
        self.assertTrue(
            any("clears that threshold" in c.name for c in step.checks if not c.ok),
            [c.name for c in step.checks if not c.ok],
        )

    def test_investigator_notices_a_hypothesis_leaning_on_a_missing_claim(self) -> None:
        run = self.fresh()
        run["hypotheses"][0]["citations"] = ["C99"]
        step = verify.investigator(run)
        self.assertEqual(step.status, "partial")
        self.assertTrue(any("C99" in c.detail for c in step.checks if not c.ok))

    def test_skeptic_notices_a_challenge_with_nothing_behind_it(self) -> None:
        run = self.fresh()
        run["hypotheses"][0]["evidence"] = []
        step = verify.skeptic(run)
        self.assertEqual(step.status, "partial")
        self.assertTrue(any("nothing behind them" in c.detail for c in step.checks if not c.ok))

    def test_skeptic_notices_more_rounds_than_it_is_allowed(self) -> None:
        run = self.fresh()
        run["hypotheses"][0]["rounds"] = settings.skeptic_max_rounds + 5
        step = verify.skeptic(run)
        self.assertTrue(any("round limit" in c.name for c in step.checks if not c.ok))

    def test_exposure_notices_a_total_that_does_not_add_up(self) -> None:
        run = self.fresh()
        run["exposure"]["sum_insured_eur"] = 99_000_000
        step = verify.exposure(run)
        self.assertEqual(step.status, "partial")
        self.assertTrue(any("SUM is" in c.detail for c in step.checks if not c.ok))

    def test_exposure_notices_a_policy_count_that_does_not_match_the_aggregate(self) -> None:
        run = self.fresh()
        run["exposure"]["policies"] = 99
        step = verify.exposure(run)
        self.assertTrue(any("COUNT(*)" in c.detail for c in step.checks if not c.ok))

    def test_exposure_accepts_more_policies_than_the_sample(self) -> None:
        run = self.fresh()
        exp = run["exposure"]
        exp["assets"] = exp["assets"][:1]
        exp["policies"] = 25
        exp["sum_insured_eur"] = 1_250_000.0
        exp["by_segment"] = [{"segment": "retail", "policies": 25, "sum_insured_eur": 1_250_000.0}]
        qid = next(
            q
            for q in exp["query_ids"]
            if "COUNT(" in (run["evidence"][q].get("sql") or "").upper()
            and "GROUP BY" not in (run["evidence"][q].get("sql") or "").upper()
        )
        run["evidence"][qid]["rows_sample"] = [{"policies": 25, "sum_insured_eur": 1_250_000.0}]
        step = verify.exposure(run)
        self.assertEqual(
            step.status, "verified", [(c.name, c.detail) for c in step.checks if not c.ok]
        )
        self.assertGreater(exp["policies"], len(exp["assets"]))

    def test_playbook_notices_an_action_citing_a_claim_that_does_not_exist(self) -> None:
        run = self.fresh()
        run["playbook"][0]["claim_ids"] = ["C404"]
        step = verify.playbook(run)
        self.assertEqual(step.status, "partial")
        self.assertTrue(any("C404" in c.detail for c in step.checks if not c.ok))

    def test_judge_notices_an_overall_it_did_not_derive(self) -> None:
        run = self.fresh()
        run["judge_summary"]["overall"] = 0.99
        step = verify.judge(run)
        self.assertEqual(step.status, "partial")
        self.assertTrue(
            any("per-claim scores average" in c.detail for c in step.checks if not c.ok)
        )

    def test_judge_notices_a_hallucination_rate_that_contradicts_its_verdicts(self) -> None:
        run = self.fresh()
        run["judge"][0]["grounding"] = "unsupported"
        step = verify.judge(run)
        failed = {c.name for c in step.checks if not c.ok}
        self.assertIn("its hallucination rate matches its own verdicts", failed)
        self.assertIn("it flagged exactly the claims it called unsupported", failed)

    def test_judge_notices_a_claim_it_never_scored(self) -> None:
        run = self.fresh()
        run["judge"] = run["judge"][:-1]
        step = verify.judge(run)
        self.assertTrue(any("skipped" in c.detail for c in step.checks if not c.ok))

    def test_hitl_notices_a_release_with_nobody_named(self) -> None:
        run = self.fresh()
        run["approval"]["reviewer"] = None
        step = verify.hitl(run)
        self.assertEqual(step.status, "partial")
        self.assertTrue(any("a reviewer is named" in c.name for c in step.checks if not c.ok))

    def test_hitl_notices_a_rejection_that_released_something_anyway(self) -> None:
        run = self.fresh()
        run["approval"]["status"] = "rejected"
        run["approval"]["decision"] = "reject"
        step = verify.hitl(run)
        self.assertTrue(any("matches the decision" in c.name for c in step.checks if not c.ok))

    # --- how the agents handed work to each other ------------------------

    def test_the_handoffs_trace_the_whole_chain(self) -> None:
        rep = verify.report(self.snap)
        edges = [(h["frm"], h["to"]) for h in rep["handoffs"]]
        self.assertEqual(
            edges,
            [
                ("watchers", "investigator"),
                ("investigator", "skeptic"),
                ("skeptic", "exposure"),
                ("exposure", "playbook"),
                ("playbook", "judge"),
                ("judge", "hitl"),
                ("hitl", "released"),
            ],
        )
        # Every forward edge carries something counted from the run.
        for h in rep["handoffs"]:
            self.assertTrue(h["carried"], h)

    def test_each_handoff_carries_what_the_run_actually_holds(self) -> None:
        rep = verify.report(self.snap)
        by = {
            (h["frm"], h["to"]): {c["what"]: c["n"] for c in h["carried"]} for h in rep["handoffs"]
        }
        self.assertEqual(by[("watchers", "investigator")]["anomalies"], len(self.snap["anomalies"]))
        self.assertEqual(by[("investigator", "skeptic")]["cited claims"], len(self.snap["claims"]))
        self.assertEqual(
            by[("exposure", "playbook")]["sum insured EUR"],
            self.snap["exposure"]["sum_insured_eur"],
        )
        self.assertEqual(by[("judge", "hitl")]["overall"], "1.00")
        self.assertEqual(by[("hitl", "released")]["decision"], "approve")

    def test_a_back_edge_is_hidden_when_it_never_fired(self) -> None:
        rep = verify.report(self.snap)
        self.assertEqual(rep["loops"], {"revise_rounds": 0, "repair_rounds": 0})
        self.assertFalse([h for h in rep["handoffs"] if h["kind"] == "loop"])

    def test_a_back_edge_shows_up_with_its_count_when_it_did_fire(self) -> None:
        run = self.fresh()
        run["revise_rounds"] = 2
        run["repair_rounds"] = 1
        loops = [h for h in verify.handoffs(run) if h["kind"] == "loop"]
        self.assertEqual(
            [(h["frm"], h["to"], h["fired"]) for h in loops],
            [("skeptic", "investigator", 2), ("judge", "playbook", 1)],
        )

    def test_an_agent_that_never_ran_is_not_counted_as_verified(self) -> None:
        rep = verify.report({})
        self.assertEqual(rep["verified"], 0)
        self.assertTrue(all(s["status"] == "not reached" for s in rep["steps"]))
        self.assertIn("no query ran", rep["data_path"]["verdict"])


if __name__ == "__main__":
    unittest.main()
