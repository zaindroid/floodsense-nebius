"""GET /system, the in-process counters, and the demo seed (app/system.py, app/demo_seed.py)."""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "tests"))

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import cache as cache_mod  # noqa: E402
from app import demo_seed  # noqa: E402
from app.cache import fingerprint  # noqa: E402
from app import main as api  # noqa: E402
from app.cache import CACHE_PREFIX, DEMO_SEED_KEY, REPLAY_PREFIX, AnswerCache, CacheSettings  # noqa: E402
from app.metrics import Counters  # noqa: E402
from app.ratelimit import RateLimiter, RateLimitSettings  # noqa: E402
from app.system import board_summary, build_system, is_seeded  # noqa: E402

from test_redis_cache import StubRedis  # noqa: E402

CONFIG = {
    "flags": {"FF_HMEM": True, "FF_RAG_DOCS": True},
    "lanes": {"fast": "meterless/fast", "deep": "meterless/deep"},
    "engines_url": "http://engines:8300",
    "schema": "floodsense",
}

RUN = {
    "run_id": "r1",
    "event_id": "EMSR773",
    "status": "approved",
    "served_from": "live",
    "approval": {"status": "approved"},
    "judge_summary": {"passes": True},
    "model_ids": ["nvidia/nemotron-3.5-lightning-30b-a3b"],
    "request": {"question": "Why was Paiporta exposed?", "event_id": "EMSR773"},
}

MEMORIES = [
    {
        "memory_id": "m1",
        "content": "Daily discharge for Paiporta (VAL01) was 467.81 m3/s on 2024-10-30.",
        "run_id": "demo-seed-valencia-paiporta",
        "event_id": "EMSR773",
        "provenance": {
            "learned_at": "2026-10-27T09:00:00.000Z",
            "label": "run demo-seed-valencia-paiporta approved by demo-seed",
        },
    },
    {
        "memory_id": "m2",
        "content": "x" * 400,
        "run_id": "r1",
        "provenance": {"learned_at": "2026-10-27T10:00:00.000Z", "label": "run r1 approved by ana"},
    },
]

BOARD = [
    {"run_id": "r1", "hypothesis_id": "H1", "link": "rain", "status": "supported", "updated_at": "b"},
    {"run_id": "r1", "hypothesis_id": "H2", "link": "runoff", "status": "challenged", "updated_at": "c"},
    {"run_id": "r0", "hypothesis_id": "H1", "link": "rain", "status": "proposed", "updated_at": "a"},
]


async def fake_agents(method, path, params=None, timeout=None):
    if path == "/config":
        return 200, CONFIG
    if path == "/runs/past":
        return 200, {"runs": [{"run_id": "r1", "status": "approved", "event_id": "EMSR773"}]}
    if path == "/runs/r1":
        return 200, RUN
    return 404, None


def engines_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/health":
        return httpx.Response(
            200, json={"ok": True, "hmem": {"memories": 2}, "world_model": {"events": 9, "hypotheses": 3}}
        )
    if request.url.path == "/hmem/memories":
        return httpx.Response(200, json={"total": 2, "memories": MEMORIES})
    if request.url.path == "/wm/board":
        run_id = request.url.params.get("run_id")
        return httpx.Response(200, json={"board": [b for b in BOARD if not run_id or b["run_id"] == run_id]})
    return httpx.Response(404, json={"error": "no route"})


def build(cache=None, limiter=None, counters=None, engines_base="http://engines.test", agents=fake_agents):
    return asyncio.run(
        build_system(
            cache=cache or AnswerCache(CacheSettings(), redis_client=None),
            limiter=limiter or RateLimiter(RateLimitSettings(10, 2, 30)),
            counters=counters or Counters(),
            agents_json=agents,
            lookup_timeout=1.0,
            engines_base=engines_base,
            engines_transport=httpx.MockTransport(engines_handler),
        )
    )


