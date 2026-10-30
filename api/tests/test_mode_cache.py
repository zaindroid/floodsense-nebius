"""A live-mode answer is never served for an event question, nor the other way round."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.cache import (  # noqa: E402
    CacheSettings,
    AnswerCache,
    ask_of,
    key_of,
    mode_of,
    past_row_matches,
    same_ask,
)

LIVE_Q = {"question": "Is any Valencia point at risk in the next 48 hours?", "event_id": "EMSR773"}
EVENT_Q = {"question": "Why are our Valencia sites at risk?", "event_id": "EMSR773"}


class ModeCacheTest(unittest.TestCase):
    def test_mode_resolution_matches_the_agents(self) -> None:
        self.assertEqual(mode_of(LIVE_Q), "live")
        self.assertEqual(mode_of(EVENT_Q), "event")
        self.assertEqual(mode_of({**EVENT_Q, "mode": "live"}), "live")
        self.assertEqual(mode_of({**LIVE_Q, "mode": "event"}), "event")
        self.assertEqual(mode_of({**LIVE_Q, "replay_ts": "2024-10-29T16:00:00Z"}), "event")
        self.assertEqual(mode_of({"question": "¿Qué pasa mañana?"}), "live")
        self.assertEqual(mode_of({"question": "Wie ist die Vorhersage für morgen?"}), "live")
        run = {"request": dict(EVENT_Q), "mode": {"mode": "live", "reason": "x"}}
        self.assertEqual(mode_of(run), "live")

    def test_same_question_different_mode_gets_a_different_key(self) -> None:
        self.assertNotEqual(key_of(EVENT_Q, "f"), key_of({**EVENT_Q, "mode": "live"}, "f"))
        self.assertEqual(key_of(LIVE_Q, "f"), key_of({**LIVE_Q, "mode": "live"}, "f"))
        self.assertNotEqual(ask_of(LIVE_Q), ask_of({**LIVE_Q, "mode": "event"}))

    def test_replay_does_not_cross_modes(self) -> None:
        live_run = {"request": {**EVENT_Q, "mode": "live"}, "mode": {"mode": "live"}}
        self.assertFalse(same_ask(EVENT_Q, live_run))
        self.assertTrue(same_ask({**EVENT_Q, "mode": "live"}, live_run))
        row = {
            "run_id": "r1",
            "status": "approved",
            "approval": "approved",
            "event_id": "EMSR773",
            "question": EVENT_Q["question"],
            "mode": "live",
        }
        self.assertFalse(past_row_matches(EVENT_Q, row))
        self.assertTrue(past_row_matches({**EVENT_Q, "mode": "live"}, row))

    def test_a_run_recorded_before_live_mode_is_event(self) -> None:
        old_run = {"run_id": "r0", "request": dict(LIVE_Q), "event_id": "EMSR773"}
        self.assertFalse(same_ask(LIVE_Q, old_run))
        self.assertTrue(same_ask({**LIVE_Q, "mode": "event"}, old_run))
        row = {
            "run_id": "r0",
            "status": "approved",
            "approval": "approved",
            "event_id": "EMSR773",
            "question": LIVE_Q["question"],
        }
        self.assertFalse(past_row_matches(LIVE_Q, row))

    def test_live_mode_gets_the_short_ttl(self) -> None:
        cache = AnswerCache(CacheSettings(ttl_live_s=60, ttl_replay_s=86400))
        self.assertEqual(cache.ttl_for(LIVE_Q, "FF_LIVE_DATA=False"), 60)
        self.assertEqual(cache.ttl_for(EVENT_Q, "FF_LIVE_DATA=False"), 86400)


if __name__ == "__main__":
    unittest.main()
