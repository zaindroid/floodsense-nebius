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
from floodsense_agents.settings import settings  # noqa: E402

REPLY = {
    "model": "nvidia/Nemotron-x",
    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    "choices": [{"message": {"content": "OK"}, "finish_reason": "stop"}],
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

    def tearDown(self):
        settings.llm_backend, settings.nebius_api_key = self._s
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
