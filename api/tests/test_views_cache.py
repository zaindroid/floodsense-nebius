"""GET /views/{name} cache: TTL, single flight, stale-if-error, Redis and memory, restart."""

from __future__ import annotations

import asyncio
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "tests"))
os.environ.setdefault("VIEWS_CACHE_WARM", "0")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as api  # noqa: E402
from app.cache import _RedisStore  # noqa: E402
from app.views_cache import VIEWS_PREFIX, ViewsCache, ttl_for  # noqa: E402

from test_redis_cache import new_client  # noqa: E402


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


def ok(n=1):
    return (200, f'[{{"n": {n}}}]', "application/json", {"x-query-id": f"q{n}", "x-executed-at": f"t{n}"})


class Upstream:
    def __init__(self, *results) -> None:
        self.results = list(results)
        self.calls = 0
        self.delay = 0.0

    async def __call__(self):
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        r = self.results[min(self.calls - 1, len(self.results) - 1)]
        if isinstance(r, Exception):
            raise r
        return r


def run(coro):
    return asyncio.run(coro)


class ViewsCacheTest(unittest.TestCase):
    def make(self, store=None):
        self.clock = Clock()
        return ViewsCache(store, clock=self.clock)

    def test_ttls(self) -> None:
        self.assertEqual(ttl_for("eu_watch", {}), 600)
        self.assertEqual(ttl_for("hazard_now", None), 600)
        self.assertEqual(ttl_for("gauge_levels", {}), 120)
        self.assertEqual(ttl_for("hazard_timeline", {"source": "replay"}), 3600)
        self.assertIsNone(ttl_for("policies", {}))

    def test_miss_then_hit_then_ttl_expiry(self) -> None:
        vc = self.make()
        up = Upstream(ok(1), ok(2))
        a = run(vc.get("gauge_levels", {}, up))
        b = run(vc.get("gauge_levels", {}, up))
        self.assertEqual((a.cache, b.cache, up.calls), ("miss", "hit", 1))
        self.clock.t += 119
        self.assertEqual(run(vc.get("gauge_levels", {}, up)).cache, "hit")
        self.clock.t += 2
        c = run(vc.get("gauge_levels", {}, up))
        self.assertEqual((c.cache, c.age_s, up.calls), ("miss", 0, 2))
        self.assertIn('"n": 2', c.body)

    def test_eu_watch_ttl_is_600(self) -> None:
        vc = self.make()
        up = Upstream(ok(1), ok(2))
        run(vc.get("eu_watch", {}, up))
        self.clock.t += 599
        self.assertEqual(run(vc.get("eu_watch", {}, up)).cache, "hit")
        self.clock.t += 2
        self.assertEqual(run(vc.get("eu_watch", {}, up)).cache, "miss")

    def test_key_includes_the_query(self) -> None:
        vc = self.make()
        up = Upstream(ok(1), ok(2))
        run(vc.get("hazard_timeline", {"event_id": "A"}, up))
        run(vc.get("hazard_timeline", {"event_id": "B"}, up))
        self.assertEqual(up.calls, 2)

    def test_uncached_view_passes_through(self) -> None:
        vc = self.make()
        up = Upstream(ok(1))
        a = run(vc.get("policies", {}, up))
        run(vc.get("policies", {}, up))
        self.assertIsNone(a.cache)
        self.assertEqual(up.calls, 2)
        self.assertNotIn("x-views-cache", a.response_headers())

    def test_single_flight(self) -> None:
        vc = self.make()
        up = Upstream(ok(1))
        up.delay = 0.05

        async def go():
            return await asyncio.gather(*[vc.get("eu_watch", {}, up) for _ in range(8)])

        out = run(go())
        self.assertEqual(up.calls, 1)
        self.assertEqual(sorted(s.cache for s in out), ["hit"] * 7 + ["miss"])

    def test_single_flight_failure_is_shared(self) -> None:
        vc = self.make()
        up = Upstream((502, "bad", "text/plain", {}))
        up.delay = 0.05

        async def go():
            return await asyncio.gather(*[vc.get("eu_watch", {}, up) for _ in range(5)])

        out = run(go())
        self.assertEqual(up.calls, 1)
        self.assertTrue(all(s.status == 502 and s.cache is None for s in out))

    def test_stale_if_error_keeps_query_id_and_age(self) -> None:
        vc = self.make()
        run(vc.get("eu_watch", {}, Upstream(ok(7))))
        self.clock.t += 700  # past the TTL, inside 24 h
        for bad in (
            (502, "x", "text/plain", {}),
            (429, "x", "text/plain", {}),
            httpx.ConnectTimeout("t"),
        ):
            s = run(vc.get("eu_watch", {}, Upstream(bad)))
            self.assertEqual((s.status, s.cache, s.age_s), (200, "stale", 700))
            h = s.response_headers()
            self.assertEqual((h["x-query-id"], h["x-executed-at"]), ("q7", "t7"))
            self.assertEqual((h["x-views-cache"], h["x-views-age-s"]), ("stale", "700"))
        st = vc.stats()
        self.assertEqual(st["stale_serves"], 3)
        self.assertIn("ConnectTimeout", st["views"]["eu_watch"]["last_upstream_error"]["detail"])

    def test_stale_expires_after_24h(self) -> None:
        vc = self.make()
        run(vc.get("eu_watch", {}, Upstream(ok(1))))
        self.clock.t += 24 * 3600 + 1
        s = run(vc.get("eu_watch", {}, Upstream((502, "bad", "text/plain", {}))))
        self.assertEqual((s.status, s.cache), (502, None))

    def test_recovery_after_stale(self) -> None:
        vc = self.make()
        run(vc.get("eu_watch", {}, Upstream(ok(1))))
        self.clock.t += 700
        run(vc.get("eu_watch", {}, Upstream((502, "x", "text/plain", {}))))
        s = run(vc.get("eu_watch", {}, Upstream(ok(2))))
        self.assertEqual((s.cache, s.age_s), ("miss", 0))

    def test_failing_upstream_with_empty_cache_is_the_502(self) -> None:
        vc = self.make()
        s = run(vc.get("eu_watch", {}, Upstream((502, "nope", "text/plain", {"x-query-id": "q"}))))
        self.assertEqual((s.status, s.cache, s.body), (502, None, "nope"))
        with self.assertRaises(httpx.ConnectError):
            run(vc.get("eu_watch", {}, Upstream(httpx.ConnectError("down"))))
        # errors are not cached
        up = Upstream(ok(1))
        self.assertEqual(run(vc.get("eu_watch", {}, up)).cache, "miss")

    def test_client_errors_are_not_masked_by_a_stale_copy(self) -> None:
        vc = self.make()
        run(vc.get("eu_watch", {}, Upstream(ok(1))))
        self.clock.t += 700
        s = run(vc.get("eu_watch", {}, Upstream((404, "no", "text/plain", {}))))
        self.assertEqual(s.status, 404)

    def test_empty_200_does_not_replace_a_good_copy(self) -> None:
        vc = self.make()
        run(vc.get("eu_watch", {}, Upstream(ok(1))))
        self.clock.t += 700
        for body in ("[]", "", '{"rows": []}'):
            s = run(vc.get("eu_watch", {}, Upstream((200, body, "application/json", {}))))
            self.assertEqual((s.cache, s.status), ("stale", 200))
            self.assertIn('"n": 1', s.body)

    def test_empty_200_with_no_copy_is_returned_uncached(self) -> None:
        vc = self.make()
        s = run(vc.get("eu_watch", {}, Upstream((200, "[]", "application/json", {}))))
        self.assertEqual((s.status, s.cache, s.body), (200, None, "[]"))
        self.assertEqual(run(vc.get("eu_watch", {}, Upstream(ok(2)))).cache, "miss")

    def test_a_cancelled_leader_does_not_break_the_waiters(self) -> None:
        vc = self.make()
        up = Upstream(ok(1))
        up.delay = 0.1

        async def go():
            leader = asyncio.ensure_future(vc.get("eu_watch", {}, up))
            await asyncio.sleep(0.02)
            waiter = asyncio.ensure_future(vc.get("eu_watch", {}, up))
            await asyncio.sleep(0.02)
            leader.cancel()
            return await waiter

        s = run(go())
        self.assertEqual((s.status, s.cache, up.calls), (200, "hit", 1))

    def test_memory_backend_is_reported(self) -> None:
        self.assertEqual(self.make().stats()["backend"], "memory")

    def test_redis_backend_persists_across_restart(self) -> None:
        client = new_client()
        vc1 = self.make(_RedisStore(client, 0.5))
        run(vc1.get("eu_watch", {}, Upstream(ok(9))))
        self.assertEqual(vc1.stats()["backend"], "redis")
        self.assertTrue([k for k in client.keys("*") if (k.decode() if isinstance(k, bytes) else k).startswith(VIEWS_PREFIX)])
        # a new process: empty memory, same Redis
        vc2 = ViewsCache(_RedisStore(client, 0.5), clock=self.clock)
        up = Upstream(ok(10))
        s = run(vc2.get("eu_watch", {}, up))
        self.assertEqual((s.cache, up.calls), ("hit", 0))
        self.assertEqual(s.response_headers()["x-query-id"], "q9")
        # a restart whose upstream is dead still serves the last good copy
        self.clock.t += 5000
        vc3 = ViewsCache(_RedisStore(client, 0.5), clock=self.clock)
        s = run(vc3.get("eu_watch", {}, Upstream((502, "x", "text/plain", {}))))
        self.assertEqual((s.cache, s.age_s), ("stale", 5000))

    def test_redis_down_falls_back_to_memory(self) -> None:
        broken = mock.Mock()
        broken.get.side_effect = ConnectionError
        broken.set.side_effect = ConnectionError
        vc = self.make(_RedisStore(broken, 0.5))
        up = Upstream(ok(1))
        run(vc.get("eu_watch", {}, up))
        self.assertEqual(run(vc.get("eu_watch", {}, up)).cache, "hit")
        self.assertEqual(vc.stats()["backend"], "memory")

    def test_warm_is_serialized_with_gaps_and_skips_fresh(self) -> None:
        vc = self.make()
        run(vc.get("eu_watch", {}, Upstream(ok(1))))
        seen, naps = [], []

        def fetch(name):
            seen.append(name)
            if name == "hazard_now":
                return 429, "x", "text/plain", {}
            return ok(3)

        vc.warm(fetch, sleep=naps.append)
        self.assertNotIn("eu_watch", seen)
        self.assertEqual(seen[0], "hazard_now")
        self.assertEqual(len(naps), len(seen) - 1)
        self.assertTrue(all(n == 5.0 for n in naps))
        self.assertEqual(run(vc.get("gauge_levels", {}, Upstream(ok(4)))).cache, "hit")
        self.assertIn("429", vc.stats()["views"]["hazard_now"]["last_upstream_error"]["detail"])
        self.assertIsNone(vc.stats()["views"]["hazard_now"]["last_ok_at"])
        self.assertIsNotNone(vc.stats()["views"]["gauge_levels"]["last_ok_at"])


class ViewsRouteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.vc = ViewsCache()
        p = mock.patch.object(api, "views_cache", self.vc)
        p.start()
        self.addCleanup(p.stop)
        self.c = TestClient(api.app)
        self.mode = "ok"
        self.calls = 0

        async def fake(method, path, body=None, params=None, timeout=None):
            self.calls += 1
            if self.mode == "dead":
                raise httpx.ConnectError("dead upstream")
            if self.mode == "429":
                return httpx.Response(502, text="HTTP response code: 429")
            return httpx.Response(
                200, json=[{"a": 1}], headers={"x-query-id": "zq-1", "x-executed-at": "2026-10-27T10:00:00Z"}
            )

        p2 = mock.patch.object(api, "_agents_request", side_effect=fake)
        p2.start()
        self.addCleanup(p2.stop)

    def test_miss_hit_and_headers(self) -> None:
        a = self.c.get("/views/gauge_levels")
        b = self.c.get("/views/gauge_levels")
        self.assertEqual((a.headers["x-views-cache"], b.headers["x-views-cache"]), ("miss", "hit"))
        self.assertEqual(b.headers["x-query-id"], "zq-1")
        self.assertEqual(self.calls, 1)
        self.assertEqual(b.json(), [{"a": 1}])

    def test_stale_through_the_route_and_stats(self) -> None:
        self.c.get("/views/eu_watch")
        self.vc._clock = lambda: time.time() + 900
        self.mode = "429"
        r = self.c.get("/views/eu_watch")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-views-cache"], "stale")
        self.assertGreaterEqual(int(r.headers["x-views-age-s"]), 899)
        self.assertEqual(r.headers["x-query-id"], "zq-1")
        self.assertEqual(r.headers["x-executed-at"], "2026-10-27T10:00:00Z")
        self.mode = "dead"
        self.assertEqual(self.c.get("/views/eu_watch").headers["x-views-cache"], "stale")
        self.assertEqual(self.vc.stats()["views"]["eu_watch"]["stale_serves"], 2)

    def test_empty_cache_and_failing_upstream_is_the_old_error(self) -> None:
        self.mode = "429"
        self.assertEqual(self.c.get("/views/eu_watch").status_code, 502)
        self.mode = "dead"
        self.assertEqual(self.c.get("/views/hazard_now").status_code, 503)

    def test_cors_exposes_the_cache_headers(self) -> None:
        r = self.c.get("/views/gauge_levels", headers={"Origin": "http://localhost:15173"})
        exposed = r.headers.get("access-control-expose-headers", "").lower()
        self.assertIn("x-views-cache", exposed)
        self.assertIn("x-views-age-s", exposed)


if __name__ == "__main__":
    unittest.main()
