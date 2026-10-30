"""Watchers can read gauge_levels. Live data stays off by default."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents.events import EVENTS, RHINE_GAUGES  # noqa: E402
from floodsense_agents.governance import CONTRACT_VIEWS, OWNERS  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes.watchers import make as make_watchers  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris, _gauge_seed_rows  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def _state(event_id: str = "EMSR517") -> dict:
    event = EVENTS[event_id]
    return {
        "run_id": "gauges",
        "event_id": event_id,
        "event": event.as_dict(),
        "request": {"question": event.name, "lang": "en"},
        "provenance": [],
        "evidence": {},
        "anomalies": [],
        "trace": [],
        "hypotheses": [],
        "claims": [],
        "revise_rounds": 0,
        "model_ids": [],
    }


class GaugeContractTest(unittest.TestCase):
    def test_the_gauge_view_is_owned_and_live_stays_off(self) -> None:
        self.assertIn("gauge_levels", CONTRACT_VIEWS)
        self.assertIn("gauge_levels", OWNERS)
        self.assertEqual(OWNERS["gauge_levels"].view, "gauge_levels")
        settings = (ROOT / "agents" / "floodsense_agents" / "settings.py").read_text(
            encoding="utf-8"
        )
        example = (ROOT / "agents" / ".env.example").read_text(encoding="utf-8")
        self.assertIn('_flag("FF_LIVE_DATA", False)', settings)
        self.assertIn("FF_LIVE_DATA=false", example)

    def test_only_the_ahr_event_lists_rhine_gauges(self) -> None:
        self.assertEqual(EVENTS["EMSR773"].gauges, ())
        self.assertIs(EVENTS["EMSR517"].gauges, RHINE_GAUGES)
        self.assertEqual(
            [station for station, _water in RHINE_GAUGES],
            ["BONN", "KÖLN", "KOBLENZ"],
        )
        expected = [
            (station, water, event.window_from_utc, None, "seed:pegelonline")
            for event in EVENTS.values()
            for station, water in event.gauges
        ]
        self.assertEqual(_gauge_seed_rows(), expected)
        self.assertEqual(len(expected), 3)
        readme = (ROOT / "agents" / "README.md").read_text(encoding="utf-8")
        self.assertIn("last 30 days", readme)
        self.assertIn("never overlap the frozen event windows", readme)

    def test_watchers_read_gauge_levels_for_the_ahr_window(self) -> None:
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        out = make_watchers(deps)(_state("EMSR517"))
        sqls = [row["sql"] for row in out["evidence"].values()]
        self.assertEqual(len(sqls), 6)  # rain, rain_total, discharge, warning, gauges, provenance
        gauge_sql = next(sql for sql in sqls if "gauge_levels" in sql)
        self.assertIn("level_cm", gauge_sql)
        self.assertNotIn("SELECT *", gauge_sql.upper())
        again = FakeZetaris().run_sql(gauge_sql)
        self.assertIsNone(again.error)
        self.assertEqual(again.row_count, 3)
        self.assertEqual({row["station"] for row in again.rows_sample}, {"BONN", "KÖLN", "KOBLENZ"})
        self.assertTrue(all(row["level_cm"] is None for row in again.rows_sample))
        self.assertTrue(all(row["source"] == "seed:pegelonline" for row in again.rows_sample))
        self.assertEqual({row["water"] for row in again.rows_sample}, {"RHEIN"})
        kinds = {item["kind"] for item in out["anomalies"]}
        self.assertNotIn("gauge", kinds)
        documented = {row["dataset"] for row in out["provenance"]}
        self.assertIn("gauge_levels", documented)

    def test_valencia_skips_the_gauge_query(self) -> None:
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        out = make_watchers(deps)(_state("EMSR773"))
        sqls = [row["sql"] for row in out["evidence"].values()]
        self.assertEqual(len(sqls), 5)
        self.assertFalse(any("gauge_levels" in sql for sql in sqls))
        self.assertIn("provenance", sqls[-1])


if __name__ == "__main__":
    unittest.main()
