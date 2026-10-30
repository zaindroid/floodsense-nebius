"""Redis backend for the API cache (app/cache.py).

The existing cache tests run again with Redis behind the cache: fakeredis
when it is installed (requirements-dev.txt), else a small in-test stub. One
smoke test uses a real Redis at REDIS_SMOKE_URL (default
redis://127.0.0.1:16379/15) and skips when none answers.
"""

from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "tests"))

from app import cache as cache_mod  # noqa: E402
from app.cache import CACHE_PREFIX, REPLAY_PREFIX, AnswerCache  # noqa: E402

import test_cache  # noqa: E402
import test_mode_cache  # noqa: E402

try:
    import fakeredis
except ImportError:  # requirements-dev.txt not installed
    fakeredis = None


class StubRedis:
    """Enough of redis.Redis for the cache: get, set ex, delete, scan_iter, ping."""

    def __init__(self) -> None:
        self.data: dict[str, tuple[bytes, float]] = {}
        self.broken = False

    def _check(self) -> None:
        if self.broken:
            raise ConnectionError("redis down")

    def _live(self, key: str):
        item = self.data.get(key)
        if item and item[1] < time.monotonic():
            del self.data[key]
            return None
        return item

    def ping(self) -> bool:
        self._check()
        return True

    def set(self, key, value, ex=None):
        self._check()
        raw = value.encode() if isinstance(value, str) else value
        self.data[key] = (raw, time.monotonic() + (ex if ex else 10**9))
        return True

    def get(self, key):
        self._check()
        item = self._live(key)
        return item[0] if item else None

    def ttl(self, key):
        item = self._live(key)
        return int(item[1] - time.monotonic()) if item else -2

    def delete(self, *keys):
        self._check()
        return sum(1 for k in keys if self.data.pop(k, None) is not None)

    def keys(self, pattern="*"):
        return list(self.scan_iter(pattern))

    def scan_iter(self, match="*", count=None):
        self._check()
        prefix = match.rstrip("*")
        return iter([k for k in list(self.data) if k.startswith(prefix) and self._live(k)])


def new_client():
    return fakeredis.FakeRedis() if fakeredis is not None else StubRedis()


class _OnRedis:
    """Mixin: every AnswerCache built in the test gets its own fake Redis."""

    def setUp(self) -> None:
        patcher = mock.patch.object(cache_mod, "_client_from_env", lambda *_: new_client())
        patcher.start()
        self.addCleanup(patcher.stop)
        super().setUp()


class AnswerCacheOnRedisTest(_OnRedis, test_cache.AnswerCacheTest):
    # Local LRU eviction does not delete in Redis; the TTL bounds an entry there.
    def test_the_oldest_entry_goes_first_when_full(self) -> None:
        c = AnswerCache(test_cache.settings(max_entries=2))
        for i in range(3):
            c.remember(test_cache.run(f"r{i}", question=f"q{i}"), "f")
        self.assertEqual(c.stats()["entries"], 2)
        self.assertEqual(c.lookup({"question": "q0"}, "f").run_id, "r0")

    # In Redis, drop deletes the slot of the request that found the run.
    def test_drop_forgets_a_run(self) -> None:
        c = AnswerCache(test_cache.settings())
        c.remember(test_cache.run(), "f")
        c.drop("r1", {"question": "Which sites are exposed?"}, "f")
        self.assertIsNone(c.lookup({"question": "Which sites are exposed?"}, "f"))

    def test_recordings_keep_one_slot_per_question(self) -> None:
        c = AnswerCache(test_cache.settings(max_recordings=1))
        c.record(test_cache._recording("a", "EMSR773", "q"))
        c.record(test_cache._recording("b", "EMSR517", "q"))
        self.assertEqual(c.stats()["recordings"], 1)
        self.assertEqual(c.recording_for({"question": "q", "event_id": "EMSR773"})["run_id"], "a")
        self.assertEqual(c.recording_for({"question": "q", "event_id": "EMSR517"})["run_id"], "b")


class ApiFlowOnRedisTest(_OnRedis, test_cache.ApiFlowTest):
    pass


class ModeCacheOnRedisTest(_OnRedis, test_mode_cache.ModeCacheTest):
    pass