class SystemBodyTest(unittest.TestCase):
    def test_sections(self) -> None:
        body = build()
        self.assertEqual(body["cache"]["backend"], "memory")
        self.assertEqual(body["rate_limit"]["runs_per_min_per_client"], 10)
        self.assertEqual(body["rate_limit"]["max_concurrent_runs"], 2)
        self.assertTrue(body["engines"]["ok"])
        self.assertEqual(body["memory"]["count"], 2)
        self.assertEqual(body["memory"]["seeded"], 1)
        first = body["memory"]["latest"][0]
        self.assertEqual(first["id"], "m1")
        self.assertTrue(first["seeded"])
        self.assertEqual(first["approved_at"], "2026-10-27T09:00:00.000Z")
        self.assertLessEqual(len(body["memory"]["latest"][1]["text"]), 160)
        self.assertFalse(body["memory"]["latest"][1]["seeded"])
        self.assertEqual(body["world_model"]["run_id"], "r1")
        self.assertEqual(body["world_model"]["by_status"], {"challenged": 1, "supported": 1})
        self.assertEqual(body["models"]["latest_model_ids"], RUN["model_ids"])
        self.assertTrue(body["rag"]["enabled"])
        self.assertIsNone(body["rag"]["passages"])

    def test_nebius_model_ids_reach_the_system_body(self) -> None:
        ids = ["nvidia/Nemotron-3.5-Super-VL", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"]

        async def agents(method, path, params=None, timeout=None):
            if path == "/runs/r1":
                return 200, {**RUN, "model_ids": ids}
            return await fake_agents(method, path, params, timeout)

        self.assertEqual(build(agents=agents)["models"]["latest_model_ids"], ids)

    def test_no_secrets_or_urls(self) -> None:
        text = json.dumps(build())
        self.assertNotIn("engines_url", text)
        self.assertNotIn("http://", text)
        self.assertNotIn("redis://", text)

    def test_engines_off_and_agents_down(self) -> None:
        async def down(*a, **k):
            return 503, None

        body = build(engines_base="", agents=down)
        self.assertFalse(body["engines"]["configured"])
        self.assertIsNone(body["memory"]["count"])
        self.assertFalse(body["models"]["ok"])
        self.assertIsNone(body["latest_run"])

    def test_engines_unreachable(self) -> None:
        def boom(request):
            raise httpx.ConnectError("refused")

        body = asyncio.run(
            build_system(
                cache=AnswerCache(CacheSettings(), redis_client=None),
                limiter=RateLimiter(),
                counters=Counters(),
                agents_json=fake_agents,
                lookup_timeout=1.0,
                engines_base="http://engines.test",
                engines_transport=httpx.MockTransport(boom),
            )
        )
        self.assertFalse(body["engines"]["ok"])
        self.assertIn("not reachable", body["engines"]["error"])
        self.assertEqual(body["memory"]["latest"], [])

    def test_redis_key_counts(self) -> None:
        stub = StubRedis()
        stub.set(CACHE_PREFIX + "a", "{}")
        stub.set(REPLAY_PREFIX + "b", "{}")
        stub.set(REPLAY_PREFIX + "c", "{}")
        marker = {
            "run_ids": ["r1", "gone"],
            "entries": [
                {"run_id": "r1", "cache_key": CACHE_PREFIX + "a"},
                {"run_id": "gone", "cache_key": CACHE_PREFIX + "expired"},
            ],
        }
        stub.set(DEMO_SEED_KEY, json.dumps(marker))
        stub.set("other", "{}")
        body = build(cache=AnswerCache(CacheSettings(), redis_client=stub))
        self.assertEqual(body["cache"]["backend"], "redis")
        self.assertEqual(body["cache"]["keys"], {"cache": 1, "replay": 2, "demo": 1})
        self.assertEqual(body["cache"]["seeded_runs"], ["r1"])  # the expired one is not listed

    def test_helpers(self) -> None:
        self.assertTrue(is_seeded({"run_id": "demo-seed-x"}))
        self.assertFalse(is_seeded({"run_id": "r1", "provenance": {"label": "run r1 approved by ana"}}))
        self.assertEqual(board_summary(BOARD, None)["run_id"], "r1")
        self.assertEqual(board_summary([], None)["hypotheses"], 0)


class CountersTest(unittest.TestCase):
    def test_recent_window(self) -> None:
        now = [1000.0]
        c = Counters(clock=lambda: now[0])
        c.rejected()
        now[0] += 400
        c.rejected()
        self.assertEqual(c.recent_rejections(), 1)
        self.assertEqual(c.snapshot()["rejected_429_total"], 2)


class SystemRouteTest(unittest.TestCase):
    def test_route_counts_429s_and_in_flight(self) -> None:
        limiter = RateLimiter(RateLimitSettings(runs_per_min=1, max_concurrent_runs=2))
        counters = Counters()

        async def fake_request(method, path, body=None, params=None, timeout=None):
            if path == "/runs" and method == "POST":
                return httpx.Response(422, json={"detail": "not a run request"})
            return httpx.Response(503)

        with (
            mock.patch.object(api, "limiter", limiter),
            mock.patch.object(api, "counters", counters),
            mock.patch.object(api, "_agents_request", fake_request),
            mock.patch.dict("os.environ", {"ENGINES_URL": ""}),
        ):
            client = TestClient(api.app)
            self.assertEqual(client.post("/runs", json=[]).status_code, 422)
            refused = client.post("/runs", json=[])
            self.assertEqual(refused.status_code, 429)
            self.assertIn("Retry-After", refused.headers)
            r = client.get("/system")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("cache-control"), "no-store")
        rl = r.json()["rate_limit"]
        self.assertEqual(rl["rejected_429_total"], 1)
        self.assertEqual(rl["rejected_429_recent"], 1)
        self.assertEqual(rl["in_flight"], 0)


