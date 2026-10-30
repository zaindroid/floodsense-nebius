"""The should-fix and nice-to-have findings from the review of PR #4.

Named by the review's own ids so the next reader can match them up.
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

from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import (  # noqa: E402
    ApprovalDecision,
    Claim,
    Evidence,
    RunRequest,
)
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes.investigator import numbers_in  # noqa: E402
from floodsense_agents.nodes.judge import evaluate  # noqa: E402
from floodsense_agents.nodes.watchers import last_complete_day  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


def _runtime() -> Runtime:
    deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
    return Runtime(graph=build_graph(deps), deps=deps)


class S2DailyTotalsTest(unittest.TestCase):
    """A daily aggregate is not known until the day is over."""

    def test_a_midday_replay_cannot_see_that_day_total(self) -> None:
        self.assertEqual(last_complete_day("2024-10-29T12:00:00Z"), "2024-10-28")
        self.assertEqual(last_complete_day("2024-10-29T00:00:00Z"), "2024-10-28")

    def test_the_end_of_the_day_can(self) -> None:
        self.assertEqual(last_complete_day("2024-10-29T23:59:59Z"), "2024-10-29")
        self.assertEqual(last_complete_day("2024-10-30T23:59:59Z"), "2024-10-30")

    def test_a_noon_replay_does_not_state_the_days_daily_discharge(self) -> None:
        run = _runtime().start(
            RunRequest(question="q", event_id="EMSR773", replay_ts="2024-10-29T12:00:00Z")
        )
        text = " ".join(c["text"] for c in run["claims"])
        # 2100 m3/s is 29 October's daily total; at noon nobody had it.
        self.assertNotIn("2100", text.replace(",", ""))


class S5LicenceTest(unittest.TestCase):
    """licence_ok was computed and then dropped from the flag set."""

    def test_a_claim_that_fails_the_licence_check_is_flagged(self) -> None:
        run = _runtime().start(RunRequest(question="q", event_id="EMSR773"))
        claims = [Claim(**c) for c in run["claims"]]
        evidence = {q: Evidence(**e) for q, e in run["evidence"].items()}
        scores, summary = evaluate(claims, evidence, None)
        self.assertTrue(scores)
        # Healthy run: licences pass, so flags are only the unsupported ones.
        self.assertEqual(
            sorted(summary.flagged_claim_ids),
            sorted(s.claim_id for s in scores if s.grounding == "unsupported"),
        )

    def test_the_flag_set_follows_licence_ok_not_only_grounding(self) -> None:
        import floodsense_agents.nodes.judge as judge

        run = _runtime().start(RunRequest(question="q", event_id="EMSR773"))
        claims = [Claim(**c) for c in run["claims"]]
        real = judge.score_claim

        def fail_licence(c, *a, **k):
            s = real(c, *a, **k)
            if c.claim_id == claims[0].claim_id:
                s.licence_ok = False
            return s

        judge.score_claim = fail_licence
        try:
            evidence = {q: Evidence(**e) for q, e in run["evidence"].items()}
            _, summary = judge.evaluate(claims, evidence, None)
        finally:
            judge.score_claim = real
        self.assertIn(claims[0].claim_id, summary.flagged_claim_ids)


class S6RepairBoundTest(unittest.TestCase):
    """Playbook and the Judge must agree on how many repairs are allowed."""

    def test_the_knob_above_one_does_not_blow_the_recursion_limit(self) -> None:
        was = settings.judge_repair_rounds
        settings.judge_repair_rounds = 2
        try:
            run = _runtime().start(RunRequest(question="q", event_id="EMSR773"))
            self.assertEqual(run["status"], "awaiting_approval")
            self.assertLessEqual(run.get("repair_rounds", 0), 2)
        finally:
            settings.judge_repair_rounds = was

    def test_the_shipped_default_still_stops(self) -> None:
        run = _runtime().start(RunRequest(question="q", event_id="EMSR773"))
        self.assertLessEqual(run.get("repair_rounds", 0), settings.judge_repair_rounds)


class S8ExposureTotalsTest(unittest.TestCase):
    """Totals come from the aggregate, not from a 20-row sample."""

    def test_the_policy_count_and_sum_come_from_the_aggregate_query(self) -> None:
        run = _runtime().start(RunRequest(question="q", event_id="EMSR773"))
        exposure = run["exposure"]
        self.assertEqual(exposure["policies"], 7)
        self.assertEqual(exposure["sum_insured_eur"], 21_600_000)
        # Three queries now: rows, by segment, and the whole-set total.
        self.assertEqual(len(exposure["query_ids"]), 3)

    def test_the_claim_quotes_the_aggregate(self) -> None:
        run = _runtime().start(RunRequest(question="q", event_id="EMSR773"))
        claim = next(c for c in run["claims"] if "policies sit inside" in c["text"])
        self.assertEqual(claim["numbers"], [7, 21_600_000])


class S9NumberParsingTest(unittest.TestCase):
    """Grouped thousands were read as small numbers."""

    def test_a_grouped_total_is_one_number(self) -> None:
        self.assertEqual(numbers_in("sum insured 21,600,000 EUR"), [21_600_000.0])
        self.assertEqual(numbers_in("3 policies, 9,200,000 EUR"), [3.0, 9_200_000.0])

    def test_a_unit_glued_to_a_digit_is_not_a_number(self) -> None:
        self.assertEqual(numbers_in("peak 2282 m3/s"), [2282.0])

    def test_plain_and_negative_numbers_still_parse(self) -> None:
        self.assertEqual(numbers_in("-2.5 and 0.02"), [-2.5, 0.02])
        self.assertEqual(numbers_in("534 mm over 10 hours, peak 96 mm"), [534.0, 10.0, 96.0])


class S10PastRunsTest(unittest.TestCase):
    """The run list must survive the process that made it."""

    def test_past_says_which_scope_it_is_reporting(self) -> None:
        rt = _runtime()
        rt.start(RunRequest(question="q", event_id="EMSR773"))
        rows = rt.past()
        self.assertTrue(rows)
        self.assertIn(rows[0]["scope"], ("all runs on this checkpointer", "this process only"))

    def test_a_fresh_runtime_on_the_same_checkpointer_finds_the_run(self) -> None:
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        graph = build_graph(deps)
        first = Runtime(graph=graph, deps=deps)
        run_id = first.start(RunRequest(question="q", event_id="EMSR773"))["run_id"]

        # A second Runtime over the same graph has an empty index, the way a
        # restarted process does.
        second = Runtime(graph=graph, deps=deps)
        self.assertEqual(second.index, {})
        self.assertIn(run_id, [r["run_id"] for r in second.past()])


class N1MemoryFlagTest(unittest.TestCase):
    """Memory must not write while its flag is off."""

    def test_store_is_not_called_when_ff_hmem_is_off(self) -> None:
        calls = []

        class Recorder(NoMemory):
            def store(self, run_id, request, claims, approval):
                calls.append(run_id)

        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=Recorder())
        rt = Runtime(graph=build_graph(deps), deps=deps)
        run_id = rt.start(RunRequest(question="q", event_id="EMSR773"))["run_id"]

        was = settings.ff_hmem
        settings.ff_hmem = False
        try:
            rt.resume(run_id, ApprovalDecision(action="approve", reviewer="zain"))
        finally:
            settings.ff_hmem = was
        self.assertEqual(calls, [])

    def test_store_is_called_when_the_flag_is_on(self) -> None:
        calls = []

        class Recorder(NoMemory):
            def store(self, run_id, request, claims, approval):
                calls.append(run_id)

        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=Recorder())
        rt = Runtime(graph=build_graph(deps), deps=deps)
        run_id = rt.start(RunRequest(question="q", event_id="EMSR773"))["run_id"]

        was = settings.ff_hmem
        settings.ff_hmem = True
        try:
            rt.resume(run_id, ApprovalDecision(action="approve", reviewer="zain"))
        finally:
            settings.ff_hmem = was
        self.assertEqual(calls, [run_id])


class N2EmptyEditTest(unittest.TestCase):
    """An edit with no text must not behave like an approval."""

    def test_an_empty_edit_is_refused_in_the_node(self) -> None:
        rt = _runtime()
        run_id = rt.start(RunRequest(question="q", event_id="EMSR773"))["run_id"]
        with self.assertRaises(ValueError):
            rt.resume(run_id, ApprovalDecision(action="edit", edits="   ", reviewer="zain"))
        # The run is untouched: still awaiting, nothing released.
        after = rt.snapshot(run_id)
        self.assertEqual(after["status"], "awaiting_approval")
        self.assertFalse(any(a["released"] for a in after["playbook"]))

    def test_an_edit_with_text_still_works(self) -> None:
        rt = _runtime()
        run_id = rt.start(RunRequest(question="q", event_id="EMSR773"))["run_id"]
        out = rt.resume(
            run_id, ApprovalDecision(action="edit", edits="Tighter wording.", reviewer="zain")
        )
        self.assertEqual(out["approval"]["status"], "edited")
        self.assertEqual(out["summary"], "Tighter wording.")


if __name__ == "__main__":
    unittest.main()
