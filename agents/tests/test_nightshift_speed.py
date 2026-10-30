"""Nightshift speed work: retry/timeout policy, ordered concurrency, repair skip. No network."""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")

import httpx  # noqa: E402

from floodsense_agents.models import Citation, Claim, Evidence  # noqa: E402
from floodsense_agents.nightshift import NightshiftClient, map_ordered  # noqa: E402
from floodsense_agents.nodes.judge import evaluate, needs_repair, route_after_judge  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402

URL = "http://ns.test/v1/chat/completions"


def ok_response(content: str = '{"ok": true}', model: str = "nvidia/x") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "model": model,
            "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        },
        request=httpx.Request("POST", URL),
    )


class FakePost:
    def __init__(self, script):
        self.script = list(script)
        self.calls: list[dict] = []

    def __call__(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"json": dict(json), "timeout": timeout})
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


def client(script) -> tuple[NightshiftClient, FakePost, list[float]]:
    post, sleeps = FakePost(script), []
    c = NightshiftClient(post=post, sleep=sleeps.append, jitter=lambda d: 0.0)
    c.base_url = "http://ns.test/v1"
    return c, post, sleeps


class Knobs:
    """Set settings fields for one test and restore them."""

    def __init__(self, **kw):
        self.kw, self.old = kw, {}

    def __enter__(self):
        for k, v in self.kw.items():
            self.old[k] = getattr(settings, k)
            setattr(settings, k, v)

    def __exit__(self, *exc):
        for k, v in self.old.items():
            setattr(settings, k, v)


class RetryPolicy(unittest.TestCase):
    def test_timeout_is_not_retried(self) -> None:
        c, post, sleeps = client([httpx.ReadTimeout("slow"), ok_response()])
        with Knobs(llm_max_attempts=3):
            with self.assertRaisesRegex(RuntimeError, "timeout"):
                c.complete("deep", "TASK: judge", "u")
        self.assertEqual(len(post.calls), 1)
        self.assertEqual(sleeps, [])

    def test_transient_error_retried_up_to_max_attempts(self) -> None:
        err = httpx.Response(503, text="busy", request=httpx.Request("POST", URL))
        c, post, sleeps = client([err, ok_response('{"a": 1}')])
        with Knobs(llm_max_attempts=2):
            text, model = c.complete("fast", "TASK: x", "u")
        self.assertEqual((text, model), ('{"a": 1}', "nvidia/x"))
        self.assertEqual(len(post.calls), 2)
        self.assertEqual(sleeps, [1.5])

    def test_gives_up_after_max_attempts(self) -> None:
        errs = [httpx.ConnectError("down") for _ in range(5)]
        c, post, sleeps = client(errs)
        with Knobs(llm_max_attempts=2):
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                c.complete("fast", "TASK: x", "u")
        self.assertEqual(len(post.calls), 2)
        self.assertEqual(sleeps, [1.5])  # no sleep after the last attempt

    def test_truncated_reply_is_an_error_not_retried(self) -> None:
        cut = httpx.Response(
            200,
            json={
                "model": "nvidia/x",
                "choices": [
                    {"message": {"content": '{"grounding": "sup'}, "finish_reason": "length"}
                ],
            },
            request=httpx.Request("POST", URL),
        )
        c, post, sleeps = client([cut, ok_response()])
        with Knobs(llm_max_attempts=3):
            with self.assertRaisesRegex(RuntimeError, "cut off"):
                c.complete("deep", "TASK: judge", "u")
        self.assertEqual(len(post.calls), 1)
        self.assertEqual(sleeps, [])

    def test_429_honours_retry_after_capped(self) -> None:
        def r429(after: str) -> httpx.Response:
            return httpx.Response(
                429, headers={"retry-after": after}, request=httpx.Request("POST", URL)
            )

        # Retry-After wins (capped at 10 s); junk falls back to 2 s * 2^n.
        c, post, sleeps = client([r429("3"), r429("soon"), r429("120"), ok_response()])
        with Knobs(llm_max_attempts=1, llm_slow_fail_s=60.0):
            c.complete("fast", "TASK: x", "u")
        self.assertEqual(len(post.calls), 4)
        self.assertEqual(sleeps, [3.0, 4.0, 10.0])

    def test_slow_gateway_error_is_not_retried(self) -> None:
        err = httpx.Response(502, text="bad gateway", request=httpx.Request("POST", URL))
        c, post, sleeps = client([err, ok_response()])
        with Knobs(llm_max_attempts=3, llm_slow_fail_s=0.0):
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                c.complete("fast", "TASK: x", "u")
        self.assertEqual(len(post.calls), 1)
        self.assertEqual(sleeps, [])

    def test_json_mode_downgrade_is_not_an_attempt(self) -> None:
        bad = httpx.Response(
            400, text="unknown field response_format", request=httpx.Request("POST", URL)
        )
        c, post, _ = client([bad, ok_response()])
        with Knobs(llm_max_attempts=1):
            c.complete("fast", "TASK: x", "u")
        self.assertIn("response_format", post.calls[0]["json"])
        self.assertNotIn("response_format", post.calls[1]["json"])

    def test_max_tokens_per_lane_and_timeout(self) -> None:
        c, post, _ = client([ok_response(), ok_response(), ok_response()])
        with Knobs(llm_max_tokens_fast=111, llm_max_tokens_deep=222, llm_timeout_s=42.0):
            c.complete("fast", "TASK: x", "u")
            c.complete("deep", "TASK: x", "u")
        with Knobs(llm_max_tokens_fast=0):
            c.complete("fast", "TASK: x", "u")
        self.assertEqual(post.calls[0]["json"]["max_tokens"], 111)
        self.assertEqual(post.calls[1]["json"]["max_tokens"], 222)
        self.assertNotIn("max_tokens", post.calls[2]["json"])
        self.assertAlmostEqual(post.calls[0]["timeout"], 42.0, places=2)


