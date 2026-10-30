"""Zetaris resolves a view once per statement; the fake does not, so assert it here.

A SCHEMASTORE VIEW named twice in one statement -- joined, in a subquery, or
under UNION -- fails on Zetaris with MISSING_ATTRIBUTES, whatever the rest of
the query says. FakeZetaris runs the same SQL through SQLite, which is happy to
read a view as often as it likes, so a statement that can never run in
production still passes every test that goes through the fake. Reference the
view once and read the rest from a CTE.
"""

from __future__ import annotations

import os
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents.events import spec  # noqa: E402
from floodsense_agents.live import LIVE  # noqa: E402
from floodsense_agents.models import Hypothesis  # noqa: E402
from floodsense_agents.nodes.skeptic import _checks_for  # noqa: E402

LINKS = ("rain->catchment", "catchment->river", "river->site")
# floodsense.hazard_timeline / floodsense_seed.hazard_now / ... as written in the SQL.
VIEW = re.compile(r"\bfloodsense(?:_seed)?\.(\w+)", re.I)


def duplicated_views(sql: str) -> set[str]:
    names = VIEW.findall(sql)
    return {n for n in names if names.count(n) > 1}


def every_check():
    """(mode, event, link, name, sql) for every counter-check the Skeptic builds."""
    for event_id in ("EMSR773", "EMSR517"):
        ev = spec(event_id).as_dict()
        for mode, state in (
            ("replay", {"event": ev, "replay_ts": None, "request": {}}),
            ("live", {"event": ev, "replay_ts": None, "request": {}, "mode": {"mode": LIVE}}),
        ):
            for link in LINKS:
                h = Hypothesis(id="H1", link=link, statement="x")
                for check in _checks_for(h, state):
                    # (name, sql, params); some branches carry extra fields.
                    yield mode, event_id, link, check[0], check[1]


class OneViewPerStatement(unittest.TestCase):
    def test_no_counter_check_names_a_view_twice(self) -> None:
        offenders = [
            f"{mode}/{event}/{link}: {name} repeats {sorted(dupes)}"
            for mode, event, link, name, sql in every_check()
            if (dupes := duplicated_views(sql))
        ]
        self.assertEqual([], offenders, "\n".join(offenders))

    def test_the_checks_are_actually_built(self) -> None:
        """A guard that passes because it inspected nothing is not a guard."""
        checks = list(every_check())
        self.assertGreater(len(checks), 10)
        self.assertTrue(any("peak" in name for _m, _e, _l, name, _s in checks))

    def test_the_guard_catches_a_second_reference(self) -> None:
        one = "SELECT a FROM floodsense.hazard_timeline WHERE b > 0"
        two = f"{one} UNION ALL SELECT a FROM floodsense.hazard_timeline WHERE c > 0"
        self.assertEqual(set(), duplicated_views(one))
        self.assertEqual({"hazard_timeline"}, duplicated_views(two))
        # Two different views in one statement is fine, and must not be flagged.
        self.assertEqual(
            set(),
            duplicated_views(
                "SELECT x FROM floodsense.hazard_timeline UNION ALL "
                "SELECT y FROM floodsense.discharge_daily"
            ),
        )


if __name__ == "__main__":
    unittest.main()
