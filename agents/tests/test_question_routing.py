"""A question that names one event's places routes there, over the screen context."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from floodsense_agents.events import question_event, route_event  # noqa: E402
from floodsense_agents.nodes import scope  # noqa: E402

AHR_Q = "What is the current water level near Ahr Valley? Is it under flooding risk?"
PAIPORTA = {"role": "citizen", "page": "overview", "point_id": "VAL01"}


class QuestionBeatsContext(unittest.TestCase):
    def test_ahr_question_on_paiporta_overview_routes_to_ahr(self) -> None:
        ev, why = route_event(AHR_Q, None, PAIPORTA)
        self.assertEqual(ev, "EMSR517")
        self.assertIn("question names", why)

    def test_routed_ahr_question_passes_the_scope_gate(self) -> None:
        ev, _ = route_event(AHR_Q, None, PAIPORTA)
        self.assertTrue(scope.check(AHR_Q, ev)["in_scope"])

    def test_valencia_town_on_an_ahr_context_routes_to_valencia(self) -> None:
        ev, _ = route_event("Is Paiporta flooding?", None, {"point_id": "AHR01"})
        self.assertEqual(ev, "EMSR773")

    def test_context_decides_when_no_place_is_named(self) -> None:
        self.assertEqual(route_event("Am I at risk?", None, {"point_id": "AHR01"})[0], "EMSR517")
        self.assertEqual(route_event("Am I at risk?", None, PAIPORTA)[0], "EMSR773")

    def test_both_events_named_falls_back_to_context(self) -> None:
        q = "Compare Paiporta and the Ahr valley"
        self.assertIsNone(question_event(q))
        self.assertEqual(route_event(q, None, {"point_id": "AHR01"})[0], "EMSR517")

    def test_explicit_event_id_still_stands(self) -> None:
        self.assertEqual(route_event(AHR_Q, "EMSR773", PAIPORTA)[0], "EMSR773")


class GenericWordsDoNotReroute(unittest.TestCase):
    def test_generic_words_keep_the_context(self) -> None:
        for q in (
            "Is my Valley safe?",
            "Is it Bad?",
            "Is the Ravine rising?",
            "Is the Province at risk?",
        ):
            self.assertIsNone(question_event(q), q)
            self.assertEqual(route_event(q, None, PAIPORTA)[0], "EMSR773", q)

    def test_german_river_in_a_valencia_question_without_context(self) -> None:
        # Names both events: no question winner, so the default (EMSR773) holds.
        self.assertEqual(route_event("Is the Rhine like Paiporta?", None)[0], "EMSR773")
        # A German river alone, no context: EMSR517.
        self.assertEqual(route_event("How high is the Rhine?", None)[0], "EMSR517")

    def test_full_word_place_names_only(self) -> None:
        self.assertIsNone(question_event("Is Chivalry dead?"))
        self.assertEqual(question_event("Rain at Chiva?"), ("EMSR773", "Chiva"))


class WarmDecline(unittest.TestCase):
    def test_explicit_valencia_decline_is_warm_and_honest(self) -> None:
        verdict = scope.check(AHR_Q, "EMSR773")
        self.assertFalse(verdict["in_scope"])
        self.assertEqual(verdict["elsewhere"], "EMSR517")
        r = verdict["reason"]
        self.assertTrue(r.startswith("That's about the German Rhine/Ahr case (EMSR517:"), r)
        self.assertIn("I'm looking at Valencia (EMSR773) here", r)
        self.assertIn("no data on Ahr, Valley", r)
        self.assertIn("Switch to the German Rhine/Ahr case and I'll answer it.", r)

    def test_rhine_question_is_not_called_the_2021_flood(self) -> None:
        r = scope.check("How high is the Rhine at Köln?", "EMSR773")["reason"]
        self.assertNotIn("That's about the Ahr valley flood", r)
        self.assertIn("German Rhine/Ahr case", r)
        self.assertIn("Rhine", r)

    def test_reverse_direction(self) -> None:
        verdict = scope.check("How much rain fell at Chiva?", "EMSR517")
        self.assertEqual(verdict["elsewhere"], "EMSR773")
        self.assertIn("Switch to the Valencia case", verdict["reason"])
        self.assertIn("Chiva", verdict["reason"])


if __name__ == "__main__":
    unittest.main()
