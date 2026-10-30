"""A replay before the discharge peak still keeps the rain link (Ahr, 15:00 UTC)."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents.events import spec  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import Hypothesis  # noqa: E402
from floodsense_agents.nodes.skeptic import _checks_for  # noqa: E402
from floodsense_agents.models import RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


class PrePeakReplay(unittest.TestCase):
    def test_rain_survives_and_only_the_river_link_drops(self) -> None:
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        out = Runtime(graph=build_graph(deps), deps=deps).start(
            RunRequest(
                question="What was known by 15:00 UTC on 14 July 2021?",
                event_id="EMSR517",
                replay_ts="2021-07-14T15:00:00Z",
            )
        )
        links = {h["link"]: h for h in out["hypotheses"]}
        self.assertEqual(links["rain->catchment"]["status"], "supported")
        self.assertNotIn("catchment->river", links)
        self.assertIn("rain", out["summary"].lower())
        self.assertFalse(any("1000" in c["text"] for c in out["claims"]))
        sqls = [e["sql"] for e in out["evidence"].values() if "first_rain" in e["sql"]]
        self.assertTrue(sqls)
        self.assertTrue(all("hazard_timeline r," not in sql for sql in sqls), "no cross join")


def peak_check(z: FakeZetaris, replay_ts: str | None = None) -> bool:
    """Run only the rain-before-peak counter-check of the Ahr rain link."""
    ev = spec("EMSR517")
    state = {"event": ev.as_dict(), "replay_ts": replay_ts, "request": {}}
    h = Hypothesis(id="H1", link="rain->catchment", statement="x")
    name, sql, params = next(c for c in _checks_for(h, state) if "peak" in c[0])
    e = z.run_sql(sql, params)
    assert e.error is None, e.error
    return e.row_count >= 1


class PeakSemantics(unittest.TestCase):
    def test_a_pre_peak_replay_compares_with_the_clock(self) -> None:
        self.assertTrue(peak_check(FakeZetaris(), "2021-07-14T15:00:00Z"))

    def test_full_window_rain_before_the_real_peak(self) -> None:
        z = FakeZetaris()
        # A falling limb after the peak, so 19:00 is an observed peak, not the latest row.
        z._conn.execute(
            "INSERT INTO floodsense_seed.hazard_timeline VALUES ('AHR01', '2021-07-15T06:00:00Z', "
            "NULL, 300, NULL)"
        )
        self.assertTrue(peak_check(z))

    def test_rain_only_after_the_peak_fails(self) -> None:
        z = FakeZetaris()
        z._conn.execute(
            "INSERT INTO floodsense_seed.hazard_timeline VALUES ('AHR01', '2021-07-15T06:00:00Z', "
            "NULL, 300, NULL)"
        )
        z._conn.execute(
            "UPDATE floodsense_seed.hazard_timeline SET ts_utc = '2021-07-14T23:00:00Z' "
            "WHERE point_id = 'AHR02' AND rain_mm > 0"
        )
        self.assertFalse(peak_check(z))

    def test_no_discharge_rows_compare_with_the_clock(self) -> None:
        z = FakeZetaris()
        z._conn.execute("DELETE FROM floodsense_seed.hazard_timeline WHERE point_id = 'AHR01'")
        self.assertTrue(peak_check(z, "2021-07-14T15:00:00Z"))


if __name__ == "__main__":
    unittest.main()
