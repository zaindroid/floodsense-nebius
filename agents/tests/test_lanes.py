"""Nightshift lane choice for draft nodes, the Judge, and repair.

Investigator, Skeptic, and the first Playbook draft ask for lane "fast".
The Judge and a Playbook repair stay on lane "deep". SKEPTIC_MAX_ROUNDS
stays a setting: 1 is a smoke value, not a constant in the node.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents.events import EVENTS  # noqa: E402
from floodsense_agents.models import Citation, Claim, Evidence  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes.investigator import make as make_investigator  # noqa: E402
from floodsense_agents.nodes.judge import make as make_judge  # noqa: E402
from floodsense_agents.nodes.playbook import make as make_playbook  # noqa: E402
from floodsense_agents.nodes.skeptic import make as make_skeptic  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


def _state() -> dict:
    return {
        "run_id": "lanes",
        "event_id": "EMSR773",
        "event": EVENTS["EMSR773"].as_dict(),
        "request": {"question": "Why are our Valencia sites at risk?", "lang": "en"},
        "provenance": [],
        "evidence": {},
        "anomalies": [],
        "trace": [],
        "hypotheses": [],
        "claims": [],
        "revise_rounds": 0,
        "repair_rounds": 0,
        "model_ids": [],
        "summary": "Rain drove the river.",
        "exposure": {},
        "judge_summary": {},
    }


def _deps(llm: FakeNightshift) -> Deps:
    return Deps(zetaris=FakeZetaris(), llm=llm, memory=NoMemory())


def _draft(system: str, user: str) -> str:
    task = system.split("\n", 1)[0]
    if task.startswith("TASK: investigator"):
        return json.dumps(
            {
                "hypotheses": [
                    {
                        "id": "H1",
                        "link": "rain->catchment",
                        "statement": "Rain fell on the catchment.",
                        "claim_ids": ["C1"],
                    }
                ],
                "claims": [
                    {
                        "claim_id": "C1",
                        "text": "Rain fell on the catchment.",
                        "kind": "fact",
                        "numbers": [],
                        "query_ids": [],
                        "hypothesis_id": "H1",
                    }
                ],
                "summary": "Rain [C1].",
            }
        )
    if task.startswith("TASK: playbook"):
        return json.dumps(
            {
                "actions": [
                    {
                        "action_id": "A9",
                        "horizon_h": 6,
                        "text": "Watch the gauges.",
                        "claim_ids": ["C1"],
                        "outbound": False,
                    }
                ]
            }
        )
    if task.startswith("TASK: repair"):
        return json.dumps(
            {"claims": [{"claim_id": "C1", "text": "The cited rows show 10.", "numbers": [10]}]}
        )
    if task.startswith("TASK: judge"):
        return json.dumps({"grounding": "supported", "rationale": "the rows state it"})
    if task.startswith("TASK: skeptic"):
        return json.dumps({"verdict": "supported", "rationale": "the checks hold"})
    return "{}"


class LaneChoiceTest(unittest.TestCase):
    def test_investigator_draft_uses_the_fast_lane(self) -> None:
        llm = FakeNightshift({"investigator": _draft})
        out = make_investigator(_deps(llm))(_state())
        self.assertEqual([lane for lane, _task, _user in llm.calls], ["fast"] * 3)
        self.assertEqual(out["trace"][-1]["lane"], "fast")

    def test_skeptic_rationale_uses_the_fast_lane(self) -> None:
        llm = FakeNightshift({"skeptic": _draft})
        state = _state()
        state["hypotheses"] = [
            {
                "id": "H1",
                "link": "rain->catchment",
                "statement": "Rain fell.",
                "citations": [],
            }
        ]
        out = make_skeptic(_deps(llm))(state)
        self.assertTrue(llm.calls)
        self.assertTrue(all(lane == "fast" for lane, _task, _user in llm.calls))
        self.assertEqual(out["trace"][-1]["lane"], "sql")

    def test_playbook_draft_uses_the_fast_lane(self) -> None:
        llm = FakeNightshift({"playbook": _draft})
        state = _state()
        # The draft has to cite a claim of this run. An uncited model action
        # is dropped and the deterministic playbook stays on lane "none".
        state["claims"] = [{"claim_id": "C1", "text": "Rain fell on the catchment."}]
        out = make_playbook(_deps(llm))(state)
        self.assertEqual([lane for lane, _task, _user in llm.calls], ["fast"])
        self.assertEqual(out["trace"][-1]["lane"], "fast")
        self.assertEqual(out["playbook"][0]["action_id"], "A9")

    def test_playbook_repair_stays_on_the_deep_lane(self) -> None:
        llm = FakeNightshift({"repair": _draft})
        state = _state()
        state["claims"] = [
            Claim(
                claim_id="C1",
                text="Discharge reached 99999 m3/s.",
                kind="number",
                numbers=[99999],
                citations=[Citation(citation_id="C1-a1", claim_id="C1", layer="a", query_id="q1")],
            ).model_dump()
        ]
        state["evidence"] = {
            "q1": Evidence(
                query_id="q1",
                view="floodsense_seed.hazard_timeline",
                sql="SELECT discharge_m3s FROM floodsense_seed.hazard_timeline",
                rows_sample=[{"discharge_m3s": 10}],
                row_count=1,
                executed_at_utc="2026-10-22T20:00:00Z",
            ).model_dump()
        }
        state["judge_summary"] = {"flagged_claim_ids": ["C1"]}
        out = make_playbook(_deps(llm))(state)
        self.assertEqual([lane for lane, _task, _user in llm.calls], ["deep"])
        self.assertEqual(out["trace"][-1]["lane"], "deep")
        self.assertIn("cited rows", out["claims"][0]["text"])

    def test_judge_grounding_stays_on_the_deep_lane(self) -> None:
        llm = FakeNightshift({"judge": _draft})
        state = _state()
        state["claims"] = [
            Claim(
                claim_id="C1",
                text="Discharge reached 10 m3/s.",
                kind="number",
                numbers=[10],
                citations=[Citation(citation_id="C1-a1", claim_id="C1", layer="a", query_id="q1")],
            ).model_dump()
        ]
        state["evidence"] = {
            "q1": Evidence(
                query_id="q1",
                view="floodsense_seed.hazard_timeline",
                sql="SELECT 1",
                rows_sample=[{"discharge_m3s": 10}],
                row_count=1,
                executed_at_utc="2026-10-22T20:00:00Z",
            ).model_dump()
        }
        out = make_judge(_deps(llm))(state)
        self.assertEqual([lane for lane, _task, _user in llm.calls], ["deep"])
        self.assertEqual(out["trace"][-1]["lane"], "deep")
        self.assertEqual(out["judge"][0]["grounding"], "supported")


class _FailFirstRain(FakeZetaris):
    """The extreme-rain counter-check returns no rows. Later checks must not run."""

    def __init__(self) -> None:
        super().__init__()
        self.sqls: list[str] = []

    def run_sql(self, sql: str, params=None) -> Evidence:
        self.sqls.append(sql)
        evidence = super().run_sql(sql, params)
        if "MAX(rain_mm)" in sql:
            return evidence.model_copy(update={"rows_sample": [], "row_count": 0})
        return evidence


class SkepticRoundsTest(unittest.TestCase):
    def _draft(self) -> dict:
        drafted = make_investigator(_deps(FakeNightshift()))(_state())
        base = _state()
        base.update(drafted)
        return base

    def test_skeptic_max_rounds_follows_the_setting(self) -> None:
        """A smoke run sets SKEPTIC_MAX_ROUNDS=1. The node must not ignore that."""
        base = self._draft()
        with patch.object(settings, "skeptic_max_rounds", 1):
            one = make_skeptic(_deps(FakeNightshift()))(base)
        self.assertTrue(one["hypotheses"])
        self.assertTrue(all(h["rounds"] == 1 for h in one["hypotheses"]))
        with patch.object(settings, "skeptic_max_rounds", 2):
            two = make_skeptic(_deps(FakeNightshift()))(base)
        self.assertTrue(all(h["rounds"] == 2 for h in two["hypotheses"]))

    def test_skeptic_stops_when_a_counter_check_fails(self) -> None:
        base = self._draft()
        base["hypotheses"] = [h for h in base["hypotheses"] if h["link"] == "rain->catchment"]
        zet = _FailFirstRain()
        with patch.object(settings, "skeptic_max_rounds", 3):
            out = make_skeptic(Deps(zetaris=zet, llm=FakeNightshift(), memory=NoMemory()))(base)
        self.assertEqual(out["hypotheses"][0]["status"], "not_supported")
        self.assertEqual(out["hypotheses"][0]["rounds"], 1)
        self.assertEqual(len(zet.sqls), 1)
        self.assertIn("MAX(rain_mm)", zet.sqls[0])


if __name__ == "__main__":
    unittest.main()
