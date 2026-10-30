"""A trace entry names the backend that served its model.

A Nemotron id answers on Nightshift and on Nebius Token Factory alike, so the
UI cannot tell them apart from the id. The trace says which, or the console
labels a Token Factory run "via Nightshift".
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import trace  # noqa: E402

STATE = {"run_id": "r1", "trace": []}


class TraceProvider(unittest.TestCase):
    def test_a_model_step_names_the_backend(self) -> None:
        for backend in ("nightshift", "nebius"):
            with mock.patch.object(settings, "llm_backend", backend):
                [ev] = trace(STATE, "judge", "PASS", lane="deep", model_id="nvidia/Nemotron-3.5-Super-VL")
            self.assertEqual(ev["provider"], backend)

    def test_a_step_without_a_model_names_none(self) -> None:
        with mock.patch.object(settings, "llm_backend", "nebius"):
            sql = trace(STATE, "watchers", "3 anomalies", lane="sql")[0]
            rules = trace(STATE, "investigator", "chain", model_id="deterministic")[0]
        self.assertIsNone(sql["provider"])
        self.assertIsNone(rules["provider"])


if __name__ == "__main__":
    unittest.main()
