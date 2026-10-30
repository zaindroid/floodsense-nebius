"""Nightshift rate-limit backoff, concurrency cap and pacer. Fake transport, no network."""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")

import httpx  # noqa: E402

from floodsense_agents.nightshift import (  # noqa: E402
    CallGate,
    GateTimeout,
    NightshiftClient,
    call_deadline,
    classify_error,
)
from floodsense_agents.settings import settings  # noqa: E402

URL = "http://ns.test/v1/chat/completions"
REQ = httpx.Request("POST", URL)
BODY_429 = (
    '{"error":{"code":"provider_error","meterless_detail":'
    '"nvidia_429: {\\"status\\":429,\\"title\\":\\"Too Many Requests\\"}"}}'
)
BODY_EMPTY = (
    '{"error":{"code":"provider_error","meterless_detail":'
    '"nemotron-3.5-lightning-30b-a3b_empty_response"}}'
)
BODY_DEADLINE = '{"error":{"code":"provider_deadline","meterless_detail":"45s"}}'


def ok() -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "model": "nvidia/x",
            "choices": [{"message": {"content": "{}"}, "finish_reason": "stop"}],
        },
        request=REQ,
    )


def r502(body: str) -> httpx.Response:
    return httpx.Response(502, text=body, request=REQ)


class Clock:
    """Fake monotonic clock; ``sleep`` advances it and records the wait."""

    def __init__(self) -> None:
        self.t = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.t += s


class Script:
    def __init__(self, steps) -> None:
        self.steps = list(steps)
        self.calls: list[dict] = []

    def __call__(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"timeout": timeout})
        step = self.steps.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


def make(steps, gate=None):
    clock, post = Clock(), Script(steps)
    c = NightshiftClient(post=post, sleep=clock.sleep, clock=clock, gate=gate, jitter=lambda d: 0.0)
    c.base_url = "http://ns.test/v1"
    return c, post, clock


class Knobs:
    def __init__(self, **kw):
        self.kw, self.old = kw, {}

    def __enter__(self):
        for k, v in self.kw.items():
            self.old[k] = getattr(settings, k)
            setattr(settings, k, v)

    def __exit__(self, *exc):
        for k, v in self.old.items():
            setattr(settings, k, v)


class Classify(unittest.TestCase):
    def test_kinds(self) -> None:
        self.assertEqual(classify_error(502, BODY_429), "rate_limited")
        self.assertEqual(classify_error(429, ""), "rate_limited")
        self.assertEqual(classify_error(502, BODY_EMPTY), "empty_response")
        self.assertEqual(classify_error(502, BODY_DEADLINE), "provider_deadline")
        self.assertEqual(classify_error(502, "bad gateway"), "other")


