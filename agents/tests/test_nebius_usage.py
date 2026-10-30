"""Usage metering, lane check and pacer env for the Nebius backend. No network."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")

import httpx  # noqa: E402

from floodsense_agents import nightshift as ns  # noqa: E402
from floodsense_agents import tokenfactory as tf  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402

REPLY = {
    "model": "nvidia/Nemotron-x",
    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    "choices": [{"message": {"content": "OK"}, "finish_reason": "stop"}],
}
CATALOG = {
    "data": [
        {
            "id": "nvidia/Nemotron-3_5-Lightning",
            "pricing": {"prompt": "0.00000006", "completion": "0.00000024", "input_cache_read": "0.00000003"},
            "per_request_limits": {"tokens_per_minute": 2000000.0, "requests_per_minute": 1000.0},
            "regions": [{"country_code": "FI", "name": "eu-north1"}],
        },
        {
            "id": "nvidia/Nemotron-3.5-Super-VL",
            "pricing": {"prompt": "0.0000003", "completion": "0.0000009"},
            "per_request_limits": {"tokens_per_minute": 2000000.0, "requests_per_minute": 1000.0},
            "regions": [{"country_code": "US", "name": "us-north1"}],
        },
    ]
}
PRICE = ("NEBIUS_PRICE_PER_M_INPUT", "NEBIUS_PRICE_PER_M_OUTPUT")


def client(handler):
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return ns.NebiusClient(post=lambda url, **kw: http.post(url, **kw), sleep=lambda s: None)


class UsageTest(unittest.TestCase):
    def setUp(self):
        self._s = (settings.llm_backend, settings.nebius_api_key)
        settings.llm_backend, settings.nebius_api_key = "nebius", "k"
        self._env = {k: os.environ.pop(k, None) for k in PRICE}
        tf._cache = (float("inf"), {})  # no network: an empty catalog means "price not configured"

    def tearDown(self):
        settings.llm_backend, settings.nebius_api_key = self._s
        tf.reset()
        for k, v in self._env.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v

    def test_run_meter_and_cost(self):
        c = client(lambda r: httpx.Response(200, json=REPLY))
        m = ns.UsageMeter()
        tok = ns.run_meter.set(m)
        try:
            c.complete("fast", "s", "u")
            c.complete("deep", "s", "u")
            c.complete("deep", "s", "u")
        finally:
            ns.run_meter.reset(tok)
        d = m.as_dict()
        self.assertEqual(d["total"]["calls"], 3)
        self.assertEqual(d["total"]["total_tokens"], 45)
        self.assertEqual(d["lanes"]["deep"]["calls"], 2)
        self.assertIsNone(d["cost_usd"])
        self.assertEqual(d["price_note"], "price not configured")
        os.environ[PRICE[0]], os.environ[PRICE[1]] = "1", "2"
        self.assertAlmostEqual(m.as_dict()["cost_usd"], (30 * 1 + 15 * 2) / 1e6)

    def test_catalog_pricing_cost_and_lane_info(self):
        tf._cache = (float("inf"), tf.parse_models(CATALOG))
        m = ns.UsageMeter()
        m.record("fast", "nvidia/Nemotron-3_5-Lightning", {"prompt_tokens": 1000, "completion_tokens": 500}, 10)
        m.record("deep", "nvidia/Nemotron-3.5-Super-VL", {"prompt_tokens": 2000, "completion_tokens": 100}, 10)
        m.note_answer()
        d = m.as_dict()
        self.assertAlmostEqual(d["lanes"]["fast"]["cost_usd"], 1000 * 6e-8 + 500 * 2.4e-7)
        self.assertAlmostEqual(d["lanes"]["deep"]["cost_usd"], 2000 * 3e-7 + 100 * 9e-7, places=6)
        self.assertEqual(d["cost_usd"], round(d["lanes"]["fast"]["cost_usd"] + d["lanes"]["deep"]["cost_usd"], 6))
        self.assertEqual(d["cost_per_answer_usd"], d["cost_usd"])
        self.assertEqual(d["price_note"], "Token Factory list price")
        p = d["pricing"]
        self.assertEqual(p["fast"]["price_per_m_input"], 0.06)
        self.assertEqual((p["fast"]["country"], p["fast"]["region"], p["fast"]["rpm_limit"]), ("FI", "eu-north1", 1000.0))
        self.assertEqual(p["deep"]["country"], "US")

    def test_cache_read_price_only_when_reported(self):
        inf = tf.parse_models(CATALOG)["nvidia/nemotron-3_5-lightning"]
        self.assertAlmostEqual(tf.cost_usd(inf, 1000, 0, 400), 600 * 6e-8 + 400 * 3e-8)
        self.assertAlmostEqual(tf.cost_usd(inf, 1000, 0), 1000 * 6e-8)

    def test_fetch_cached_and_never_raises(self):
        tf.reset()
        calls = []

        def ok(url, **kw):
            calls.append(url)
            return httpx.Response(200, json=CATALOG)

        t = [0.0]
        self.assertIn("nvidia/nemotron-3_5-lightning", tf.catalog(get=ok, now=lambda: t[0]))
        tf.catalog(get=ok, now=lambda: t[0] + 3000)
        self.assertEqual(len(calls), 1)
        tf.catalog(get=ok, now=lambda: t[0] + 3700)
        self.assertEqual(len(calls), 2)
        tf.reset()

        def boom(url, **kw):
            raise httpx.ConnectError("down")

        self.assertEqual(tf.catalog(get=boom), {})

    def test_unpriced_model_makes_cost_null(self):
        tf._cache = (float("inf"), tf.parse_models(CATALOG))
        m = ns.UsageMeter()
        m.record("fast", "nvidia/Nemotron-3_5-Lightning", {"prompt_tokens": 10, "completion_tokens": 5}, 1)
        m.record("deep", "mystery/model", {"prompt_tokens": 10, "completion_tokens": 5}, 1)
        d = m.as_dict()
        self.assertIsNotNone(d["lanes"]["fast"]["cost_usd"])
        self.assertIsNone(d["lanes"]["deep"]["cost_usd"])
        self.assertIsNone(d["cost_usd"])

    def test_keeps_stale_table_on_failure(self):
        tf.reset()
        t = [0.0]
        good = lambda url, **kw: httpx.Response(200, json=CATALOG)  # noqa: E731
        bad = lambda url, **kw: httpx.Response(500)  # noqa: E731
        self.assertTrue(tf.catalog(get=good, now=lambda: t[0]))
        t[0] = 4000.0
        self.assertIn("nvidia/nemotron-3_5-lightning", tf.catalog(get=bad, now=lambda: t[0]))

    def test_answers_counted_once_per_run_with_calls(self):
        g = ns.GLOBAL_USAGE
        before = g.answers
        m, quiet = ns.UsageMeter(), ns.UsageMeter()
        tok = ns.run_meter.set(m)
        try:
            for _ in range(3):  # several calls (and a resume) in one run
                m.record("fast", "x", {}, 1)
        finally:
            ns.run_meter.reset(tok)
        tok = ns.run_meter.set(quiet)  # quick lane: no model call, never counted
        ns.run_meter.reset(tok)
        self.assertEqual(g.answers - before, 1)

    def test_pacer_defaults_from_limits(self):
        tf._cache = (float("inf"), tf.parse_models(CATALOG))
        ns._gate = None
        try:
            g = ns.default_gate()
            self.assertEqual((g.max_concurrency, g.interval), (8, 60 / 250))
        finally:
            ns._gate = None

    def test_check_lanes(self):
        res = ns.check_lanes(client(lambda r: httpx.Response(200, json=REPLY)))
        self.assertTrue(res["ok"])
        self.assertTrue(res["lanes"]["fast"]["nemotron"])
        res = ns.check_lanes(client(lambda r: httpx.Response(401, json={"error": "no"})))
        self.assertFalse(res["ok"])
        self.assertTrue(res["lanes"]["deep"]["error"])

    def test_pacer_env(self):
        ns._gate = None
        os.environ["NEBIUS_RPM"], os.environ["NEBIUS_MAX_CONCURRENCY"] = "120", "2"
        try:
            g = ns.default_gate()
            self.assertEqual((g.max_concurrency, g.interval), (2, 0.5))
        finally:
            ns._gate = None
            os.environ.pop("NEBIUS_RPM")
            os.environ.pop("NEBIUS_MAX_CONCURRENCY")


if __name__ == "__main__":
    unittest.main()