def finished(run_id="r1", question="Which sites are exposed?"):
    return test_cache.run(run_id, question=question)


class RedisBackendTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = new_client()
        self.cache = AnswerCache(test_cache.settings(ttl_replay_s=120), redis_client=self.client)

    def test_an_entry_is_stored_as_json_with_a_native_ttl(self) -> None:
        self.assertTrue(self.cache.remember(finished(), "f"))
        keys = [
            k.decode() if isinstance(k, bytes) else k for k in self.client.scan_iter("floodsense:*")
        ]
        self.assertEqual(len(keys), 1)
        self.assertTrue(keys[0].startswith(CACHE_PREFIX))
        value = json.loads(self.client.get(keys[0]))
        self.assertEqual(value["run_id"], "r1")
        self.assertEqual(value["ttl_s"], 120)
        self.assertTrue(0 < self.client.ttl(keys[0]) <= 120)

    def test_a_second_process_reads_what_the_first_wrote(self) -> None:
        self.cache.remember(finished(), "f")
        self.cache.record(test_cache._recording("a", "EMSR773", "q"))
        other = AnswerCache(test_cache.settings(), redis_client=self.client)
        self.assertEqual(other.lookup({"question": "which sites are exposed"}, "f").run_id, "r1")
        self.assertEqual(other.recording_for({"question": "q"})["run_id"], "a")
        other.drop("r1", {"question": "which sites are exposed"}, "f")
        third = AnswerCache(test_cache.settings(), redis_client=self.client)
        self.assertIsNone(third.lookup({"question": "which sites are exposed"}, "f"))

    def test_drop_deletes_only_the_looked_up_slot_without_a_scan(self) -> None:
        self.cache.remember(finished("r1", "q1"), "f")
        self.cache.remember(finished("r2", "q2"), "f")
        spy = mock.MagicMock(wraps=self.client)
        c = AnswerCache(test_cache.settings(), redis_client=spy)
        c.drop("r1", {"question": "q1"}, "f")
        spy.scan_iter.assert_not_called()
        spy.keys.assert_not_called()
        self.assertEqual(spy.delete.call_count, 1)
        self.assertIsNone(c.lookup({"question": "q1"}, "f"))
        self.assertEqual(c.lookup({"question": "q2"}, "f").run_id, "r2")

    def test_stats_do_not_scan_redis(self) -> None:
        spy = mock.MagicMock(wraps=self.client)
        c = AnswerCache(test_cache.settings(), redis_client=spy)
        c.remember(finished(), "f")
        self.assertEqual(c.stats()["entries"], 1)
        spy.scan_iter.assert_not_called()
        spy.keys.assert_not_called()

    def test_a_miss_in_redis_falls_through_to_memory_after_recovery(self) -> None:
        flaky = StubRedis()
        c = AnswerCache(test_cache.settings(), redis_client=flaky)
        flaky.broken = True
        with self.assertLogs("floodsense.api.cache", "WARNING"):
            c.remember(finished(), "f")
        c.record(test_cache._recording("a", "EMSR773", "q"))
        flaky.broken = False
        c._redis._down_until = 0.0  # Redis is back, empty of what was written while down
        self.assertEqual(c.recording_for({"question": "q"})["run_id"], "a")
        self.assertEqual(c.lookup({"question": "which sites are exposed"}, "f").run_id, "r1")
        # The entry is written back, so another process now sees it.
        other = AnswerCache(test_cache.settings(), redis_client=flaky)
        self.assertEqual(other.lookup({"question": "which sites are exposed"}, "f").run_id, "r1")

    def test_a_recording_older_than_a_day_is_still_served(self) -> None:
        c = AnswerCache(test_cache.settings(ttl_replay_s=86400), redis_client=self.client)
        c.record(test_cache._recording("a", "EMSR773", "q"))
        key = next(iter(self.client.scan_iter(REPLAY_PREFIX + "*")))
        self.assertGreater(self.client.ttl(key), 86400 * 2)
        fresh = AnswerCache(test_cache.settings(), redis_client=self.client)  # restart
        with mock.patch.object(cache_mod.time, "time", return_value=time.time() + 3 * 86400):
            self.assertEqual(fresh.recording_for({"question": "q"})["run_id"], "a")

    def test_a_slow_call_trips_the_down_window(self) -> None:
        slow = StubRedis()
        real_get = slow.get

        def sluggish(key):
            time.sleep(0.06)
            return real_get(key)

        slow.get = sluggish
        c = AnswerCache(test_cache.settings(lookup_timeout_s=0.05), redis_client=slow)
        with self.assertLogs("floodsense.api.cache", "WARNING"):
            c.lookup({"question": "x"}, "f")
        self.assertEqual(c.stats()["backend"], "memory")

    def test_recordings_use_the_replay_prefix(self) -> None:
        self.cache.record(test_cache._recording("a", "EMSR773", "q"))
        keys = [
            k.decode() if isinstance(k, bytes) else k for k in self.client.scan_iter("floodsense:*")
        ]
        self.assertEqual(len(keys), 1)
        self.assertTrue(keys[0].startswith(REPLAY_PREFIX))

    def test_stats_report_the_backend(self) -> None:
        self.cache.remember(finished(), "f")
        stats = self.cache.stats()
        self.assertEqual(stats["backend"], "redis")
        self.assertEqual(stats["entries"], 1)

    def test_redis_down_falls_back_to_memory_and_logs_once(self) -> None:
        broken = mock.MagicMock()
        for name in ("get", "set", "delete", "scan_iter", "ping"):
            getattr(broken, name).side_effect = ConnectionError("redis down")
        c = AnswerCache(test_cache.settings(), redis_client=broken)
        with self.assertLogs("floodsense.api.cache", "WARNING") as logs:
            self.assertTrue(c.remember(finished(), "f"))
            self.assertEqual(c.lookup({"question": "which sites are exposed"}, "f").run_id, "r1")
            c.record(test_cache._recording("a", "EMSR773", "q"))
            self.assertEqual(c.recording_for({"question": "q"})["run_id"], "a")
            c.drop("r1")
            self.assertEqual(c.stats()["backend"], "memory")
        self.assertEqual(len(logs.records), 1)
        self.assertIsNone(c.lookup({"question": "which sites are exposed"}, "f"))

    def test_redis_comes_back_after_the_retry_window(self) -> None:
        flaky = StubRedis()
        c = AnswerCache(test_cache.settings(), redis_client=flaky)
        flaky.broken = True
        with self.assertLogs("floodsense.api.cache", "WARNING"):
            c.remember(finished(), "f")
        flaky.broken = False
        self.assertEqual(c.stats()["backend"], "memory")
        c._redis._down_until = 0.0  # the retry window has passed
        with self.assertLogs("floodsense.api.cache", "INFO") as logs:
            self.assertEqual(c.stats()["backend"], "redis")
        self.assertIn("reachable again", logs.output[0])
        c.remember(finished(), "f")
        self.assertEqual(c.stats()["entries"], 1)

    def test_unset_redis_url_is_memory(self) -> None:
        with mock.patch.dict(os.environ, {"REDIS_URL": ""}):
            self.assertEqual(AnswerCache(test_cache.settings()).stats()["backend"], "memory")


class RealRedisSmokeTest(unittest.TestCase):
    def test_round_trip_on_a_real_redis(self) -> None:
        try:
            import redis
        except ImportError:
            self.skipTest("redis package not installed")
        url = os.environ.get("REDIS_SMOKE_URL", "redis://127.0.0.1:16379/15")
        client = redis.Redis.from_url(url, socket_timeout=0.5, socket_connect_timeout=0.5)
        try:
            client.ping()
        except Exception:  # noqa: BLE001
            self.skipTest(f"no Redis at {url}")
        c = AnswerCache(test_cache.settings(ttl_replay_s=30), redis_client=client)
        q = f"smoke {time.time()}"
        self.assertTrue(c.remember(finished("smoke1", question=q), "f"))
        other = AnswerCache(test_cache.settings(), redis_client=client)
        self.assertEqual(other.lookup({"question": q}, "f").run_id, "smoke1")
        self.assertEqual(other.stats()["backend"], "redis")
        other.drop("smoke1", {"question": q}, "f")
        third = AnswerCache(test_cache.settings(), redis_client=client)
        self.assertIsNone(third.lookup({"question": q}, "f"))


if __name__ == "__main__":
    unittest.main()
