"""The gate that lets the agents decline.

Refusing a fair question is worse than answering a vague one, so the
accept cases matter as much as the refusals.
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
from floodsense_agents.models import RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes import scope  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


class Counting(FakeZetaris):
    """Counts queries, so a refusal can be shown to read nothing."""

    def __init__(self) -> None:
        super().__init__()
        self.queries = 0

    def run_sql(self, sql, params=None):
        self.queries += 1
        return super().run_sql(sql, params)


class ScopeRuleTest(unittest.TestCase):
    def accepts(self, question: str, event: str = "EMSR773") -> bool:
        return scope.check(question, event)["in_scope"]

    def test_a_question_naming_no_place_is_answered(self) -> None:
        for q in (
            "Which of our sites are at risk, and why?",
            "what should we do in the next six hours",
            "how much is exposed",
        ):
            self.assertTrue(self.accepts(q), q)

    def test_a_question_about_this_event_is_answered(self) -> None:
        for q in (
            "Why are our Valencia sites at risk?",
            "What happened in the Poyo ravine?",
            "How much rain fell at Chiva?",
            "Is the Barranco del Poyo still rising?",
        ):
            self.assertTrue(self.accepts(q), q)

    def test_a_question_about_the_other_event_names_that_case(self) -> None:
        verdict = scope.check("How bad was the Ahr valley?", "EMSR773")
        self.assertFalse(verdict["in_scope"])
        self.assertEqual(verdict["elsewhere"], "EMSR517")
        self.assertIn("EMSR517", verdict["reason"])
        self.assertIn("Ahr valley flood", verdict["reason"])
        self.assertIn("Switch to the German Rhine/Ahr case", verdict["reason"])

    def test_the_rhine_on_a_valencia_run_names_the_ahr_case(self) -> None:
        verdict = scope.check("What is the risk on the Rhine at Koeln?", "EMSR773")
        self.assertFalse(verdict["in_scope"])
        self.assertEqual(verdict["elsewhere"], "EMSR517")

    def test_a_question_nothing_covers_is_refused_with_what_we_do_hold(self) -> None:
        verdict = scope.check("What is the risk on the Danube at Vienna?", "EMSR773")
        self.assertFalse(verdict["in_scope"])
        self.assertIsNone(verdict["elsewhere"])
        self.assertIn("danube", verdict["reason"].lower())
        self.assertIn("hazard_timeline", verdict["reason"])
        self.assertIn("gauge_levels", verdict["reason"])
        self.assertIn("Valencia", verdict["reason"])

    def test_a_refusal_is_written_as_a_sentence(self) -> None:
        # It is the whole answer a person sees, not a log line.
        for q, ev in (
            ("What is the risk on the Rhine at Koeln?", "EMSR773"),
            ("How bad was the Ahr valley?", "EMSR773"),
        ):
            reason = scope.check(q, ev)["reason"]
            self.assertTrue(reason[:1].isupper(), reason)

    def test_a_month_or_a_data_provider_is_not_a_place(self) -> None:
        # The gate refused these four on its first run. Refusing a fair
        # question is worse than answering a vague one.
        for q in (
            "What do we know as of noon on 29 October 2024?",
            "How many of our policies are inside the Copernicus footprint?",
            "What did AEMET report on Tuesday?",
            "What does GloFAS say about the discharge?",
        ):
            self.assertTrue(self.accepts(q), q)
        self.assertTrue(self.accepts("What was known by 15:00 UTC on 14 July 2021?", "EMSR517"))

    def test_a_named_gauge_provider_is_not_a_place(self) -> None:
        # PEGELONLINE is a source behind gauge_levels, not a town this run lacks.
        self.assertTrue(self.accepts("What did Pegelonline report for our sites?"))
        self.assertTrue(self.accepts("What does Wsv publish on the gauges?"))

    def test_the_gate_reads_the_event_rather_than_a_hard_coded_list(self) -> None:
        # Asking the Ahr case about the Ahr is fine; the vocabulary follows
        # whichever event the run is for.
        self.assertTrue(self.accepts("How bad was the Ahr valley?", "EMSR517"))
        self.assertFalse(self.accepts("What happened in Valencia?", "EMSR517"))


class ScopeRunTest(unittest.TestCase):
    def run_with(self, question: str, zetaris=None) -> dict:
        deps = Deps(zetaris=zetaris or FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        rt = Runtime(graph=build_graph(deps), deps=deps)
        return rt.start(RunRequest(question=question, event_id="EMSR773"))

    def test_an_answerable_question_still_runs_the_whole_graph(self) -> None:
        run = self.run_with("Which of our sites are at risk, and why?")
        self.assertEqual(run["status"], "awaiting_approval")
        self.assertTrue(run["claims"])
        self.assertTrue(run["playbook"])

    def test_a_refused_question_produces_no_answer_at_all(self) -> None:
        run = self.run_with("What is the risk on the Danube at Vienna?")
        self.assertEqual(run["status"], "out_of_scope")
        self.assertEqual(run["claims"], [])
        self.assertEqual(run["playbook"], [])
        self.assertEqual(run["hypotheses"], [])
        self.assertFalse(run["exposure"])
        self.assertIn("danube", run["summary"].lower())

    def test_a_refusal_reads_nothing_and_calls_no_model(self) -> None:
        z = Counting()
        run = self.run_with("Tell me about flooding in Bangkok", zetaris=z)
        self.assertEqual(run["status"], "out_of_scope")
        self.assertEqual(z.queries, 0)
        self.assertEqual(run["evidence"], {})
        self.assertEqual(run["model_ids"], [])

    def test_the_refusal_is_on_the_trace_so_it_can_be_audited(self) -> None:
        run = self.run_with("What is the risk on the Danube at Vienna?")
        gate = next(t for t in run["trace"] if t["node"] == "scope")
        self.assertIn("declined", gate["summary"])
        self.assertFalse(run["scope"]["in_scope"])


if __name__ == "__main__":
    unittest.main()