class DemoSeedTest(unittest.TestCase):
    def test_every_seed_is_labelled_and_cited(self) -> None:
        events = {s["event_id"] for s in demo_seed.SEEDS}
        # LIVE-EU: the river-history seeds, recalled by Europe live watch runs
        self.assertEqual(events, {"EMSR773", "EMSR517", "LIVE-EU"})
        text = json.dumps(demo_seed.SEEDS)
        for place in ("Paiporta", "Barranc del Poyo", "Altenahr"):
            self.assertIn(place, text)
        for seed in demo_seed.SEEDS:
            self.assertTrue(seed["run_id"].startswith("demo-seed-"))
            for claim in seed["claims"]:
                self.assertIn("demo-seed", claim["entities"])
                self.assertTrue(claim["citations"])

    def test_seed_memory_uses_the_approval_store(self) -> None:
        bodies = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/hmem/store")
            body = json.loads(request.content)
            bodies.append(body)
            stored = [{"claim_id": c["claim_id"], "memory_id": "m"} for c in body["claims"]]
            return httpx.Response(200, json={"stored": stored, "already_stored": [], "skipped": 0})

        with mock.patch("builtins.print"):
            n = demo_seed.seed_memory("http://engines.test", transport=httpx.MockTransport(handler))
        self.assertEqual(len(bodies), len(demo_seed.SEEDS))
        self.assertEqual(n, sum(len(s["claims"]) for s in demo_seed.SEEDS))
        for body in bodies:
            self.assertEqual(body["approval"]["status"], "approved")
            self.assertEqual(body["approval"]["reviewer"], "demo-seed")
            self.assertEqual(body["approval"]["reviewer_note"], "seeded for demo")

    def _agents(self, runs: dict[str, dict]):
        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            if path == "/config":
                return httpx.Response(200, json=CONFIG)
            if path == "/runs/past":
                rows = [{"run_id": k, "status": "approved", "event_id": v["event_id"]} for k, v in runs.items()]
                return httpx.Response(200, json={"runs": rows})
            rid = path.split("/")[2]
            if path.endswith("/replay"):
                return httpx.Response(200, json={**runs[rid], "served_from": "replay"})
            return httpx.Response(200, json=runs[rid])

        return httpx.MockTransport(handler)

    def test_warm_cache_writes_two_runs_and_a_marker(self) -> None:
        def run(rid, event, q, passes=True):
            return {
                **RUN,
                "run_id": rid,
                "event_id": event,
                "judge_summary": {"passes": passes},
                "request": {"question": q, "event_id": event},
            }

        runs = {
            "a": run("a", "EMSR773", "Q one"),
            "b": run("b", "EMSR773", "Q two"),
            "c": run("c", "EMSR517", "Q three"),
            "d": run("d", "EMSR517", "Q four", passes=False),
        }
        stub = StubRedis()
        cache = AnswerCache(CacheSettings(semantic_cache=True, cached_replay=True), redis_client=stub)
        with mock.patch("builtins.print"):
            warmed = demo_seed.warm_cache("http://agents.test", cache, transport=self._agents(runs))
        self.assertEqual(warmed, ["a", "c"])  # one per event first, never the Judge-failed one
        marker = cache.demo_seeded()
        self.assertEqual(marker["run_ids"], ["a", "c"])
        self.assertEqual(marker["note"], "seeded for demo")
        keys = cache.key_counts()
        self.assertEqual(keys, {"cache": 2, "replay": 2, "demo": 1})
        self.assertEqual(cache.demo_seeded_live(), ["a", "c"])
        # A fresh API process (same Redis, no in-process entries) finds the warmed
        # run with the normal lookup, whose key includes CORPUS_VERSION.
        api_cache = AnswerCache(CacheSettings(semantic_cache=True), redis_client=stub)
        flags = fingerprint(CONFIG)
        for rid in ("a", "c"):
            found = api_cache.lookup(runs[rid]["request"], flags)
            self.assertIsNotNone(found)
            self.assertEqual(found.run_id, rid)
            self.assertEqual(found.ttl_s, cache.settings.recording_ttl_s)
        self.assertIsNone(api_cache.lookup(runs["b"]["request"], flags))
        with mock.patch.object(cache_mod, "CORPUS_VERSION", "rag-next"):
            self.assertIsNone(api_cache.lookup(runs["a"]["request"], flags))
        for entry in marker["entries"]:
            stored = json.loads(stub.get(entry["cache_key"]))
            self.assertEqual(stored["ttl_s"], cache.settings.recording_ttl_s)
            self.assertGreater(stub.ttl(entry["cache_key"]), 86400)
        with mock.patch("builtins.print"):
            demo_seed.reset(cache)
        self.assertEqual(cache.key_counts(), {"cache": 0, "replay": 0, "demo": 0})

    def test_semantic_cache_warning(self) -> None:
        off = AnswerCache(CacheSettings(semantic_cache=False), redis_client=None)
        on = AnswerCache(CacheSettings(semantic_cache=True), redis_client=None)
        self.assertIn("FF_SEMANTIC_CACHE=true", demo_seed.semantic_cache_warning(off))
        self.assertIsNone(demo_seed.semantic_cache_warning(on))

    def test_ahr_seed_is_not_an_eval_question(self) -> None:
        questions = {s["question"] for s in demo_seed.SEEDS}
        self.assertNotIn("What discharge did the Altenahr gauge reach?", questions)

    def test_warm_cache_needs_redis(self) -> None:
        cache = AnswerCache(CacheSettings(), redis_client=None)
        with mock.patch("builtins.print"):
            self.assertEqual(demo_seed.warm_cache("http://agents.test", cache, transport=self._agents({})), [])


if __name__ == "__main__":
    unittest.main()
