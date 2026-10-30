"""Nebius Token Factory backend over httpx.MockTransport. No network."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")

import httpx  # noqa: E402

from floodsense_agents.nightshift import FakeNightshift, NebiusClient, build_llm  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402

REPLY = {
    "model": "nvidia/x",
    "choices": [{"message": {"content": '{"a":1}'}, "finish_reason": "stop"}],
}


def client(handler, sleeps=None):
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return NebiusClient(
        post=lambda url, **kw: http.post(url, **kw),
        sleep=(sleeps if sleeps is not None else []).append,
        jitter=lambda d: 0.0,
    )


class NebiusTest(unittest.TestCase):
    def setUp(self):
        self._saved = (settings.llm_backend, settings.nebius_api_key, settings.llm_mode)
        settings.llm_backend, settings.nebius_api_key = "nebius", "k-secret"
        settings.llm_mode = "auto"

    def tearDown(self):
        settings.llm_backend, settings.nebius_api_key, settings.llm_mode = self._saved

    def test_success_and_json_mode(self):
        seen = {}

        def h(req):
            seen["req"], seen["body"] = req, json.loads(req.content)
            return httpx.Response(200, json=REPLY)

        text, model = client(h).complete("deep", "s", "u")
        self.assertEqual((text, model), ('{"a":1}', "nvidia/x"))
        self.assertEqual(seen["req"].headers["authorization"], "Bearer k-secret")
        self.assertEqual(seen["req"].url.path, "/v1/chat/completions")
        self.assertEqual(seen["body"]["response_format"], {"type": "json_object"})
        self.assertEqual(seen["body"]["model"], settings.nebius_model_deep)
        client(h).complete("fast", "s", "u", json=False)
        self.assertNotIn("response_format", seen["body"])
        self.assertEqual(seen["body"]["model"], settings.nebius_model_fast)

    def test_429_backoff_then_ok(self):
        n, sleeps = [0], []

        def h(req):
            n[0] += 1
            if n[0] < 3:
                return httpx.Response(429, text="Too Many Requests")
            return httpx.Response(200, json=REPLY)

        self.assertEqual(client(h, sleeps).complete("fast", "s", "u")[0], '{"a":1}')
        self.assertEqual(sleeps, [2.0, 4.0])

    def test_5xx_retries_then_fails(self):
        n = [0]

        def h(req):
            n[0] += 1
            return httpx.Response(503, text="down")

        with self.assertRaises(RuntimeError):
            client(h).complete("fast", "s", "u")
        self.assertEqual(n[0], settings.llm_max_attempts)

    def test_json_mode_downgrade(self):
        bodies = []

        def h(req):
            b = json.loads(req.content)
            bodies.append(b)
            if "response_format" in b:
                return httpx.Response(400, text="unsupported response_format")
            return httpx.Response(200, json=REPLY)

        client(h).complete("fast", "s", "u")
        self.assertEqual(len(bodies), 2)

    def test_missing_key_fails_without_leaking(self):
        settings.nebius_api_key = ""
        with self.assertRaisesRegex(RuntimeError, "NEBIUS_API_KEY"):
            build_llm()
        settings.nebius_api_key = "k-secret"
        self.assertIsInstance(build_llm(), NebiusClient)
        settings.llm_mode = "fake"
        self.assertIsInstance(build_llm(), FakeNightshift)


if __name__ == "__main__":
    unittest.main()
