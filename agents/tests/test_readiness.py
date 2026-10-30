"""Each rung passes on a good run, and fails when its evidence is taken away.

The second half is the point. A check that cannot fail proves nothing, so
every rung here is broken on purpose and asserted to notice.
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
os.environ.setdefault("FF_JUDGE", "true")

from floodsense_agents import readiness  # noqa: E402
from floodsense_agents.governance import DATA_PRODUCTS  # noqa: E402
from floodsense_agents.models import RunRequest  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402

ROUTES = {p.route for p in DATA_PRODUCTS}


class ReadinessTest(unittest.TestCase):
    snap: dict
    rt: Runtime

    @classmethod
    def setUpClass(cls) -> None:
        # settings was built when some earlier module imported it, so the flag
        # is set here rather than through the environment.
        cls._judge_was = settings.ff_judge
        settings.ff_judge = True
        cls.rt = Runtime()
        cls.snap = cls.rt.start(
            RunRequest(question="Why are our Valencia sites at risk?", event_id="EMSR773")
        )

    @classmethod
    def tearDownClass(cls) -> None:
        settings.ff_judge = cls._judge_was

    def fresh(self) -> dict:
        return copy.deepcopy(self.snap)

    def status(self, fn, run: dict) -> str:
        rung = (
            fn(run, self.rt.deps, ROUTES)
            if fn is readiness.data_products
            else fn(run, self.rt.deps)
        )
        return rung.status

    # --- the run as it stands ------------------------------------------

    def test_the_report_covers_eight_rungs_and_every_agent(self) -> None:
        rep = readiness.report(self.snap, self.rt.deps, ROUTES)
        self.assertEqual([r["n"] for r in rep["rungs"]], [1, 2, 3, 4, 5, 6, 7, 8])
        self.assertEqual(rep["of"], 8)
        self.assertEqual(
            [a["agent"] for a in rep["agents"]],
            ["watchers", "investigator", "skeptic", "exposure", "playbook", "judge", "hitl"],
        )
        # Every rung names at least one agent, and every agent is covered by one.
        covered = {a for r in rep["rungs"] for a in r["agents"]}
        for name, _title, _lane, _does in readiness.AGENTS:
            self.assertIn(name, covered, f"{name} is not covered by any rung")

    def test_the_rungs_that_pass_today_pass(self) -> None:
        for fn in (
            readiness.ownership,
            readiness.definitions,
            readiness.data_quality,
            readiness.lineage,
            readiness.semantic_layer,
            readiness.data_products,
        ):
            self.assertEqual(self.status(fn, self.fresh()), "pass", fn.__name__)

    def test_the_two_known_gaps_are_reported_not_hidden(self) -> None:
        meta = readiness.metadata(self.fresh(), self.rt.deps)
        self.assertEqual(meta.status, "partial")
        self.assertTrue(any("source_url" in g for g in meta.gaps))

        access = readiness.access_rights(self.fresh(), self.rt.deps)
        self.assertEqual(access.status, "partial")
        self.assertTrue(any("Licence not settled" in g for g in access.gaps))
        # The licence gap must not be mistaken for a read-path or release failure.
        by_name = {c.name: c.ok for c in access.checks}
        self.assertTrue(by_name["the data path refuses anything but SELECT"])
        self.assertTrue(by_name["outbound actions stay held until the decision"])

    def test_the_report_lists_every_gap_from_a_rung_that_is_not_passing(self) -> None:
        rep = readiness.report(self.snap, self.rt.deps, ROUTES)
        self.assertEqual(rep["passed"], 6)
        self.assertEqual(len(rep["blocking"]), 3)

    # --- break each rung on purpose --------------------------------------

    def test_01_notices_an_unowned_view(self) -> None:
        run = self.fresh()
        qid = next(iter(run["evidence"]))
        run["evidence"][qid]["sql"] = "SELECT * FROM floodsense_seed.secret_ledger"
        self.assertEqual(self.status(readiness.ownership, run), "partial")

    def test_01_notices_a_release_with_no_reviewer(self) -> None:
        run = self.fresh()
        for a in run["playbook"]:
            a["released"] = True
        run["approval"] = {"status": "approved", "decision": "approve", "reviewer": None}
        rung = readiness.ownership(run, self.rt.deps)
        self.assertEqual(rung.status, "partial")
        self.assertTrue(any("no reviewer" in g for g in rung.gaps))

    def test_02_notices_a_threshold_that_drifted_from_its_definition(self) -> None:
        run = self.fresh()
        run["anomalies"][0]["why"] = "hourly rain at or above 25 mm"
        rung = readiness.definitions(run, self.rt.deps)
        self.assertEqual(rung.status, "partial")
        self.assertTrue(any("25 mm" in c.detail for c in rung.checks if not c.ok))

    def test_03_notices_a_failed_query_and_an_undecided_link(self) -> None:
        run = self.fresh()
        qid = next(iter(run["evidence"]))
        run["evidence"][qid]["error"] = "connection reset"
        run["hypotheses"][0]["status"] = "proposed"
        rung = readiness.data_quality(run, self.rt.deps)
        self.assertEqual(rung.status, "partial")
        failed = {c.name for c in rung.checks if not c.ok}
        self.assertIn("no query failed silently", failed)
        self.assertIn("every link of the chain was ruled on", failed)

    def test_03_notices_a_hole_that_stopped_being_declared(self) -> None:
        run = self.fresh()
        run["claims"] = [c for c in run["claims"] if "no discharge value" not in c["text"]]
        rung = readiness.data_quality(run, self.rt.deps)
        self.assertTrue(any("gauge outage" in g for g in rung.gaps))

    def test_04_notices_a_view_with_no_provenance_row(self) -> None:
        run = self.fresh()
        run["provenance"] = [r for r in run["provenance"] if r["dataset"] != "exposure_join"]
        rung = readiness.metadata(run, self.rt.deps)
        self.assertTrue(any("exposure_join" in c.detail for c in rung.checks if not c.ok))

    def test_05_notices_a_claim_whose_citation_goes_nowhere(self) -> None:
        run = self.fresh()
        for c in run["claims"]:
            for ct in c["citations"]:
                if ct["layer"] == "a":
                    ct["query_id"] = "does-not-exist"
        rung = readiness.lineage(run, self.rt.deps)
        self.assertEqual(rung.status, "partial")
        self.assertTrue(any("dangling" in c.detail for c in rung.checks if not c.ok))

    def test_05_notices_an_uncited_claim(self) -> None:
        run = self.fresh()
        run["claims"][0]["citations"] = []
        rung = readiness.lineage(run, self.rt.deps)
        self.assertEqual(rung.status, "partial")

    def test_06_notices_a_query_outside_the_contract_views(self) -> None:
        run = self.fresh()
        run["evidence"]["x"] = {
            "query_id": "x",
            "view": "raw_gauges",
            "sql": "SELECT * FROM warehouse.raw_gauges",
            "rows_sample": [],
            "row_count": 0,
            "executed_at_utc": "2026-01-01T00:00:00Z",
        }
        rung = readiness.semantic_layer(run, self.rt.deps)
        self.assertEqual(rung.status, "fail")
        failed = {c.name for c in rung.checks if not c.ok}
        self.assertEqual(
            failed,
            {
                "every query reads a contract view and nothing else",
                "one schema for the whole run",
                "no query selects columns it did not name",
            },
        )

    def test_07_notices_an_outbound_action_released_before_the_decision(self) -> None:
        run = self.fresh()
        run["playbook"][0]["released"] = True
        run["approval"] = {"status": "awaiting"}
        rung = readiness.access_rights(run, self.rt.deps)
        self.assertTrue(any("released early" in c.detail for c in rung.checks if not c.ok))
        self.assertTrue(any("before the reviewer answered" in g for g in rung.gaps))

    def test_07_notices_a_data_path_that_would_accept_a_write(self) -> None:
        class Permissive:
            def run_sql(self, sql):
                return None

        class Deps:
            zetaris = Permissive()

        rung = readiness.access_rights(self.fresh(), Deps())
        self.assertFalse(
            next(c for c in rung.checks if c.name == "the data path refuses anything but SELECT").ok
        )

    def test_08_notices_a_promised_route_that_is_not_served(self) -> None:
        rung = readiness.data_products(self.fresh(), self.rt.deps, {"/readiness"})
        self.assertEqual(rung.status, "partial")
        self.assertTrue(any("missing" in c.detail for c in rung.checks if not c.ok))

    def test_08_notices_a_snapshot_missing_a_promised_field(self) -> None:
        run = self.fresh()
        del run["judge_summary"]
        run.pop("served_from", None)
        rung = readiness.data_products(run, self.rt.deps, ROUTES)
        self.assertEqual(rung.status, "partial")

    # --- the report survives having nothing to look at --------------------

    def test_an_empty_run_reports_unknown_rather_than_passing(self) -> None:
        rep = readiness.report({}, self.rt.deps, ROUTES)
        self.assertEqual(rep["passed"], 0)
        self.assertTrue(all(r["status"] != "pass" for r in rep["rungs"]))
        self.assertTrue(all(a["ran"] is False for a in rep["agents"]))


if __name__ == "__main__":
    unittest.main()