class MapOrdered(unittest.TestCase):
    def test_order_kept_when_later_items_finish_first(self) -> None:
        def slow_first(i: int) -> int:
            time.sleep(0.05 * (5 - i))
            return i * 10

        with Knobs(llm_max_parallel=5):
            t = time.time()
            self.assertEqual(map_ordered(slow_first, range(5)), [0, 10, 20, 30, 40])
            self.assertLess(time.time() - t, 0.6)  # serial would be 0.75 s

    def test_runs_concurrently(self) -> None:
        active, peak = [0], [0]
        lock = threading.Lock()

        def f(i: int) -> str:
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.05)
            with lock:
                active[0] -= 1
            return str(i)

        with Knobs(llm_max_parallel=4):
            out = map_ordered(f, range(4))
        self.assertEqual(out, ["0", "1", "2", "3"])
        self.assertGreater(peak[0], 1)

    def test_parallel_one_is_serial(self) -> None:
        with Knobs(llm_max_parallel=1):
            self.assertEqual(map_ordered(lambda x: x + 1, [1, 2]), [2, 3])


class SlowLLM:
    """Answers judge calls out of order: the first claim is the slowest."""

    def __init__(self):
        self.lock = threading.Lock()
        self.calls = 0

    def complete(self, lane, system, user, *, json=True):
        cid = user.split(":", 1)[0].replace("CLAIM", "").strip()
        n = int(cid[1:])
        time.sleep(0.02 * (6 - n))
        with self.lock:
            self.calls += 1
        g = "partial" if n % 2 else "supported"
        return f'{{"grounding": "{g}", "rationale": "r{cid}"}}', f"m-{cid}"


def _ev(qid: str) -> Evidence:
    return Evidence(
        query_id=qid,
        view="floodsense_seed.hazard_timeline",
        sql="SELECT 1",
        rows_sample=[{"v": 5}],
        row_count=1,
        executed_at_utc="2026-10-22T20:00:00Z",
    )


class JudgeConcurrency(unittest.TestCase):
    def test_scores_in_claim_order_same_as_serial(self) -> None:
        evidence = {f"q{i}": _ev(f"q{i}") for i in range(1, 6)}
        claims = [
            Claim(
                claim_id=f"C{i}",
                text=f"value 5 at {i}",
                numbers=[5.0],
                citations=[
                    Citation(citation_id=f"X{i}", claim_id=f"C{i}", layer="a", query_id=f"q{i}")
                ],
            )
            for i in range(1, 6)
        ]
        deps = Deps(zetaris=FakeZetaris(), llm=SlowLLM(), memory=NoMemory())
        with Knobs(llm_max_parallel=1):
            serial, s_sum = evaluate(claims, evidence, deps)
        with Knobs(llm_max_parallel=5):
            par, p_sum = evaluate(claims, evidence, deps)
        self.assertEqual([s.model_dump() for s in serial], [s.model_dump() for s in par])
        self.assertEqual(s_sum.model_dump(), p_sum.model_dump())
        self.assertEqual([s.claim_id for s in par], ["C1", "C2", "C3", "C4", "C5"])


class RepairSkip(unittest.TestCase):
    def state(self, passes: bool) -> dict:
        return {"judge_summary": {"flagged_claim_ids": ["C2"], "passes": passes}}

    def test_passing_run_goes_to_human(self) -> None:
        with Knobs(judge_repair_when_passing=False, judge_repair_rounds=1):
            self.assertFalse(needs_repair(self.state(True)))
            self.assertEqual(route_after_judge(self.state(True)), "hitl")
            self.assertEqual(route_after_judge(self.state(False)), "repair")

    def test_old_behaviour_behind_the_knob(self) -> None:
        with Knobs(judge_repair_when_passing=True, judge_repair_rounds=1):
            self.assertEqual(route_after_judge(self.state(True)), "repair")

    def test_no_round_left(self) -> None:
        with Knobs(judge_repair_rounds=1):
            s = {**self.state(False), "repair_rounds": 1}
            self.assertEqual(route_after_judge(s), "hitl")


if __name__ == "__main__":
    unittest.main()
