"""Semantic cache and labelled replay in the API (app/cache.py, app/main.py).

Two kinds of test. The cache rules and the API flow run against a small fake
agents service, so a test decides what the Judge said and when the agents
fail. The replay route runs on the real agents app in-process, as in
test_proxy.py. No network.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "agents"))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import cache as cache_mod  # noqa: E402
from app import main as api  # noqa: E402
from app.ratelimit import RateLimiter, RateLimitSettings  # noqa: E402
from app.cache import (  # noqa: E402
    AnswerCache,
    CacheSettings,
    annotate_replay,
    canonical_event,
    describe,
    finished_well,
    fingerprint,
    fold,
    is_follow_up,
    key_of,
    mark_cached,
    normalize_utc,
    past_row_matches,
    same_ask,
)

try:
    from floodsense_agents import __main__ as agents_service  # noqa: E402
except ImportError:  # the agents requirements are not installed here
    agents_service = None

CONFIG = {
    "flags": {"FF_LIVE_DATA": False, "FF_JUDGE": True, "FF_HITL": True},
    "lanes": {"fast": "meterless/fast", "deep": "meterless/deep"},
    "schema": "floodsense_seed",
}


def settings(**kw) -> CacheSettings:
    base = dict(
        semantic_cache=True,
        cached_replay=True,
        ttl_live_s=900,
        ttl_replay_s=86400,
        max_entries=256,
        max_recordings=8,
        lookup_timeout_s=3,
    )
    base.update(kw)
    return CacheSettings(**base)


def _recording(run_id: str, event_id: str, question: str) -> dict:
    return {
        "run_id": run_id,
        "event_id": event_id,
        "customer_id": "demo-insurer",
        "request": {"question": question, "lang": "en"},
    }


def run(run_id="r1", question="Which sites are exposed?", **kw) -> dict:
    out = {
        "run_id": run_id,
        "thread_id": run_id,
        "status": "approved",
        "approval": {"status": "approved"},
        "judge_summary": {"passes": True},
        "request": {"question": question, "event_id": "EMSR773", "customer_id": "demo-insurer"},
    }
    out.update(kw)
    return out


class FoldAndKeyTest(unittest.TestCase):
    def test_case_punctuation_and_spacing_fold_away(self) -> None:
        self.assertEqual(fold("Which  sites are EXPOSED?"), fold("which sites, are exposed"))

    def test_left_out_defaults_key_like_spelled_out_ones(self) -> None:
        bare = {"question": "q"}
        full = {"question": "q", "event_id": "EMSR773", "customer_id": "demo-insurer", "lang": "en"}
        self.assertEqual(key_of(bare, "f"), key_of(full, "f"))

    def test_event_replay_clock_and_flags_are_part_of_the_key(self) -> None:
        q = {"question": "q"}
        self.assertNotEqual(key_of(q, "f"), key_of({**q, "event_id": "EMSR517"}, "f"))
        self.assertNotEqual(key_of(q, "f"), key_of({**q, "replay_ts": "2024-10-29T16:00:00Z"}, "f"))
        self.assertNotEqual(key_of(q, "f"), key_of(q, "g"))

    def test_a_routed_german_run_replays_for_the_same_ask(self) -> None:
        from app.cache import same_ask

        ask = {"question": "How high is the Rhine at Köln right now?", "mode": "live"}
        run = {
            "event_id": "EMSR517",
            "mode": {"mode": "live"},
            "request": {**ask, "event_id": None},
        }
        self.assertTrue(same_ask(ask, run))
        self.assertFalse(same_ask({**ask, "event_id": "EMSR517"}, run))

    def test_context_is_part_of_the_key_so_places_do_not_cross(self) -> None:
        q = {"question": "level now?", "context": {"station": "BONN"}}
        self.assertNotEqual(key_of(q, "f"), key_of({**q, "context": {"station": "KÖLN"}}, "f"))
        self.assertNotEqual(key_of(q, "f"), key_of({"question": "level now?"}, "f"))
        self.assertEqual(key_of({"question": "q", "context": {}}, "f"), key_of({"question": "q"}, "f"))

    def test_zone_less_and_short_clocks_share_the_canonical_key(self) -> None:
        canonical = {"question": "q", "replay_ts": "2024-10-29T16:00:00Z"}
        forms = (
            "2024-10-29T16:00:00Z",
            "2024-10-29T16:00Z",
            "2024-10-29T16:00:00",
            "2024-10-29 16:00:00Z",
            "2024-10-29 16:00",
        )
        for raw in forms:
            self.assertEqual(key_of(canonical, "f"), key_of({"question": "q", "replay_ts": raw}, "f"), raw)


class QualifyTest(unittest.TestCase):
    def test_only_a_person_approved_and_judge_passed_run_qualifies(self) -> None:
        self.assertTrue(finished_well(run()))
        self.assertTrue(finished_well(run(approval={"status": "edited"})))
        self.assertFalse(finished_well(run(approval={"status": "auto"})))
        self.assertFalse(finished_well(run(status="rejected", approval={"status": "rejected"})))
        self.assertFalse(finished_well(run(judge_summary={"passes": False})))
        self.assertFalse(finished_well(run(judge_summary=None)))

    def test_a_follow_up_is_recognised(self) -> None:
        self.assertFalse(is_follow_up(run()))
        self.assertTrue(is_follow_up(run(thread_id="r0")))
        self.assertTrue(is_follow_up(run(request={"question": "q", "thread_id": "r0"})))


class AnswerCacheTest(unittest.TestCase):
    def test_a_finished_run_is_found_again(self) -> None:
        c = AnswerCache(settings())
        self.assertTrue(c.remember(run(), "f"))
        hit = c.lookup({"question": "which sites are exposed"}, "f")
        self.assertEqual(hit.run_id, "r1")

    def test_follow_ups_are_never_cached_or_served(self) -> None:
        c = AnswerCache(settings())
        self.assertFalse(c.remember(run(thread_id="r0"), "f"))
        c.remember(run(), "f")
        self.assertIsNone(
            c.lookup({"question": "Which sites are exposed?", "thread_id": "r1"}, "f")
        )

    def test_live_data_expires_sooner_than_a_historical_replay(self) -> None:
        c = AnswerCache(settings(ttl_live_s=10, ttl_replay_s=1000))
        live = "FF_LIVE_DATA=True;schema=floodsense"
        self.assertEqual(c.ttl_for({"question": "q"}, live), 10)
        self.assertEqual(
            c.ttl_for({"question": "q", "replay_ts": "2024-10-29T16:00:00Z"}, live), 1000
        )
        self.assertEqual(c.ttl_for({"question": "q"}, "FF_LIVE_DATA=False"), 1000)

    def test_an_expired_entry_is_a_miss(self) -> None:
        c = AnswerCache(settings(ttl_replay_s=60))
        with mock.patch.object(cache_mod.time, "time", return_value=1000.0):
            c.remember(run(), "f")
        with mock.patch.object(cache_mod.time, "time", return_value=1059.0):
            self.assertIsNotNone(c.lookup({"question": "Which sites are exposed?"}, "f"))
        with mock.patch.object(cache_mod.time, "time", return_value=1061.0):
            self.assertIsNone(c.lookup({"question": "Which sites are exposed?"}, "f"))

    def test_the_oldest_entry_goes_first_when_full(self) -> None:
        c = AnswerCache(settings(max_entries=2))
        for i in range(3):
            c.remember(run(f"r{i}", question=f"q{i}"), "f")
        self.assertIsNone(c.lookup({"question": "q0"}, "f"))
        self.assertEqual(c.lookup({"question": "q2"}, "f").run_id, "r2")

    def test_drop_forgets_a_run(self) -> None:
        c = AnswerCache(settings())
        c.remember(run(), "f")
        c.drop("r1")
        self.assertIsNone(c.lookup({"question": "Which sites are exposed?"}, "f"))

    def test_lookup_normalises_the_replay_clock_the_way_remember_does(self) -> None:
        c = AnswerCache(settings())
        stored = run(
            request={
                "question": "Which sites are exposed?",
                "event_id": "EMSR773",
                "customer_id": "demo-insurer",
                "lang": "en",
                "replay_ts": "2024-10-29T16:00:00Z",
            }
        )
        self.assertTrue(c.remember(stored, "f"))
        for raw in ("2024-10-29T16:00Z", "2024-10-29T16:00:00", "2024-10-29 16:00:00Z"):
            hit = c.lookup({"question": "Which sites are exposed?", "replay_ts": raw}, "f")
            self.assertIsNotNone(hit, raw)
            self.assertEqual(hit.run_id, "r1")
        short = run(
            run_id="r2",
            request={
                "question": "Other?",
                "replay_ts": "2024-10-29T18:00Z",
                "lang": "en",
            },
        )
        self.assertTrue(c.remember(short, "f"))
        hit = c.lookup({"question": "Other?", "replay_ts": "2024-10-29T18:00:00Z"}, "f")
        self.assertEqual(hit.run_id, "r2")

    def test_recordings_keep_one_slot_per_question(self) -> None:
        c = AnswerCache(settings(max_recordings=1))
        c.record(_recording("a", "EMSR773", "q"))
        c.record(_recording("b", "EMSR517", "q"))
        self.assertIsNone(c.recording_for({"question": "q", "event_id": "EMSR773"}))
        self.assertEqual(c.recording_for({"question": "q", "event_id": "EMSR517"})["run_id"], "b")

    def test_a_recording_is_not_served_for_a_different_question(self) -> None:
        c = AnswerCache(settings())
        c.record(_recording("a", "EMSR773", "Which sites are exposed?"))
        self.assertIsNone(c.recording_for({"question": "Something new?", "event_id": "EMSR773"}))
        self.assertEqual(c.recording_for({"question": "which sites are exposed"})["run_id"], "a")

    def test_an_event_alias_finds_the_canonical_recording(self) -> None:
        c = AnswerCache(settings())
        c.record(_recording("a", "EMSR773", "q"))
        found = c.recording_for({"question": "q", "event_id": "valencia_2024"})
        self.assertEqual(found["run_id"], "a")
        self.assertEqual(canonical_event("ahr_2021"), "EMSR517")

    def test_flags_are_read_through_the_cache(self) -> None:
        c = AnswerCache(settings())
        self.assertIsNone(c.cached_flags())
        self.assertEqual(c.flags(lambda: CONFIG), fingerprint(CONFIG))
        self.assertEqual(c.cached_flags(), fingerprint(CONFIG))
        c.forget_flags()
        self.assertIsNone(c.cached_flags())

    def test_lookup_timeout_comes_from_the_environment(self) -> None:
        with mock.patch.dict(os.environ, {"CACHE_LOOKUP_TIMEOUT_S": "1.5"}, clear=False):
            got = CacheSettings()
        self.assertEqual(got.lookup_timeout_s, 1.5)
        self.assertFalse(got.semantic_cache)
        self.assertFalse(got.cached_replay)


class LabelTest(unittest.TestCase):
    def test_a_clocked_replay_body_is_relabelled_as_cache(self) -> None:
        clock = "2024-10-29T16:00:00Z"
        body = mark_cached(
            {
                "run_id": "r1",
                "served_from": "replay",
                "cached_at": clock,
                "replay_ts": clock,
                "label": {
                    "live": False,
                    "kind": "replay",
                    "text": "Replay of a recorded run from 16:00 · not live · original run r1",
                },
            }
        )
        self.assertEqual(body["served_from"], "cache")
        self.assertFalse(body["label"]["live"])
        self.assertEqual(body["label"]["kind"], "cache")
        self.assertTrue(body["label"]["text"].startswith("Cached answer from 16:00"))
        self.assertIn("not live", body["label"]["text"])
        self.assertIn("original run r1", body["label"]["text"])
        self.assertNotIn("Replay of a recorded run", body["label"]["text"])
        self.assertEqual(body["cached_at"], clock)
        self.assertEqual(body["replay_ts"], clock)

    def test_the_banner_matches_the_agents_wording(self) -> None:
        if agents_service is None:
            self.skipTest("agents package not importable")
        from floodsense_agents.labelling import label

        at = "2024-10-29T16:00:00Z"
        self.assertEqual(describe("cache", at, "r1"), label("cache", at, "r1"))
        self.assertEqual(describe("replay", at, "r1"), label("replay", at, "r1"))

    def test_the_replay_block_names_the_question_the_clock_and_the_failed_run(self) -> None:
        body = annotate_replay(
            {
                "run_id": "r1",
                "cached_at": "2026-10-25T14:32:00Z",
                "replay_ts": "2024-10-29T16:00:00Z",
                "request": {"question": "Which sites are exposed?"},
            },
            "the live run failed",
            failed_run_id="r9",
        )
        self.assertEqual(body["served_from"], "replay")
        self.assertFalse(body["label"]["live"])
        self.assertTrue(body["label"]["text"].startswith("Replay of a recorded run from 14:32"))
        self.assertIn("Which sites are exposed?", body["label"]["text"])
        self.assertEqual(body["replay"]["question"], "Which sites are exposed?")
        self.assertEqual(body["replay"]["replay_ts"], "2024-10-29T16:00:00Z")
        self.assertEqual(body["replay"]["failed_run_id"], "r9")
        self.assertEqual(body["cached_at"], "2026-10-25T14:32:00Z")
        self.assertEqual(body["replay_ts"], "2024-10-29T16:00:00Z")


class ReplayMatchTest(unittest.TestCase):
    def _row(self, **kw) -> dict:
        row = {
            "run_id": "r1",
            "thread_id": "r1",
            "status": "approved",
            "approval": "approved",
            "event_id": "EMSR773",
            "customer_id": "demo-insurer",
            "question": "Which sites are exposed?",
            "replay_ts": None,
        }
        row.update(kw)
        return row

    def test_an_alias_matches_the_canonical_event_and_a_different_question_does_not(self) -> None:
        row = self._row()
        self.assertTrue(past_row_matches({"question": "which sites are exposed"}, row))
        self.assertTrue(
            past_row_matches(
                {"question": "Which sites are exposed?", "event_id": "valencia_2024"}, row
            )
        )
        self.assertFalse(past_row_matches({"question": "Something new?"}, row))
        self.assertFalse(
            past_row_matches(
                {"question": "Which sites are exposed?"}, self._row(thread_id="older")
            )
        )

    def test_clock_and_language_must_match_the_recorded_run(self) -> None:
        recorded = {
            "run_id": "r1",
            "event_id": "EMSR773",
            "customer_id": "demo-insurer",
            "replay_ts": "2024-10-29T16:00:00Z",
            "request": {
                "question": "Which sites are exposed?",
                "lang": "en",
                "replay_ts": "2024-10-29T16:00:00Z",
            },
        }
        self.assertTrue(
            same_ask(
                {"question": "Which sites are exposed?", "replay_ts": "2024-10-29T16:00Z"},
                recorded,
            )
        )
        self.assertFalse(
            same_ask(
                {"question": "Which sites are exposed?", "replay_ts": "2024-10-29T18:00:00Z"},
                recorded,
            )
        )
        self.assertFalse(same_ask({"question": "Which sites are exposed?", "lang": "es"}, recorded))
        self.assertFalse(same_ask({"question": "Something new?"}, recorded))


# Enough of a run for project_run to attach a contract. The judge is omitted
# so a fake model id cannot drop the projection.
_PROJECTABLE = {
    "claims": [
        {
            "claim_id": "C1",
            "text": "Seven policies sit in the footprint.",
            "citations": [
                {
                    "citation_id": "C1-b1",
                    "claim_id": "C1",
                    "layer": "b",
                    "source_url": "https://example.com/data",
                    "title": "discharge",
                    "publisher": "Open-Meteo",
                    "accessed_at": "2024-10-29T12:00:00Z",
                    "licence": "CC BY 4.0",
                    "attribution": "Open-Meteo",
                }
            ],
        }
    ],
    "evidence": [
        {
            "query_id": "q-ok",
            "view": "floodsense_seed.discharge_daily",
            "sql": "SELECT 1",
            "rows_sample": [{"v": 1}],
            "row_count": 1,
            "executed_at_utc": "2024-10-29T12:00:00Z",
        }
    ],
}


class FakeAgents:
    """The agents' run routes in miniature. A test sets judge_passes, config and failures.

    GET /runs/{id} follows the agents: a clocked run stays replay, with a real
    replay banner. It does not stamp every read served_from cache.
    """

    def __init__(self) -> None:
        self.runs: dict[str, dict] = {}
        self.config = dict(CONFIG)
        self.judge_passes = True
        self.down = False
        self.post_status = 201
        self.fail_runs = False
        self.past_error: BaseException | None = None
        self.started = 0
        self.calls: list[tuple] = []
        self.last_get: dict | None = None

    def __call__(self, method, path, body=None, params=None, timeout=None):
        self.calls.append((method, path, timeout))
        if self.down:
            raise httpx.ConnectError("connection refused")
        payload = body
        if path == "/config":
            return httpx.Response(200, json=self.config)
        if method == "POST" and path == "/runs":
            if self.post_status >= 500:
                return httpx.Response(self.post_status, json={"detail": "boom"})
            self.started += 1
            rid = f"run{self.started}"
            request = dict(payload or {})
            request.setdefault("lang", "en")
            if request.get("replay_ts"):
                request["replay_ts"] = normalize_utc(request["replay_ts"])
            stored = {
                "run_id": rid,
                "thread_id": request.get("thread_id") or rid,
                "event_id": request.get("event_id") or "EMSR773",
                "customer_id": request.get("customer_id") or "demo-insurer",
                "replay_ts": request.get("replay_ts"),
                "request": request,
                "status": "failed" if self.fail_runs else "awaiting_approval",
                "error": "Nightshift unreachable" if self.fail_runs else None,
                "approval": {"status": "awaiting"},
                "judge_summary": {"passes": self.judge_passes},
                "created_at": f"2026-10-25T14:3{self.started}:00Z",
                "served_from": "live",
                "cached_at": None,
                **_PROJECTABLE,
            }
            self.runs[rid] = stored
            return httpx.Response(201, json=stored)
        if method == "POST" and path.endswith("/approval"):
            rid = path.split("/")[2]
            action = (payload or {}).get("action")
            r = self.runs[rid]
            r["status"] = "rejected" if action == "reject" else "approved"
            r["approval"] = {
                "status": {"approve": "approved", "edit": "edited"}.get(action, "rejected")
            }
            return httpx.Response(200, json=r)
        if path == "/runs/past":
            if self.past_error is not None:
                raise self.past_error
            rows = [
                {
                    "run_id": r["run_id"],
                    "thread_id": r["thread_id"],
                    "event_id": r["event_id"],
                    "customer_id": r["customer_id"],
                    "question": r["request"].get("question"),
                    "replay_ts": r.get("replay_ts"),
                    "lang": r["request"].get("lang") or "en",
                    "status": r["status"],
                    "approval": r["approval"]["status"],
                }
                for r in reversed(list(self.runs.values()))
            ]
            return httpx.Response(200, json={"runs": rows})
        if path.startswith("/runs/") and path.endswith("/replay"):
            rid = path.split("/")[2]
            r = self.runs.get(rid)
            if r is None:
                return httpx.Response(404, json={"detail": "not found"})
            return httpx.Response(200, json=self._labelled(r, "replay", r["created_at"]))
        if path.startswith("/runs/"):
            rid = path.split("/")[2]
            r = self.runs.get(rid)
            if r is None:
                return httpx.Response(404, json={"detail": "not found"})
            if r.get("replay_ts"):
                labelled = self._labelled(r, "replay", r["replay_ts"])
            else:
                labelled = self._labelled(r, "cache", r["created_at"])
            self.last_get = labelled
            return httpx.Response(200, json=labelled)
        return httpx.Response(404, json={"detail": f"no route {method} {path}"})

    @staticmethod
    def _labelled(run: dict, kind: str, at: str | None) -> dict:
        body = {**run, "served_from": kind, "cached_at": at}
        body["label"] = describe(kind, at, run["run_id"])
        return body


class ApiFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.agents = FakeAgents()
        self._patches = [
            mock.patch.object(api, "_agents_request", side_effect=self.agents),
            mock.patch.object(api, "cache", AnswerCache(settings())),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)
        # These tests exercise the cache and proxy, not the rate limits.
        unlimited = RateLimiter(RateLimitSettings(runs_per_min=0, max_concurrent_runs=0))
        limits = mock.patch.object(api, "limiter", unlimited)
        limits.start()
        self.addCleanup(limits.stop)
        self.c = TestClient(api.app)

    def finished(self, question="Which sites are exposed?", action="approve", **extra) -> dict:
        r = self.c.post("/runs", json={"question": question, **extra})
        self.assertEqual(r.status_code, 201)
        rid = r.json()["run_id"]
        self.c.post(f"/runs/{rid}/approval", json={"action": action, "reviewer": "ayush"})
        return r.json()

    def test_a_repeat_of_a_finished_question_is_served_from_the_cache(self) -> None:
        first = self.finished()
        r = self.c.post("/runs", json={"question": "which sites are EXPOSED"})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["served_from"], "cache")
        self.assertFalse(body["label"]["live"])
        self.assertTrue(body["label"]["text"].startswith("Cached answer from 14:31"))
        self.assertIn("not live", body["label"]["text"])
        self.assertEqual(body["cache"]["original_run_id"], first["run_id"])
        self.assertEqual(body["cached_at"], first["created_at"])
        self.assertEqual(body["contract"]["answer"]["served_from"], "cache")
        self.assertEqual(self.agents.started, 1)

    def test_a_clocked_cache_hit_is_labelled_cache_and_keeps_the_clock(self) -> None:
        clock = "2024-10-29T16:00:00Z"
        first = self.finished(replay_ts=clock)
        r = self.c.post(
            "/runs",
            json={"question": "Which sites are exposed?", "replay_ts": "2024-10-29T16:00Z"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(self.agents.last_get["served_from"], "replay")
        self.assertIn("Replay of a recorded run", self.agents.last_get["label"]["text"])
        self.assertEqual(body["served_from"], "cache")
        self.assertFalse(body["label"]["live"])
        self.assertEqual(body["label"]["kind"], "cache")
        self.assertTrue(body["label"]["text"].startswith("Cached answer from 16:00"))
        self.assertIn("not live", body["label"]["text"])
        self.assertIn(f"original run {first['run_id']}", body["label"]["text"])
        self.assertNotIn("Replay of a recorded run", body["label"]["text"])
        self.assertEqual(body["cached_at"], clock)
        self.assertEqual(body["replay_ts"], clock)
        self.assertEqual(body["contract"]["answer"]["served_from"], "cache")
        self.assertEqual(body["contract"]["answer"]["cached_at"], clock)
        self.assertEqual(body["cache"]["original_run_id"], first["run_id"])
        self.assertEqual(self.agents.started, 1)

    def test_fresh_skips_the_cache(self) -> None:
        self.finished()
        r = self.c.post("/runs", json={"question": "Which sites are exposed?", "fresh": True})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["served_from"], "live")
        self.assertNotIn("fresh", r.json()["request"])
        self.assertEqual(self.agents.started, 2)

    def test_a_run_the_judge_did_not_pass_is_not_cached(self) -> None:
        self.agents.judge_passes = False
        self.finished()
        self.assertEqual(
            self.c.post("/runs", json={"question": "Which sites are exposed?"}).status_code, 201
        )

    def test_a_rejected_run_is_not_cached(self) -> None:
        self.finished(action="reject")
        self.assertEqual(
            self.c.post("/runs", json={"question": "Which sites are exposed?"}).status_code, 201
        )

    def test_a_follow_up_is_never_served_from_the_cache(self) -> None:
        first = self.finished()
        r = self.c.post(
            "/runs", json={"question": "Which sites are exposed?", "thread_id": first["run_id"]}
        )
        self.assertEqual(r.status_code, 201)

    def test_a_change_of_agents_flags_is_a_miss(self) -> None:
        self.finished()
        self.agents.config = {**CONFIG, "flags": {**CONFIG["flags"], "FF_LIVE_DATA": True}}
        api.cache.forget_flags()
        self.assertEqual(
            self.c.post("/runs", json={"question": "Which sites are exposed?"}).status_code, 201
        )

    def test_the_cache_is_off_without_its_flag(self) -> None:
        api.cache.settings.semantic_cache = False
        self.finished()
        self.assertEqual(
            self.c.post("/runs", json={"question": "Which sites are exposed?"}).status_code, 201
        )

    def test_agents_down_serves_the_recording_of_the_same_question(self) -> None:
        first = self.finished()
        api.cache.settings.semantic_cache = False
        self.agents.calls.clear()
        self.agents.down = True
        r = self.c.post("/runs", json={"question": "which sites are EXPOSED?"})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["served_from"], "replay")
        self.assertFalse(body["label"]["live"])
        self.assertTrue(body["label"]["text"].startswith("Replay of a recorded run from"))
        self.assertIn("Which sites are exposed?", body["label"]["text"])
        self.assertEqual(body["replay"]["original_run_id"], first["run_id"])
        self.assertEqual(body["replay"]["question"], "Which sites are exposed?")
        self.assertIsNone(body["replay"]["replay_ts"])
        self.assertNotIn("failed_run_id", body["replay"])
        self.assertIn("could not be reached", body["replay"]["reason"])
        self.assertEqual(body["contract"]["answer"]["served_from"], "replay")
        past = [path for _method, path, _timeout in self.agents.calls if path == "/runs/past"]
        self.assertEqual(past, [])

    def test_a_different_question_is_not_replayed(self) -> None:
        self.finished()
        api.cache.settings.semantic_cache = False
        self.agents.down = True
        self.assertEqual(self.c.post("/runs", json={"question": "Something new?"}).status_code, 503)
        self.agents.down = False
        self.agents.post_status = 500
        self.assertEqual(self.c.post("/runs", json={"question": "Something new?"}).status_code, 500)

    def test_a_5xx_from_the_agents_serves_a_recorded_run(self) -> None:
        first = self.finished()
        api.cache.settings.semantic_cache = False
        self.agents.post_status = 500
        body = self.c.post("/runs", json={"question": "Which sites are exposed?"}).json()
        self.assertEqual(body["served_from"], "replay")
        self.assertEqual(body["replay"]["original_run_id"], first["run_id"])
        self.assertIn("HTTP 500", body["replay"]["reason"])
        self.assertNotIn("failed_run_id", body["replay"])

    def test_a_failed_live_run_serves_a_recorded_run(self) -> None:
        first = self.finished()
        api.cache.settings.semantic_cache = False
        self.agents.fail_runs = True
        body = self.c.post("/runs", json={"question": "Which sites are exposed?"}).json()
        self.assertEqual(body["served_from"], "replay")
        self.assertEqual(body["replay"]["original_run_id"], first["run_id"])
        self.assertEqual(body["replay"]["failed_run_id"], f"run{self.agents.started}")
        self.assertNotEqual(body["replay"]["failed_run_id"], first["run_id"])
        self.assertIn("Nightshift unreachable", body["replay"]["reason"])

    def test_a_different_clock_or_language_is_not_replayed(self) -> None:
        self.finished(replay_ts="2024-10-29T16:00:00Z")
        api.cache.settings.semantic_cache = False
        self.agents.post_status = 500
        other_clock = self.c.post(
            "/runs",
            json={"question": "Which sites are exposed?", "replay_ts": "2024-10-29T18:00:00Z"},
        )
        self.assertEqual(other_clock.status_code, 500)
        other_lang = self.c.post(
            "/runs",
            json={
                "question": "Which sites are exposed?",
                "lang": "es",
                "replay_ts": "2024-10-29T16:00:00Z",
            },
        )
        self.assertEqual(other_lang.status_code, 500)

    def test_the_same_clock_in_a_short_form_is_replayed(self) -> None:
        first = self.finished(replay_ts="2024-10-29T16:00:00Z")
        api.cache.settings.semantic_cache = False
        self.agents.post_status = 500
        body = self.c.post(
            "/runs",
            json={"question": "Which sites are exposed?", "replay_ts": "2024-10-29 16:00Z"},
        ).json()
        self.assertEqual(body["served_from"], "replay")
        self.assertEqual(body["replay"]["original_run_id"], first["run_id"])
        self.assertEqual(body["replay"]["replay_ts"], "2024-10-29T16:00:00Z")

    def test_valencia_alias_replays_the_canonical_event(self) -> None:
        first = self.finished()
        api.cache.settings.semantic_cache = False
        self.agents.post_status = 500
        body = self.c.post(
            "/runs", json={"question": "Which sites are exposed?", "event_id": "valencia_2024"}
        ).json()
        self.assertEqual(body["replay"]["original_run_id"], first["run_id"])

    def test_a_follow_up_is_not_replayed_when_the_live_run_fails(self) -> None:
        first = self.finished()
        self.agents.fail_runs = True
        failed = self.c.post(
            "/runs", json={"question": "And the gauges?", "thread_id": first["run_id"]}
        )
        self.assertEqual(failed.status_code, 201)
        self.assertEqual(failed.json()["status"], "failed")
        self.assertNotIn("replay", failed.json())
        self.agents.fail_runs = False
        self.agents.down = True
        down = self.c.post(
            "/runs", json={"question": "Which sites are exposed?", "thread_id": first["run_id"]}
        )
        self.assertEqual(down.status_code, 503)

    def test_a_past_scan_that_times_out_serves_the_recording(self) -> None:
        first = self.finished()
        api.cache.settings.semantic_cache = False
        self.agents.past_error = httpx.TimeoutException("slow")
        self.agents.post_status = 500
        body = self.c.post("/runs", json={"question": "Which sites are exposed?"}).json()
        self.assertEqual(body["served_from"], "replay")
        self.assertEqual(body["replay"]["original_run_id"], first["run_id"])

    def test_cache_and_replay_lookups_use_the_short_timeout(self) -> None:
        self.finished()
        lookups = [
            timeout
            for method, path, timeout in self.agents.calls
            if method == "GET" and (path == "/config" or path.startswith("/runs/"))
        ]
        self.assertTrue(lookups)
        for timeout in lookups:
            self.assertIsNotNone(timeout)
            self.assertEqual(timeout.read, 3.0)
            self.assertNotEqual(timeout.read, 600.0)
        posts = [t for method, path, t in self.agents.calls if method == "POST" and path == "/runs"]
        self.assertTrue(posts)
        self.assertTrue(all(timeout is None for timeout in posts))

    def test_only_a_person_approved_run_is_replayed(self) -> None:
        self.finished(action="reject")
        self.agents.post_status = 500
        self.assertEqual(
            self.c.post("/runs", json={"question": "Which sites are exposed?"}).status_code, 500
        )

    def test_no_recording_keeps_the_503(self) -> None:
        self.agents.down = True
        self.assertEqual(self.c.post("/runs", json={"question": "q"}).status_code, 503)

    def test_replay_is_off_without_its_flag(self) -> None:
        api.cache.settings.cached_replay = False
        self.finished()
        self.agents.down = True
        self.assertEqual(self.c.post("/runs", json={"question": "q"}).status_code, 503)

    def test_config_reports_the_cache(self) -> None:
        stats = self.c.get("/config").json()["api_cache"]
        self.assertTrue(stats["FF_SEMANTIC_CACHE"])
        self.assertTrue(stats["FF_CACHED_REPLAY"])
        self.assertEqual(stats["lookup_timeout_s"], 3)

    def test_the_replay_route_carries_the_contract(self) -> None:
        first = self.finished()
        body = self.c.get(f"/runs/{first['run_id']}/replay").json()
        self.assertEqual(body["served_from"], "replay")
        self.assertEqual(body["contract"]["answer"]["served_from"], "replay")


@unittest.skipIf(agents_service is None, "agents package not importable")
class AgentsReplayRouteTest(unittest.TestCase):
    def setUp(self) -> None:
        from langgraph.checkpoint.memory import MemorySaver
        from floodsense_agents.graph import build_graph
        from floodsense_agents.nightshift import FakeNightshift
        from floodsense_agents.runtime import Runtime
        from floodsense_agents.state import Deps, NoMemory
        from floodsense_agents.zetaris import FakeZetaris

        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        agents_service.set_runtime(Runtime(graph=build_graph(deps, MemorySaver()), deps=deps))
        self.c = TestClient(agents_service.app)

    def test_a_recorded_run_is_labelled_replay_with_its_start_time(self) -> None:
        rid = self.c.post("/runs", json={"question": "Which sites are exposed?"}).json()["run_id"]
        self.c.post(f"/runs/{rid}/approval", json={"action": "approve", "reviewer": "ayush"})
        started = next(r for r in self.c.get("/runs/past").json()["runs"] if r["run_id"] == rid)
        body = self._replay_without_listing_checkpoints(rid)
        self.assertEqual(body["served_from"], "replay")
        self.assertEqual(body["cached_at"], started["created_at"])
        self.assertFalse(body["label"]["live"])
        self.assertTrue(body["label"]["text"].startswith("Replay of a recorded run from"))
        self.assertIn(f"original run {rid}", body["label"]["text"])

    def test_replay_after_a_restart_still_does_not_list_every_checkpoint(self) -> None:
        rid = self.c.post("/runs", json={"question": "Which sites are exposed?"}).json()["run_id"]
        started = next(r for r in self.c.get("/runs/past").json()["runs"] if r["run_id"] == rid)
        agents_service.runtime().index.clear()
        body = self._replay_without_listing_checkpoints(rid)
        self.assertEqual(body["served_from"], "replay")
        self.assertEqual(body["cached_at"], started["created_at"])
        self.assertEqual(len(agents_service.runtime().index), 1)

    def _replay_without_listing_checkpoints(self, rid: str) -> dict:
        rt = agents_service.runtime()
        calls = {"rebuild": 0}
        real = rt._rebuild_index

        def rebuild():
            calls["rebuild"] += 1
            return real()

        rt._rebuild_index = rebuild
        try:
            response = self.c.get(f"/runs/{rid}/replay")
        finally:
            rt._rebuild_index = real
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(calls["rebuild"], 0)
        return response.json()

    def test_an_unknown_run_is_a_404(self) -> None:
        self.assertEqual(self.c.get("/runs/nope/replay").status_code, 404)


if __name__ == "__main__":
    unittest.main()
