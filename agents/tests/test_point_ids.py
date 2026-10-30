"""Warehouse point ids and the boolean footprint predicate.

FakeZetaris and the event filters use VAL01–VAL08 and AHR01–AHR04.
Town slugs are not keys. exposure_join.in_footprint is boolean in the views.
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

from floodsense_agents.events import (  # noqa: E402
    AHR_POINT_IDS,
    EVENTS,
    POINT_NAMES,
    VALENCIA_POINT_IDS,
    point_label,
)
from floodsense_agents.governance import IN_FOOTPRINT_SQL, OUTSIDE_FOOTPRINT_SQL  # noqa: E402
from floodsense_agents.models import Hypothesis  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes.exposure import make as make_exposure  # noqa: E402
from floodsense_agents.nodes.investigator import make as make_investigator  # noqa: E402
from floodsense_agents.nodes.skeptic import _checks_for  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris, _SEED  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SLUGS = {"chiva", "turis", "poyo-ribarroja", "poyo-ribaroja", "altenahr", "ahrweiler"}
FOOTPRINT_SQL = "(s.in_flood_footprint = 'yes') AS in_footprint"


def _state(event_id: str) -> dict:
    ev = EVENTS[event_id]
    return {
        "run_id": "points",
        "event_id": event_id,
        "event": ev.as_dict(),
        "request": {"question": ev.name, "lang": "en"},
        "provenance": [],
        "evidence": {},
        "anomalies": [],
        "trace": [],
        "hypotheses": [],
        "claims": [],
        "revise_rounds": 0,
        "model_ids": [],
    }


def _sql_of(update: dict) -> str:
    return " ".join(row["sql"] for row in update["evidence"].values())


class PointVocabularyTest(unittest.TestCase):
    def test_event_ids_are_the_warehouse_ids(self) -> None:
        valencia = EVENTS["EMSR773"]
        ahr = EVENTS["EMSR517"]
        self.assertEqual(valencia.river_points, ("VAL01",))
        self.assertEqual(valencia.rain_points, ("VAL07",))
        self.assertTrue(
            set(valencia.river_points + valencia.rain_points) <= set(VALENCIA_POINT_IDS)
        )
        self.assertEqual(ahr.river_points, ("AHR01",))
        self.assertEqual(ahr.rain_points, ("AHR02",))
        self.assertTrue(set(ahr.river_points + ahr.rain_points) <= set(AHR_POINT_IDS))
        self.assertIn("Chiva", valencia.place_names)
        self.assertEqual(set(VALENCIA_POINT_IDS) | set(AHR_POINT_IDS), set(POINT_NAMES))
        self.assertEqual(point_label("VAL07"), "Chiva (VAL07)")
        self.assertEqual(point_label("VAL01"), "Paiporta (VAL01)")
        self.assertEqual(point_label("AHR01"), "Altenahr (AHR01)")
        self.assertEqual(point_label("AHR02"), "Bad Neuenahr-Ahrweiler (AHR02)")
        self.assertTrue(set(valencia.river_points + valencia.rain_points).isdisjoint(SLUGS))
        self.assertTrue(set(ahr.river_points + ahr.rain_points).isdisjoint(SLUGS))

    def test_fake_seed_uses_those_ids_and_the_copernicus_line(self) -> None:
        hazard = {row[0] for row in _SEED["hazard_timeline"]}
        daily = {row[0] for row in _SEED["discharge_daily"]}
        wanted = set()
        rivers = set()
        for event in EVENTS.values():
            wanted.update(event.river_points)
            wanted.update(event.rain_points)
            rivers.update(event.river_points)
        self.assertEqual(hazard, wanted)
        self.assertEqual(daily, rivers)
        self.assertTrue(hazard.isdisjoint(SLUGS))
        attribution = next(row[4] for row in _SEED["provenance"] if row[1] and "EMSR773" in row[1])
        self.assertEqual(
            attribution,
            "Copernicus Emergency Management Service (© 2024 European Union), EMSR773",
        )
        self.assertNotIn("Generated using Copernicus", attribution)

    def test_seed_migrations_use_the_same_valencia_ids_and_a_boolean_footprint(self) -> None:
        discharge = (
            ROOT / "zetaris/migrations/012_create_seed_view_discharge_daily.sql"
        ).read_text(encoding="utf-8")
        hazard = (ROOT / "zetaris/migrations/013_create_seed_view_hazard_timeline.sql").read_text(
            encoding="utf-8"
        )
        for point_id in EVENTS["EMSR773"].river_points + EVENTS["EMSR773"].rain_points:
            self.assertIn(f"'{point_id}'", discharge)
            self.assertIn(f"'{point_id}'", hazard)
        self.assertNotIn("chiva", discharge.lower())
        self.assertNotIn("altenahr", discharge.lower())
        for name in (
            "014_create_view_exposure_join.sql",
            "016_create_seed_view_exposure_join.sql",
            "018_label_exposure_synthetic.sql",
        ):
            text = (ROOT / "zetaris/migrations" / name).read_text(encoding="utf-8")
            self.assertIn(FOOTPRINT_SQL, text)

    def test_valencia_queries_hit_fake_rows_with_the_boolean_predicate(self) -> None:
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        state = _state("EMSR773")
        investigated = make_investigator(deps)(state)
        sql = _sql_of(investigated)
        self.assertIn("VAL07", sql)
        self.assertIn("VAL01", sql)
        self.assertNotIn("chiva", sql)
        self.assertIn(IN_FOOTPRINT_SQL, sql)
        self.assertNotIn("in_footprint = 1", sql)
        rain = next(
            row for row in investigated["evidence"].values() if "SUM(rain_mm)" in row["sql"]
        )
        flow = next(
            row
            for row in investigated["evidence"].values()
            if "discharge_m3s" in row["sql"] and "hazard_timeline" in row["sql"]
        )
        self.assertGreater(rain["row_count"], 0)
        self.assertGreater(flow["row_count"], 0)
        self.assertTrue(all(row["point_id"] == "VAL07" for row in rain["rows_sample"]))
        claim_text = " ".join(row["text"] for row in investigated["claims"])
        self.assertIn("Chiva (VAL07)", claim_text)
        self.assertIn("Paiporta (VAL01)", claim_text)
        self.assertNotIn("Point VAL07", claim_text)

        exposed = make_exposure(deps)({**state, "claims": [], "hypotheses": []})
        exposure_sql = _sql_of(exposed)
        self.assertIn(IN_FOOTPRINT_SQL, exposure_sql)
        self.assertNotIn("in_footprint = 1", exposure_sql)
        self.assertEqual(exposed["exposure"]["policies"], 7)

        checks = _checks_for(
            Hypothesis(id="H3", link="river->site", statement="sites"),
            state,
        )
        skeptic_sql = " ".join(item[1] for item in checks)
        self.assertIn(IN_FOOTPRINT_SQL, skeptic_sql)
        self.assertIn(OUTSIDE_FOOTPRINT_SQL, skeptic_sql)
        self.assertNotIn("in_footprint = 1", skeptic_sql)
        self.assertNotIn("in_footprint = 0", skeptic_sql)
        for _name, check_sql, params in checks:
            evidence = FakeZetaris().run_sql(check_sql, params or None)
            self.assertGreater(evidence.row_count, 0, check_sql)
            self.assertIsNone(evidence.error)


if __name__ == "__main__":
    unittest.main()
