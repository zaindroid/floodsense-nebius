"""Similar-question cache with Token Factory embeddings. Mocked transport, no network."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import httpx  # noqa: E402

from app.cache import AnswerCache, CacheSettings  # noqa: E402
from app.embed import Embedder, cosine  # noqa: E402

VECS = {
    "which sites are exposed?": [1.0, 0.0, 0.0],
    "what places are at risk?": [0.97, 0.1, 0.0],  # reworded: cosine ~0.995
    "how deep is the river?": [0.0, 1.0, 0.0],  # unrelated
}


def embedder(calls: list, statuses=None) -> Embedder:
    statuses = list(statuses or [])

    def handler(req: httpx.Request) -> httpx.Response:
        sent = json.loads(req.content)
        calls.append((str(req.url), req.headers["authorization"], sent))
        if statuses:
            st = statuses.pop(0)
            if st != 200:
                return httpx.Response(st, headers={"retry-after": "1"} if st == 429 else {})
        vec = VECS[sent["input"][0].lower()]
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": vec}]})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    return Embedder("nebius", client, sleep=lambda s: None)


def run(question: str) -> dict:
    return {
        "run_id": "r1",
        "status": "approved",
        "approval": {"status": "approved"},
        "judge_summary": {"passes": True},
        "request": {"question": question, "event_id": "EMSR773", "customer_id": "demo-insurer"},
    }


@mock.patch.dict(os.environ, {"NEBIUS_API_KEY": "k-test"})
class EmbedCacheTest(unittest.TestCase):
    def cache(self, calls, **kw) -> AnswerCache:
        return AnswerCache(CacheSettings(), embedder=embedder(calls, **kw))

    def test_reworded_repeat_hits_and_unrelated_misses(self) -> None:
        calls: list = []
        c = self.cache(calls)
        self.assertTrue(c.remember(run("Which sites are exposed?"), "f"))
        hit = c.lookup({"question": "What places are at risk?"}, "f")
        self.assertEqual(hit.run_id, "r1")
        self.assertIsNone(c.lookup({"question": "How deep is the river?"}, "f"))
        url, auth, body = calls[0]
        self.assertEqual(url, "https://api.tokenfactory.nebius.com/v1/embeddings")
        self.assertEqual(auth, "Bearer k-test")
        self.assertEqual(body["model"], "Qwen/Qwen3-Embedding-8B")

    def test_other_event_never_matches(self) -> None:
        c = self.cache([])
        c.remember(run("Which sites are exposed?"), "f")
        self.assertIsNone(
            c.lookup({"question": "What places are at risk?", "event_id": "EMSR517"}, "f")
        )

    def test_slow_path_retries_a_429_then_succeeds(self) -> None:
        calls: list = []
        e = embedder(calls, statuses=[429])
        self.assertEqual(e.embed("Which sites are exposed?"), VECS["which sites are exposed?"])
        self.assertEqual(len(calls), 2)

    def test_failure_falls_back_to_exact_match(self) -> None:
        c = self.cache([], statuses=[500])
        c.remember(run("Which sites are exposed?"), "f")
        self.assertIsNone(c.lookup({"question": "What places are at risk?"}, "f"))
        self.assertIsNotNone(c.lookup({"question": "which sites are exposed"}, "f"))

    def test_other_dimension_never_matches(self) -> None:
        self.assertEqual(cosine([1.0, 0.0], [1.0, 0.0, 0.0]), 0.0)

    def _at(self, cos: float, **kw) -> AnswerCache:
        # Embedder.threshold is 0.90 by default; vectors are unit, so cosine == cos.
        VECS["q-new"] = [cos, (1 - cos * cos) ** 0.5, 0.0]
        VECS["q-old"] = [1.0, 0.0, 0.0]
        c = self.cache([], **kw)
        c.remember(run("q-old"), "f")
        return c

    def test_threshold_edge(self) -> None:
        self.assertIsNone(self._at(0.89).lookup({"question": "q-new"}, "f"))
        self.assertIsNotNone(self._at(0.91).lookup({"question": "q-new"}, "f"))

    def test_scope_mismatch_never_matches(self) -> None:
        c = self._at(0.99)
        for extra in ({"lang": "de"}, {"customer_id": "other"}, {"replay_ts": "2024-10-29T10:00:00Z"}):
            self.assertIsNone(c.lookup({"question": "q-new", **extra}, "f"), extra)
        self.assertIsNone(c.lookup({"question": "q-new"}, "other-flags"))

    def test_expired_entry_is_a_miss(self) -> None:
        c = self._at(0.99)
        with mock.patch("app.cache.time.time", return_value=10**10):
            self.assertIsNone(c.lookup({"question": "q-new"}, "f"))

    def test_vectors_are_pruned_with_evicted_entries(self) -> None:
        c = AnswerCache(CacheSettings(max_entries=1), embedder=embedder([]))
        c.remember(run("Which sites are exposed?"), "f")
        c.remember(run("How deep is the river?"), "f")
        self.assertEqual(len(c._vectors), 1)

    def test_guard_blocks_negation_number_place_and_antonym(self) -> None:
        from app.embed import guard_key

        pairs = [
            ("Which sites are flooded?", "Which sites are not flooded?"),
            ("Sites within 5 km of the river?", "Sites within 10 km of the river?"),
            ("Sites flooded in Valencia?", "Sites flooded in Ahr?"),
            ("Is the Ahr above the level?", "Is the Ahr below the level?"),
            ("Wie viele sind betroffen?", "Wie viele sind nicht betroffen?"),
        ]
        pairs += [
            ("Which sites are within five km of the river?", "Which sites are within ten km of the river?"),
            ("Wie viele Standorte innerhalb fünf km?", "Wie viele Standorte innerhalb zehn km?"),
            ("Sites within 5 km?", "Sites within 5 miles?"),
            ("Valencia: which sites are flooded?", "Ahr: which sites are flooded?"),
            ("Valencia flooded?", "Ahr flooded?"),
            ("sites flooded in valencia?", "sites flooded in ahr?"),
            ("Which sites are flooded?", "Which sites aren't flooded?"),
            ("Which sites are flooded?", "Which sites are non-flooded?"),
            ("Is any site safe?", "Is any site unsafe?"),
            ("Sites inside the zone?", "Sites outside the zone?"),
            ("Wie viele sind betroffen?", "Wie viele sind kaum betroffen?"),
            ("Sites at least 5 m?", "Sites at most 5 m?"),
            ("Is any site flooded?", "Is no site flooded?"),
        ]
        for a, b in pairs:
            self.assertNotEqual(guard_key(a), guard_key(b), (a, b))
        self.assertEqual(guard_key("Which sites are exposed?"), guard_key("Which sites are at risk?"))
        self.assertEqual(guard_key("Which sites are exposed?"), guard_key("Which of the sites are exposed?"))

    def test_guard_stops_a_high_scoring_near_miss_in_the_cache(self) -> None:
        VECS["sites not flooded?"] = [0.99, 0.1, 0.0]
        VECS["sites flooded?"] = [1.0, 0.0, 0.0]
        c = self.cache([])
        c.remember(run("Sites flooded?"), "f")
        self.assertIsNone(c.lookup({"question": "Sites not flooded?"}, "f"))

    def test_lookup_path_makes_one_short_attempt(self) -> None:
        calls: list = []
        c = self.cache(calls, statuses=[429, 200])
        self.assertIsNone(c._embedder.embed("Which sites are exposed?", fast=True))
        self.assertEqual(len(calls), 1)
        first = c._embedder._client
        c._embedder.embed("Which sites are exposed?", fast=True)
        self.assertIs(c._embedder._client, first)  # one client, reused
        c.close()
        self.assertIsNone(c._embedder._client)

    def test_bad_env_values_do_not_crash(self) -> None:
        with mock.patch.dict(os.environ, {"EMBED_CACHE_THRESHOLD": "x", "NIGHTSHIFT_RPM": "y"}):
            self.assertEqual(Embedder("nim").threshold, 0.90)

    def test_default_backend_is_off_and_makes_no_call(self) -> None:
        calls: list = []
        e = embedder(calls)
        e.backend = "nim"
        c = AnswerCache(CacheSettings(), embedder=e)
        c.remember(run("Which sites are exposed?"), "f")
        self.assertIsNone(c.lookup({"question": "What places are at risk?"}, "f"))
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
