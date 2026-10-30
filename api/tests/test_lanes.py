"""Router lanes at the API: lane passes through, quick answers are cached, replies cost a token."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as api  # noqa: E402
from app.cache import AnswerCache, CacheSettings, finished_well  # noqa: E402
from app.project import project_run  # noqa: E402
from app.ratelimit import RateLimiter, RateLimitSettings  # noqa: E402

CONFIG = {
    "flags": {"FF_LIVE_DATA": True, "FF_JUDGE": True, "FF_HITL": True},
    "lanes": {"fast": "meterless/fast", "deep": "meterless/deep"},
    "schema": "floodsense",
}
QUESTION = "How high is the Rhine at Köln?"


def quick_run(run_id: str = "q1") -> dict:
    return {
        "run_id": run_id,
        "thread_id": run_id,
        "status": "answered",
        "lane": "quick",
        "router_reason": "chose quick: live level question about KÖLN",
        "request": {"question": QUESTION, "customer_id": "demo-insurer", "lang": "en"},
        "served_from": "live",
        "cached_at": None,
        "claims": [
            {
                "claim_id": "Q1",
                "text": "The Rhine at KÖLN reads 412 cm.",
                "citations": [
                    {
                        "citation_id": "Q1-a1",
                        "claim_id": "Q1",
                        "layer": "a",
                        "query_id": "g1",
                        "title": "floodsense.gauge_levels",
                        "source_url": "https://www.pegelonline.wsv.de/",
                        "publisher": "WSV",
                        "licence": "DL-DE->Zero-2.0",
                        "attribution": "WSV, PEGELONLINE",
                        "accessed_at": "2026-10-27T09:00:00Z",
                    }
                ],
            }
        ],
        "evidence": {
            "g1": {
                "query_id": "g1",
                "view": "floodsense.gauge_levels",
                "sql": "SELECT * FROM floodsense.gauge_levels",
                "rows_sample": [{"station": "KÖLN", "level_cm": 412}],
                "row_count": 1,
                "executed_at_utc": "2026-10-27T09:00:00Z",
            }
        },
        "judge": [],
        "judge_summary": {"passes": True, "overall": 1.0},
        "approval": {"status": "not_reached"},
        "trace": [{"node": "router", "summary": "chose quick: live level question about KÖLN"}],
    }


class ProjectionTest(unittest.TestCase):
    def test_lane_and_reason_pass_through(self) -> None:
        answer = project_run(quick_run())["answer"]
        self.assertEqual(answer["lane"], "quick")
        self.assertIn("KÖLN", answer["router_reason"])

    def test_quick_lane_flag_is_in_the_cache_fingerprint(self) -> None:
        from app.cache import fingerprint

        on = fingerprint({"flags": {"FF_QUICK_LANE": True}})
        self.assertIn("FF_QUICK_LANE=True", on)
        self.assertNotEqual(on, fingerprint({"flags": {"FF_QUICK_LANE": False}}))

    def test_unknown_lane_is_left_out(self) -> None:
        body = quick_run()
        body["lane"] = "sideways"
        self.assertNotIn("lane", project_run(body)["answer"])

    def test_quick_answer_qualifies_for_the_cache(self) -> None:
        self.assertTrue(finished_well(quick_run()))
        failing = quick_run()
        failing["judge_summary"] = {"passes": False}
        self.assertFalse(finished_well(failing))
        full = quick_run()
        full["lane"] = "full"
        self.assertFalse(finished_well(full))  # a full run still needs a person


def forecast_run(run_id: str = "f1") -> dict:
    run = quick_run(run_id)
    run["lane"] = "forecast"
    run["router_reason"] = "chose forecast: forecast question ('next 48 hours') about KÖLN"
    run["forecast"] = {
        "status": "Normal",
        "places": ["KÖLN"],
        "horizon_h": 48,
        "outlook": "Calm at KÖLN.",
        "outlook_label": "Outlook (model-written)",
        "disclaimer": "This is a model outlook, not an official warning; follow DWD warnings.",
    }
    return run


class ForecastLaneTest(unittest.TestCase):
    def test_forecast_lane_and_status_pass_through(self) -> None:
        answer = project_run(forecast_run())["answer"]
        self.assertEqual(answer["lane"], "forecast")
        self.assertEqual(answer["forecast"]["status"], "Normal")
        self.assertIn("not an official warning", answer["forecast"]["disclaimer"])

    def test_forecast_answer_is_cached_like_a_quick_one(self) -> None:
        self.assertTrue(finished_well(forecast_run()))
        from app.cache import quick_answered

        self.assertTrue(quick_answered(forecast_run()))
        escalated = forecast_run()
        escalated["status"] = "awaiting_approval"
        self.assertFalse(quick_answered(escalated))

    def test_forecast_object_only_on_the_forecast_lane(self) -> None:
        body = forecast_run()
        body["lane"] = "full"
        self.assertNotIn("forecast", project_run(body)["answer"])

    def test_plain_object_passes_through_on_quick_and_forecast_only(self) -> None:
        plain = {
            "headline": "Nothing alarming expected at Köln.",
            "one_line": "The Rhine at Köln is below its usual high-water mark.",
            "horizon": "48h",
            "status": "normal",
            "next_step": "Ask me about another place or open the official warnings.",
            "disclaimer": "Model-based check, not an official warning. Follow DWD.",
            "details": ["Q1"],
        }
        for lane, make in (("forecast", forecast_run), ("quick", quick_run)):
            body = make()
            body["plain"] = plain
            self.assertEqual(project_run(body)["answer"]["plain"], plain, lane)
        body = forecast_run()
        body["plain"] = plain
        body["lane"] = "full"
        self.assertNotIn("plain", project_run(body)["answer"])
        body = forecast_run()
        body["plain"] = {}
        self.assertNotIn("plain", project_run(body)["answer"])

    def test_forecast_flag_is_in_the_cache_fingerprint(self) -> None:
        from app.cache import fingerprint

        on = fingerprint({"flags": {"FF_FORECAST_LANE": True}})
        self.assertNotEqual(on, fingerprint({"flags": {"FF_FORECAST_LANE": False}}))


class QuickCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        self.runs = {"q1": quick_run()}
        self.posts = 0

        async def agents(method, path, body=None, params=None, timeout=None):
            if path == "/config":
                return httpx.Response(200, json=CONFIG)
            if path == "/front-door":
                q = (body or {}).get("question")
                if q == "hello":
                    return httpx.Response(
                        200,
                        json={
                            "kind": "reply",
                            "lane": "reply",
                            "intent": "greeting",
                            "answer": "Hello!",
                            "suggestions": [],
                            "model_id": "rules",
                            "latency_ms": 1,
                        },
                    )
                return httpx.Response(200, json={"kind": "run"})
            if path == "/runs" and method == "POST":
                self.posts += 1
                return httpx.Response(201, json=self.runs["q1"])
            if path.startswith("/runs/"):
                return httpx.Response(200, json=self.runs[path.split("/")[2]])
            return httpx.Response(404, json={})

        cache = AnswerCache(
            CacheSettings(
                semantic_cache=True, cached_replay=False, ttl_live_s=900, ttl_replay_s=86400
            )
        )
        self.limiter = RateLimiter(
            RateLimitSettings(runs_per_min=3, max_concurrent_runs=2, concurrency_retry_after_s=5),
            clock=lambda: 0.0,
        )
        for p in (
            mock.patch.object(api, "_agents_request", side_effect=agents),
            mock.patch.object(api, "cache", cache),
            mock.patch.object(api, "limiter", self.limiter),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.c = TestClient(api.app)

    def test_repeat_quick_question_is_served_from_cache(self) -> None:
        first = self.c.post("/runs", json={"question": QUESTION})
        self.assertEqual(first.status_code, 201)
        self.assertEqual(first.json()["contract"]["answer"]["lane"], "quick")
        second = self.c.post("/runs", json={"question": QUESTION})
        self.assertEqual(second.status_code, 200)
        body = second.json()
        self.assertEqual(self.posts, 1)
        self.assertEqual(body["served_from"], "cache")
        self.assertEqual(body["label"]["kind"], "cache")
        self.assertIn("Cached answer", body["label"]["text"])
        self.assertIsNotNone(body["cached_at"])
        self.assertEqual(body["contract"]["answer"]["served_from"], "cache")
        self.assertEqual(body["contract"]["answer"]["lane"], "quick")
        self.assertEqual(body["lane"], "quick")
        self.assertEqual(body["cache"]["expires_in_s"], 900)  # the live TTL

    def test_repeated_replies_spend_bucket_tokens(self) -> None:
        for _ in range(3):
            r = self.c.post("/runs", json={"question": "hello"})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["lane"], "reply")
        self.assertEqual(self.c.post("/runs", json={"question": "hello"}).status_code, 429)


if __name__ == "__main__":
    unittest.main()