class Backoff(unittest.TestCase):
    def test_429_body_retries_then_succeeds(self) -> None:
        c, post, clock = make([r502(BODY_429), r502(BODY_429), ok()])
        with Knobs(llm_max_attempts=1, llm_timeout_s=180.0):
            with self.assertLogs("floodsense.nightshift", "INFO") as logs:
                text, model = c.complete("fast", "TASK: x", "u")
        self.assertEqual(model, "nvidia/x")
        self.assertEqual(len(post.calls), 3)
        self.assertEqual(clock.sleeps, [2.0, 4.0])
        self.assertIn("retried 2\u00d7 after rate limit", logs.output[-1])

    def test_empty_response_retries(self) -> None:
        c, post, clock = make([r502(BODY_EMPTY), ok()])
        with Knobs(llm_max_attempts=1):
            c.complete("fast", "TASK: x", "u")
        self.assertEqual(len(post.calls), 2)

    def test_stream_empty_response_retries(self) -> None:
        c, post, clock = make([ValueError("stream provider_error: " + BODY_EMPTY), ok()])
        with Knobs(llm_max_attempts=1):
            c.complete("fast", "TASK: x", "u")
        self.assertEqual(len(post.calls), 2)

    def test_provider_deadline_is_not_retried(self) -> None:
        c, post, clock = make([r502(BODY_DEADLINE), ok()])
        with Knobs(llm_max_attempts=3, llm_slow_fail_s=60.0):
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                c.complete("deep", "TASK: judge", "u")
        self.assertEqual(len(post.calls), 1)
        self.assertEqual(clock.sleeps, [])

    def test_max_three_retries(self) -> None:
        c, post, clock = make([r502(BODY_429)] * 6)
        with Knobs(llm_max_attempts=1, llm_timeout_s=180.0):
            with self.assertRaises(RuntimeError):
                c.complete("fast", "TASK: x", "u")
        self.assertEqual(len(post.calls), 4)
        self.assertEqual(clock.sleeps, [2.0, 4.0, 8.0])

    def test_total_wait_capped(self) -> None:
        def r(after):
            return httpx.Response(429, headers={"retry-after": after}, request=REQ)

        c, post, clock = make([r("10"), r("10"), r("10"), ok()])
        with Knobs(llm_max_attempts=1, llm_timeout_s=180.0):
            with self.assertRaises(RuntimeError):
                c.complete("fast", "TASK: x", "u")
        self.assertLessEqual(sum(clock.sleeps), 20.0)
        self.assertEqual(clock.sleeps, [10.0, 10.0])

    def test_backoff_respects_call_deadline(self) -> None:
        # 5 s budget: the 2 s wait fits, the 4 s one would overrun it.
        c, post, clock = make([r502(BODY_429)] * 4)
        with Knobs(llm_max_attempts=1, llm_timeout_s=5.0):
            with self.assertRaises(RuntimeError):
                c.complete("fast", "TASK: x", "u")
        self.assertEqual(clock.sleeps, [2.0])
        self.assertLessEqual(sum(clock.sleeps), 5.0)
        # Each attempt's timeout is what is left of the budget.
        self.assertEqual([p["timeout"] for p in post.calls], [5.0, 3.0])

    def test_context_deadline_respected(self) -> None:
        c, post, clock = make([r502(BODY_429), ok()])
        tok = call_deadline.set(clock() + 2.5)
        try:
            with Knobs(llm_max_attempts=1, llm_timeout_s=180.0):
                with self.assertRaises(RuntimeError):
                    c.complete("fast", "TASK: router", "u")
        finally:
            call_deadline.reset(tok)
        self.assertEqual(len(post.calls), 1)  # a 2 s wait would leave < 1 s
        self.assertEqual(clock.sleeps, [])


class Gate(unittest.TestCase):
    def test_cap_limits_parallel_calls(self) -> None:
        gate = CallGate(max_concurrency=2, rpm=0)
        lock, live, peak = threading.Lock(), [0], [0]

        def post(url, json=None, headers=None, timeout=None):
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
            time.sleep(0.05)
            with lock:
                live[0] -= 1
            return ok()

        c = NightshiftClient(post=post, gate=gate)
        c.base_url = "http://ns.test/v1"
        with ThreadPoolExecutor(max_workers=6) as ex:
            list(ex.map(lambda _: c.complete("fast", "TASK: x", "u"), range(6)))
        self.assertEqual(peak[0], 2)

    def test_pacer_spaces_calls(self) -> None:
        clock = Clock()
        gate = CallGate(max_concurrency=5, rpm=30, clock=clock, sleep=clock.sleep)  # 2 s apart
        starts = []
        for _ in range(3):
            gate.acquire()
            starts.append(clock())
            gate.release()
        self.assertEqual([b - a for a, b in zip(starts, starts[1:])], [2.0, 2.0])

    def test_pacer_slot_past_deadline_raises(self) -> None:
        clock = Clock()
        gate = CallGate(max_concurrency=5, rpm=30, clock=clock, sleep=clock.sleep)
        gate.acquire()
        gate.release()
        with self.assertRaises(GateTimeout):
            gate.acquire(deadline=clock() + 1.0)  # next slot is 2 s away
        gate.acquire(deadline=clock() + 3.0)  # the failed wait did not book a slot
        gate.release()

    def test_waiting_for_a_slot_counts_against_the_deadline(self) -> None:
        gate = CallGate(max_concurrency=1, rpm=0)
        gate.acquire()  # the only slot is busy
        try:
            c = NightshiftClient(post=lambda *a, **k: ok(), gate=gate)
            c.base_url = "http://ns.test/v1"
            tok = call_deadline.set(time.monotonic() + 0.1)
            try:
                t0 = time.monotonic()
                with self.assertRaises(GateTimeout):
                    c.complete("fast", "TASK: router", "u")
                self.assertLess(time.monotonic() - t0, 1.0)
            finally:
                call_deadline.reset(tok)
        finally:
            gate.release()


if __name__ == "__main__":
    unittest.main()
