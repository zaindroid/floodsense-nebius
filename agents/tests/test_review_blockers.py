"""The three blocking findings from the review of PR #4.

Each test reproduces the reported behaviour first, the way the review did,
then asserts the fix. Named so the next person can match them to the review.
"""

from __future__ import annotations

import os
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from pydantic import ValidationError  # noqa: E402

from floodsense_agents.events import EVENTS  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import Evidence, RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris, check_sql, now_utc  # noqa: E402


class BrokenExposure(FakeZetaris):
    """Every exposure_join query fails, the way a dropped connection would."""

    def run_sql(self, sql: str, params: tuple[str, ...] | None = None) -> Evidence:
        if "exposure_join" in sql:
            return Evidence(
                query_id=str(uuid.uuid4()),
                view="exposure_join",
                sql=sql,
                rows_sample=[],
                row_count=0,
                executed_at_utc=now_utc(),
                source="zetaris-fake",
                error="connection reset by peer",
            )
        return super().run_sql(sql, params)


def _run(zetaris=None, **req) -> dict:
    deps = Deps(zetaris=zetaris or FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
    rt = Runtime(graph=build_graph(deps), deps=deps)
    req.setdefault("question", "Which of our sites are at risk, and why?")
    req.setdefault("event_id", "EMSR773")
    return rt.start(RunRequest(**req))


class B1FailedQueryTest(unittest.TestCase):
    """A failed query must not become an exposure recommendation."""

    def setUp(self) -> None:
        self.run = _run(zetaris=BrokenExposure())

    def test_no_money_is_claimed_when_the_portfolio_query_failed(self) -> None:
        exposure = self.run["exposure"]
        self.assertEqual(exposure.get("policies", 0), 0)
        self.assertEqual(exposure.get("sum_insured_eur", 0), 0)
        text = " ".join(c["text"] for c in self.run["claims"])
        self.assertNotIn("21,600,000", text)
        self.assertNotIn("policies sit inside", text)

    def test_nothing_outbound_is_drafted_on_a_hole(self) -> None:
        self.assertEqual(sum(1 for a in self.run["playbook"] if a.get("outbound")), 0)

    def test_the_hypothesis_says_unknown_rather_than_none_exposed(self) -> None:
        h4 = next(h for h in self.run["hypotheses"] if h["id"] == "H4")
        self.assertIn("unknown", h4["statement"].lower())
        self.assertIn("failed", h4["rationale"])

    def test_the_failures_reach_the_reviewer(self) -> None:
        failures = self.run["failures"]
        self.assertTrue(failures)
        self.assertEqual({f["view"] for f in failures}, {"exposure_join"})
        self.assertTrue(all(f["error"] for f in failures))

    def test_a_healthy_run_reports_no_failures_and_still_answers(self) -> None:
        healthy = _run()
        self.assertEqual(healthy["failures"], [])
        self.assertEqual(healthy["exposure"]["policies"], 7)


class B2FootprintScopeTest(unittest.TestCase):
    """The footprint belongs to one event, and only after it was published."""

    def test_an_ahr_run_does_not_report_the_valencia_portfolio(self) -> None:
        run = _run(event_id="EMSR517")
        self.assertEqual(run["exposure"]["policies"], 0)
        text = " ".join(c["text"] for c in run["claims"])
        self.assertNotIn("P-1003", text)
        self.assertNotIn("21,600,000", text)
        h4 = next(h for h in run["hypotheses"] if h["id"] == "H4")
        self.assertIn("No insured site", h4["statement"])

    def test_valencia_still_reports_its_own_portfolio(self) -> None:
        run = _run(event_id="EMSR773")
        self.assertEqual(run["exposure"]["policies"], 7)
        self.assertEqual(run["exposure"]["sum_insured_eur"], 21_600_000)

    def test_a_replay_before_the_mapping_cannot_use_the_footprint(self) -> None:
        run = _run(event_id="EMSR773", replay_ts="2024-10-29T12:00:00Z")
        self.assertEqual(run["exposure"]["policies"], 0)
        h4 = next(h for h in run["hypotheses"] if h["id"] == "H4")
        self.assertIn("not published yet", h4["statement"])
        self.assertIn("2024-10-30", h4["rationale"])

    def test_a_replay_after_the_mapping_can(self) -> None:
        run = _run(event_id="EMSR773", replay_ts="2024-10-30T06:00:00Z")
        self.assertEqual(run["exposure"]["policies"], 7)

    def test_every_event_declares_its_scope(self) -> None:
        for spec in EVENTS.values():
            lat0, lat1, lon0, lon1 = spec.bbox
            self.assertLess(lat0, lat1, spec.event_id)
            self.assertLess(lon0, lon1, spec.event_id)
            self.assertRegex(spec.footprint_published_utc, r"^\d{4}-\d{2}-\d{2}T")


class B3ReplayClockTest(unittest.TestCase):
    """replay_ts reaches SQL predicates, so it is checked before it gets there."""

    def test_a_quote_in_the_clock_is_refused_at_the_wire(self) -> None:
        for bad in (
            "' OR 1=1 --",
            "2024-10-29T16:00:00Z' OR '1'='1",
            "yesterday",
            "2024-10-29T16:00:00Z; DROP TABLE hazard_timeline",
        ):
            with self.assertRaises(ValidationError, msg=bad):
                RunRequest(question="q", replay_ts=bad)

    def test_a_real_instant_is_accepted_and_normalised(self) -> None:
        self.assertEqual(
            RunRequest(question="q", replay_ts="2024-10-29T16:00:00Z").replay_ts,
            "2024-10-29T16:00:00Z",
        )
        self.assertEqual(
            RunRequest(question="q", replay_ts="2024-10-29T16:00Z").replay_ts,
            "2024-10-29T16:00:00Z",
        )
        self.assertEqual(
            RunRequest(question="q", replay_ts="2024-10-29 16:00:00Z").replay_ts,
            "2024-10-29T16:00:00Z",
        )
        self.assertIsNone(RunRequest(question="q", replay_ts="").replay_ts)

    def test_a_clock_is_bound_and_a_raw_fragment_is_refused(self) -> None:
        z = FakeZetaris()
        ev = z.run_sql(
            "SELECT COUNT(*) AS n FROM floodsense_seed.hazard_timeline WHERE ts_utc <= ?",
            ("2024-10-29T12:00:00Z",),
        )
        self.assertIsNone(ev.error)
        self.assertNotIn("?", ev.sql)
        self.assertIn("2024-10-29T12:00:00Z", ev.sql)
        bad = z.run_sql(
            "SELECT 1 FROM floodsense_seed.hazard_timeline WHERE ts_utc <= ?", ("' OR 1=1 --",)
        )
        self.assertIsNotNone(bad.error)

    def test_a_with_that_then_mutates_is_refused(self) -> None:
        for bad in (
            "WITH x AS (SELECT 1) DELETE FROM floodsense_seed.hazard_timeline",
            "WITH t AS (SELECT 1) INSERT INTO floodsense_seed.exposure_join SELECT * FROM t",
            "SELECT 1; DELETE FROM floodsense_seed.hazard_timeline",
            "DROP TABLE hazard_timeline",
        ):
            with self.assertRaises(ValueError, msg=bad):
                check_sql(bad)

    def test_the_fake_still_holds_its_rows_after_a_mutation_attempt(self) -> None:
        z = FakeZetaris()
        count = "SELECT COUNT(*) AS n FROM floodsense_seed.hazard_timeline"
        before = z.run_sql(count).rows_sample[0]["n"]
        with self.assertRaises(ValueError):
            z.run_sql("WITH x AS (SELECT 1) DELETE FROM floodsense_seed.hazard_timeline")
        self.assertEqual(z.run_sql(count).rows_sample[0]["n"], before)

    def test_ordinary_reads_are_untouched(self) -> None:
        self.assertEqual(
            check_sql("  SELECT point_id FROM floodsense_seed.hazard_timeline ;  "),
            "SELECT point_id FROM floodsense_seed.hazard_timeline",
        )
        self.assertTrue(check_sql("WITH t AS (SELECT 1) SELECT * FROM t"))


if __name__ == "__main__":
    unittest.main()
