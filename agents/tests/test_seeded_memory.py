"""Seeded H-MEM items (tasks.py demo-seed) stay labelled inside a run."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from floodsense_agents.engines import memory_origin  # noqa: E402
from floodsense_agents.nodes.investigator import memory_block  # noqa: E402
from floodsense_agents.state import memory_used  # noqa: E402

SEEDED = {
    "memory_id": "m1",
    "content": "Daily discharge for Altenahr (AHR01) was 249.61 m3/s.",
    "run_id": "demo-seed-ahr-altenahr",
    "relevance": 0.3,
    "tags": ["floodsense", "entity:demo-seed"],
    "provenance": {"learned_at": "2026-10-27T09:00:00Z", "label": "run demo-seed-ahr-altenahr approved by demo-seed"},
}
REAL = {
    "memory_id": "m2",
    "content": "Paiporta finding",
    "run_id": "r1",
    "relevance": 0.2,
    "tags": ["floodsense"],
    "provenance": {"learned_at": "2026-10-27T10:00:00Z", "label": "run r1 edited by ana"},
}


class SeededMemoryTest(unittest.TestCase):
    def test_origin(self) -> None:
        self.assertEqual(memory_origin(SEEDED), (True, "demo-seed"))
        self.assertEqual(memory_origin(REAL), (False, "ana"))
        self.assertEqual(memory_origin({}), (False, None))

    def test_memory_used_carries_seeded_and_reviewer(self) -> None:
        used = memory_used([SEEDED, REAL])
        self.assertEqual([u["seeded"] for u in used], [True, False])
        self.assertEqual([u["reviewer"] for u in used], ["demo-seed", "ana"])

    def test_prompt_marks_seeded_items(self) -> None:
        block = memory_block([SEEDED, REAL])
        self.assertIn("- [demo seed] Daily discharge for Altenahr", block)
        self.assertIn("- Paiporta finding", block)


if __name__ == "__main__":
    unittest.main()
