"""Exposure claims when Zetaris returns numeric columns as strings.

Live JDBC/REST sends DECIMAL sums as strings. The fake SQLite path returns
floats, so a unit test has to put the string on the row itself.
"""

from __future__ import annotations

import os
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents.events import EVENTS  # noqa: E402
from floodsense_agents.models import Evidence  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes.exposure import make  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


def _state() -> dict:
    return {
        "run_id": "string-money",
        "event": EVENTS["EMSR773"].as_dict(),
        "claims": [],
        "hypotheses": [],
        "provenance": [],
        "evidence": {},
        "trace": [],
    }


def _node(zetaris: FakeZetaris):
    deps = Deps(zetaris=zetaris, llm=FakeNightshift(), memory=NoMemory())
    return make(deps)


class StringDecimals(FakeZetaris):
    """SUM(sum_insured_eur) and COUNT come back as text, as on the live path."""

    def run_sql(self, sql: str) -> Evidence:
        evidence = super().run_sql(sql)
        rows = []
        for row in evidence.rows_sample:
            item = dict(row)
            if "sum_insured_eur" in item and item["sum_insured_eur"] is not None:
                item["sum_insured_eur"] = f"{item['sum_insured_eur']:.2f}"
            if "policies" in item and item["policies"] is not None:
                item["policies"] = str(item["policies"])
            rows.append(item)
        return evidence.model_copy(update={"rows_sample": rows})


class DecimalSums(FakeZetaris):
    """The same aggregates as decimal.Decimal, which JDBC drivers also return."""

    def run_sql(self, sql: str) -> Evidence:
        evidence = super().run_sql(sql)
        rows = []
        for row in evidence.rows_sample:
            item = dict(row)
            if "sum_insured_eur" in item and item["sum_insured_eur"] is not None:
                item["sum_insured_eur"] = Decimal(f"{item['sum_insured_eur']:.2f}")
            rows.append(item)
        return evidence.model_copy(update={"rows_sample": rows})


class UnreadableSegment(FakeZetaris):
    """The segment total is not a number. The node must not raise on it."""

    def run_sql(self, sql: str) -> Evidence:
        evidence = super().run_sql(sql)
        if "GROUP BY segment" not in sql:
            return evidence
        rows = []
        for row in evidence.rows_sample:
            item = dict(row)
            item["sum_insured_eur"] = "not-a-number"
            rows.append(item)
        return evidence.model_copy(update={"rows_sample": rows})


class ExposureStringMoneyTest(unittest.TestCase):
    def test_a_string_sum_insured_still_formats_the_segment_claim(self) -> None:
        out = _node(StringDecimals())(_state())
        claim = next(c for c in out["claims"] if "most exposed segment" in c["text"])
        self.assertIn("retail: 3 policies, 9,200,000 EUR sum insured", claim["text"])
        self.assertEqual(claim["numbers"], [3, 9_200_000])
        retail = next(g for g in out["exposure"]["by_segment"] if g["segment"] == "retail")
        self.assertIsInstance(retail["sum_insured_eur"], float)
        self.assertEqual(retail["sum_insured_eur"], 9_200_000)
        self.assertIsInstance(retail["policies"], int)
        self.assertEqual(out["exposure"]["sum_insured_eur"], 21_600_000)
        largest = next(c for c in out["claims"] if "largest" in c["text"])
        self.assertIn("6,500,000 EUR", largest["text"])

    def test_a_decimal_sum_insured_formats_the_same_way(self) -> None:
        out = _node(DecimalSums())(_state())
        claim = next(c for c in out["claims"] if "most exposed segment" in c["text"])
        self.assertIn("9,200,000 EUR sum insured", claim["text"])
        self.assertEqual(claim["numbers"], [3, 9_200_000])
        retail = next(g for g in out["exposure"]["by_segment"] if g["segment"] == "retail")
        self.assertIsInstance(retail["sum_insured_eur"], float)
        self.assertEqual(retail["sum_insured_eur"], 9_200_000)

    def test_an_unreadable_segment_sum_falls_back_instead_of_raising(self) -> None:
        out = _node(UnreadableSegment())(_state())
        claim = next(c for c in out["claims"] if "most exposed segment" in c["text"])
        self.assertIn("0 EUR sum insured", claim["text"])
        self.assertEqual(claim["numbers"][1], 0)
        self.assertEqual(out["exposure"]["sum_insured_eur"], 21_600_000)


if __name__ == "__main__":
    unittest.main()
