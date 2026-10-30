"""Nightshift client. Every model call goes through here.

    complete(lane, system, user, *, json=True) -> (text, model_id)

``lane`` is "fast" or "deep" and picks ``MODEL_FAST`` / ``MODEL_DEEP``
(``meterless/fast`` and ``meterless/deep``). Nightshift chooses the model.
The model id that answered comes back so the trace and the Judge scores can
record it. FakeNightshift answers offline with deterministic JSON, so tests
and the UI need no credits.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from contextvars import ContextVar, copy_context
from json import loads as _loads
from typing import Callable, Iterable, Protocol, TypeVar

import httpx

from floodsense_agents.settings import settings

log = logging.getLogger("floodsense.nightshift")


class LLM(Protocol):
    def complete(
        self, lane: str, system: str, user: str, *, json: bool = True
    ) -> tuple[str, str]: ...


def parse_json(text: str) -> dict:
    """First JSON object in a model reply; tolerates ``` fences and prose around it."""
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.S)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    start, depth = t.find("{"), 0
    for i in range(start, len(t)) if start >= 0 else []:
        depth += t[i] == "{"
        depth -= t[i] == "}"
        if depth == 0:
            return json.loads(t[start : i + 1])
    raise ValueError(f"no JSON object in reply: {text[:160]!r}")


T = TypeVar("T")
R = TypeVar("R")


def map_ordered(fn: Callable[[T], R], items: Iterable[T]) -> list[R]:
    """``[fn(x) for x in items]`` on up to ``llm_max_parallel`` threads.

    Results come back in input order, so traces and scores stay deterministic.
    Each task runs in a copy of the caller's context: the caller's
    ContextVars must reach the worker threads. ``fn`` should not raise; if it
    does, the first exception (in input order) propagates.
    """
    xs = list(items)
    limit = max(1, int(settings.llm_max_parallel))
    if limit == 1 or len(xs) <= 1:
        return [fn(x) for x in xs]
    with ThreadPoolExecutor(max_workers=min(limit, len(xs))) as ex:
        futs = [ex.submit(copy_context().run, fn, x) for x in xs]
        return [f.result() for f in futs]


def stream_post(url: str, *, json: dict, headers: dict, timeout: float) -> httpx.Response:
    """``httpx.post`` for chat completions, sent as a stream (SSE).

    Returns an ``httpx.Response`` shaped like the non-streamed reply
    (``choices[0].message.content``, ``finish_reason``, ``model``, ``usage``),
    so the retry policy in ``_send`` is unchanged. A non-200 comes back as
    is; a stream that closes with no answer raises ValueError (transient).
    The gateway's ~45 s 502 cuts non-streamed requests only.
    """
    payload = {**json, "stream": True, "stream_options": {"include_usage": True}}
    req = httpx.Request("POST", url)
    with httpx.stream("POST", url, json=payload, headers=headers, timeout=timeout) as r:
        if r.status_code != 200:
            r.read()
            return httpx.Response(r.status_code, content=r.content, headers=r.headers, request=req)
        parts: list[str] = []
        finish = model = usage = None
        stray: list[str] = []  # error events or non-SSE lines, for the error message
        # httpx's timeout is per read: pings or trickled tokens would keep a
        # worker here far past llm_timeout_s. One deadline for the whole call;
        # a timeout is final in _send (not retried).
        deadline = time.monotonic() + timeout
        for line in r.iter_lines():
            if time.monotonic() > deadline:
                raise httpx.ReadTimeout(f"stream exceeded {timeout:.0f}s", request=req)
            if not line.startswith("data:"):
                if line.strip() and not line.startswith((":", "event:", "id:", "retry:")):
                    stray.append(line.strip()[:160])
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            chunk = _loads(data)
            if chunk.get("error"):
                # An error event, even after some content, is a failed reply:
                # never hand truncated text on as a success.
                raise ValueError(f"stream provider_error: {str(chunk['error'])[:400]}")
            model = chunk.get("model") or model
            usage = chunk.get("usage") or usage
            for ch in chunk.get("choices") or []:
                piece = (ch.get("delta") or {}).get("content")
                if piece:
                    parts.append(piece)
                finish = ch.get("finish_reason") or finish
    if not (parts or finish):
        # The stream closed before any answer (seen at ~45 s on Nightshift).
        # ValueError: _send's transient-error path decides on a retry.
        raise ValueError(
            f"stream ended without an answer: {' | '.join(stray[-2:])[:500] or 'no data'}"
        )
    out = {
        "model": model,
        "usage": usage,
        "choices": [{"message": {"content": "".join(parts)}, "finish_reason": finish}],
    }
    return httpx.Response(200, json=out, request=req)


# --- Rate limits ----------------------------------------------------------
# NVIDIA's free tier allows 40 requests/min per key. A full run fans out
# (Investigator links, Skeptic, Judge, repairs) and used to burst past it, so
# Nightshift answered 502 provider_error nvidia_429 to most calls. Every
# Nightshift call now passes a process-wide gate: at most
# NIGHTSHIFT_MAX_CONCURRENCY in flight, paced to NIGHTSHIFT_RPM starts/min.

call_deadline: ContextVar[float | None] = ContextVar("nightshift_call_deadline", default=None)
"""Absolute ``time.monotonic()`` deadline for the current call, if the caller has one."""


class GateTimeout(RuntimeError):
    """No slot (concurrency or pace) before the caller's deadline."""


class CallGate:
    """A semaphore (max calls in flight) plus a pacer (min spacing between starts).

    The pacer is a token bucket of capacity 1 refilled every ``60/rpm`` s: call
    starts are spaced evenly, so a burst of N calls takes ``(N-1)*60/rpm`` s and
    a minute never sees more than ``rpm`` starts. ``rpm <= 0`` turns pacing off.
    """

    def __init__(
        self,
        max_concurrency: int = 3,
        rpm: float = 35.0,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.max_concurrency = max(1, int(max_concurrency))
        self.interval = 60.0 / rpm if rpm > 0 else 0.0
        self._sem = threading.BoundedSemaphore(self.max_concurrency)
        self._lock = threading.Lock()
        self._next = 0.0  # earliest start of the next call (clock time)
        self._clock, self._sleep = clock, sleep

    def acquire(self, deadline: float | None = None) -> float:
        """Take a slot; returns seconds waited. Raises GateTimeout past ``deadline``."""
        t0 = self._clock()
        if deadline is None:
            self._sem.acquire()
        elif not self._sem.acquire(timeout=max(0.0, deadline - t0)):
            raise GateTimeout("no Nightshift slot before the deadline")
        try:
            if self.interval:
                with self._lock:
                    now = self._clock()
                    start = max(now, self._next)
                    if deadline is not None and start > deadline:
                        raise GateTimeout("Nightshift pacer slot is past the deadline")
                    self._next = start + self.interval
                if start > now:
                    self._sleep(start - now)
        except BaseException:
            self._sem.release()
            raise
        return self._clock() - t0

    def release(self) -> None:
        self._sem.release()


def _env_num(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


_gate: CallGate | None = None
_gate_lock = threading.Lock()


def default_gate() -> CallGate:
    """The process-wide gate, built once. NIGHTSHIFT_* or, with LLM_BACKEND=nebius, NEBIUS_MAX_CONCURRENCY / NEBIUS_RPM."""
    global _gate
    with _gate_lock:
        if _gate is None:
            if settings.llm_backend == "nebius":
                # Token Factory limits are not verified; NEBIUS_* override these defaults.
                _gate = CallGate(
                    int(_env_num("NEBIUS_MAX_CONCURRENCY", 4)), _env_num("NEBIUS_RPM", 60)
                )
            else:
                _gate = CallGate(
                    int(_env_num("NIGHTSHIFT_MAX_CONCURRENCY", 3)), _env_num("NIGHTSHIFT_RPM", 35)
                )
        return _gate


# --- Usage metering --------------------------------------------------------
class UsageMeter:
    """Tokens, calls and latency per (lane, model id), from the OpenAI ``usage`` of each reply."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rows: dict[tuple[str, str], dict[str, int]] = {}

    def record(self, lane: str, model: str, usage: dict | None, latency_ms: int) -> None:
        u = usage or {}
        with self._lock:
            r = self._rows.setdefault(
                (lane, model),
                {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "latency_ms": 0},
            )
            r["calls"] += 1
            r["latency_ms"] += latency_ms
            for k in ("prompt_tokens", "completion_tokens"):
                r[k] += int(u.get(k) or 0)
            r["total_tokens"] += int(u.get("total_tokens") or 0) or int(u.get("prompt_tokens") or 0) + int(
                u.get("completion_tokens") or 0
            )

    def as_dict(self) -> dict:
        """{lanes: {lane: {...}}, models: [...], total: {...}, cost_usd, price_note}."""
        pin, pout = _price("NEBIUS_PRICE_PER_M_INPUT"), _price("NEBIUS_PRICE_PER_M_OUTPUT")
        priced = pin is not None and pout is not None
        with self._lock:
            rows = {k: dict(v) for k, v in self._rows.items()}
        keys = ("calls", "prompt_tokens", "completion_tokens", "total_tokens", "latency_ms")
        lanes: dict[str, dict] = {}
        models = []
        total = dict.fromkeys(keys, 0)
        for (lane, model), r in sorted(rows.items()):
            models.append({"lane": lane, "model_id": model, **r})
            for tgt in (lanes.setdefault(lane, dict.fromkeys(keys, 0)), total):
                for k in keys:
                    tgt[k] += r[k]
        for t in (*lanes.values(), total):
            t["avg_latency_ms"] = round(t["latency_ms"] / t["calls"]) if t["calls"] else None
        cost = None
        if priced:
            cost = round((total["prompt_tokens"] * pin + total["completion_tokens"] * pout) / 1e6, 6)
        return {
            "lanes": lanes,
            "models": models,
            "total": total,
            "cost_usd": cost,
            "price_note": "estimate from NEBIUS_PRICE_PER_M_INPUT/OUTPUT" if priced else "price not configured",
        }


def _price(name: str) -> float | None:
    try:
        v = float(os.environ.get(name) or "")
    except ValueError:
        return None
    return v if v >= 0 and v == v and v != float("inf") else None


GLOBAL_USAGE = UsageMeter()  # this agents process since start
run_meter: ContextVar[UsageMeter | None] = ContextVar("nightshift_run_meter", default=None)


def submit_with_deadline(pool, timeout: float, fn: Callable[..., R], *args) -> Future:
    """``pool.submit(fn, *args)`` with ``call_deadline`` set to now + ``timeout``.

    The router and the front door wait ``timeout`` on the future; with the
    deadline set, the worker also gives up its place in the gate queue
    instead of making a late call nobody reads.
    """
    dl = time.monotonic() + timeout
    ctx = copy_context()

    def run():
        call_deadline.set(dl)
        return fn(*args)

    return pool.submit(ctx.run, run)


RATE_LIMITED, EMPTY_RESPONSE, PROVIDER_DEADLINE, OTHER = (
    "rate_limited",
    "empty_response",
    "provider_deadline",
    "other",
)


def classify_error(status: int | None, body: str) -> str:
    """Kind of a Nightshift failure, from the HTTP status and the error body."""
    b = body or ""
    if "provider_deadline" in b:
        return PROVIDER_DEADLINE
    if (
        status == 429
        or "nvidia_429" in b
        or "Too Many Requests" in b
        or re.search(r'\\?"status\\?"\s*:\s*429', b)
    ):
        return RATE_LIMITED
    if "empty_response" in b:
        return EMPTY_RESPONSE
    return OTHER


def _classify_exc(e: Exception) -> str:
    if isinstance(e, httpx.HTTPStatusError):
        try:
            body = e.response.text
        except Exception:  # noqa: BLE001 - a stream body that was never read
            body = ""
        return classify_error(e.response.status_code, body)
    if isinstance(e, ValueError):
        return classify_error(None, str(e))
    return OTHER


BACKOFF_BASE_S = 2.0
BACKOFF_FACTOR = 2.0
BACKOFF_MAX_RETRIES = 3
BACKOFF_MAX_WAIT_S = 20.0  # total extra wait per call
RETRY_AFTER_CAP_S = 10.0


def _note(reasons: list[str]) -> str:
    if not reasons:
        return ""
    words = {RATE_LIMITED: "rate limit", EMPTY_RESPONSE: "empty response"}
    kinds = sorted({words.get(r, r) for r in reasons})
    return f"retried {len(reasons)}× after {' / '.join(kinds)}"


def _retry_after(e: Exception) -> float | None:
    if isinstance(e, httpx.HTTPStatusError):
        raw = e.response.headers.get("retry-after", "")
        try:
            return min(max(float(raw), 0.0), RETRY_AFTER_CAP_S)
        except ValueError:
            return None  # an HTTP date or junk: fall back to the backoff
    return None


class NightshiftClient:
    label = "Nightshift"

    def __init__(
        self,
        post: Callable[..., httpx.Response] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        *,
        gate: CallGate | None = None,
        clock: Callable[[], float] = time.monotonic,
        jitter: Callable[[float], float] | None = None,
    ) -> None:
        self.base_url = (settings.meterless_base_url or "").rstrip("/")
        # The real transport always passes the process-wide gate; an injected
        # transport (tests) only when it brings its own gate.
        self._gate = gate if gate is not None else (default_gate() if post is None else None)
        self._post = post or (stream_post if settings.llm_stream else httpx.post)
        self._sleep = sleep
        self._clock = clock
        self._jitter = jitter or (lambda d: random.uniform(0.0, 0.25 * d))
        self.retry_stats = {RATE_LIMITED: 0, EMPTY_RESPONSE: 0}

    def models(self) -> list[str]:
        r = httpx.get(f"{self.base_url}/models", headers=self._headers(), timeout=30)
        r.raise_for_status()
        return [m.get("id", "") for m in r.json().get("data", [])]

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {settings.meterless_runtime_token}",
            "meterless-app": settings.meterless_app,
            "meterless-scope": settings.meterless_scope,
        }

    def complete(self, lane: str, system: str, user: str, *, json: bool = True) -> tuple[str, str]:
        model = settings.lane(lane)
        body: dict = {
            "model": model,
            "temperature": 0.1,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "chat_template_kwargs": {"enable_thinking": False},
        }  # Nemotron: no reasoning preamble
        if json:
            body["response_format"] = {"type": "json_object"}
        cap = settings.llm_max_tokens_fast if lane == "fast" else settings.llm_max_tokens_deep
        if cap > 0:
            body["max_tokens"] = cap
        return self._send(lane, model, body)

    def _post_gated(self, body: dict, timeout: float, deadline: float) -> httpx.Response:
        url = f"{self.base_url}/chat/completions"
        if self._gate is None:
            return self._post(url, json=body, headers=self._headers(), timeout=timeout)
        self._gate.acquire(deadline)
        try:
            left = deadline - self._clock()
            if left <= 0:
                raise GateTimeout("Nightshift slot came after the deadline")
            return self._post(url, json=body, headers=self._headers(), timeout=min(timeout, left))
        finally:
            self._gate.release()

    def _send(self, lane: str, model: str, body: dict) -> tuple[str, str]:
        """POST with the retry policy.

        Up to ``llm_max_attempts`` tries for transient errors. A timeout is
        final at once: it already took ``llm_timeout_s`` and a second wait
        would double the worst case. The JSON-mode downgrade is not an attempt.

        Rate limits (nvidia_429) and empty responses get their own budget:
        up to BACKOFF_MAX_RETRIES retries, 2 s * 2^n plus jitter (or the
        Retry-After), at most BACKOFF_MAX_WAIT_S of extra wait per call, and
        never past the call deadline (``llm_timeout_s`` from the first try, or
        the caller's ``call_deadline``). A provider_deadline 502 is not retried.

        ``LLM_TIMEOUT_S`` is the total budget of one call: the gate wait, every
        attempt and every backoff sleep come out of it.
        """
        attempts = max(1, settings.llm_max_attempts)
        last: Exception | None = None
        attempt = 0
        deadline = self._clock() + settings.llm_timeout_s
        ctx_dl = call_deadline.get()
        if ctx_dl is not None:
            deadline = min(deadline, ctx_dl)
        reasons: list[str] = []
        waited = 0.0
        while True:
            t0 = time.time()
            try:
                left = deadline - self._clock()
                if left <= 0:
                    raise GateTimeout("Nightshift call deadline passed")
                r = self._post_gated(body, min(settings.llm_timeout_s, left), deadline)
                if (
                    r.status_code == 400
                    and "response_format" in body
                    and "response_format" in r.text
                ):
                    body.pop("response_format")
                    continue  # runtime without JSON mode: prompt carries it
                r.raise_for_status()
                js = r.json()
                choice = js["choices"][0]
                text = choice["message"]["content"] or ""
                usage = js.get("usage") or {}
                log.info(
                    "nightshift lane=%s model=%s %.1fs prompt=%s completion=%s finish=%s%s",
                    lane,
                    js.get("model", model),
                    time.time() - t0,
                    usage.get("prompt_tokens"),
                    usage.get("completion_tokens"),
                    choice.get("finish_reason"),
                    f" ({_note(reasons)})" if reasons else "",
                )
                served = js.get("model", model)
                GLOBAL_USAGE.record(lane, served, usage, int((time.time() - t0) * 1000))
                if (m := run_meter.get()) is not None:
                    m.record(lane, served, usage, int((time.time() - t0) * 1000))
                if choice.get("finish_reason") == "length":
                    # Truncated at max_tokens: never hand a cut reply to the
                    # parsers or the Judge. Not retried (same prompt, same cut).
                    raise RuntimeError("Nightshift reply cut off at max_tokens")
                return text, js.get("model", model)
            except GateTimeout:
                log.warning("nightshift lane=%s: no slot before the deadline", lane)
                raise
            except httpx.TimeoutException as e:
                log.warning(
                    "nightshift lane=%s timed out after %.0fs; not retried", lane, time.time() - t0
                )
                raise RuntimeError(
                    f"Nightshift timeout: total budget of {settings.llm_timeout_s:.0f}s used"
                ) from e
            except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as e:
                last = e
                took = time.time() - t0
                kind = _classify_exc(e)
                if kind in (RATE_LIMITED, EMPTY_RESPONSE):
                    n = len(reasons)
                    delay = _retry_after(e)
                    if delay is None:
                        base = BACKOFF_BASE_S * BACKOFF_FACTOR**n
                        delay = base + max(0.0, self._jitter(base))
                    room = deadline - self._clock() - 1.0  # keep a second for the call
                    if (
                        n >= BACKOFF_MAX_RETRIES
                        or waited + delay > BACKOFF_MAX_WAIT_S
                        or delay > room
                    ):
                        log.warning(
                            "nightshift lane=%s %s; giving up after %d retries", lane, kind, n
                        )
                        break
                    reasons.append(kind)
                    self.retry_stats[kind] += 1
                    waited += delay
                    log.warning(
                        "nightshift lane=%s %s; retry %d in %.1fs", lane, kind, n + 1, delay
                    )
                    self._sleep(delay)
                    continue
                if kind == PROVIDER_DEADLINE:
                    # The gateway cut a long generation at ~45 s: the same
                    # prompt will be cut again, so the node falls back.
                    log.warning("nightshift lane=%s provider_deadline; not retried", lane)
                    break
                attempt += 1
                if took >= settings.llm_slow_fail_s:
                    # A 502/504 after a long wait is the gateway cutting a long
                    # generation (measured ~45 s each): the same prompt will be
                    # cut again, so the node falls back instead of waiting 3x.
                    log.warning(
                        "nightshift lane=%s failed after %.0fs; not retried: %s",
                        lane,
                        took,
                        str(e)[:160],
                    )
                    break
                log.warning("nightshift attempt %d failed: %s", attempt, str(e)[:160])
                if attempt >= attempts:
                    break
                self._sleep(1.5 * attempt)
        raise RuntimeError(f"{self.label} unavailable: {last}")


class NebiusClient(NightshiftClient):
    """Nebius Token Factory backend (``LLM_BACKEND=nebius``).

    Same retry, 429 backoff and JSON-mode downgrade as NightshiftClient.
    OpenAI-compatible ``POST {NEBIUS_BASE_URL}/chat/completions`` with
    ``Authorization: Bearer <NEBIUS_API_KEY>``. Default base URL
    ``https://api.tokenfactory.nebius.com/v1`` (verified in
    docs.tokenfactory.nebius.com/api-reference/introduction). Default models are
    NVIDIA Nemotron ids from nebius.com/services/token-factory/models/nvidia-nemotron-models-inference
    (Nemotron-3.5-Super-VL) and third-party catalogue mirrors (Nano 30B); they are NOT confirmed against ``GET /v1/models`` with a key, so set
    NEBIUS_MODEL_FAST / NEBIUS_MODEL_DEEP if the catalogue differs.
    ``enable_thinking`` is not sent (undocumented on Nebius), so Nemotron reasoning may
    count against max_tokens. ``response_format: json_object`` is not documented by Nebius; a 400 naming
    response_format makes the shared downgrade drop it (the prompt carries JSON).
    """

    label = "Nebius"

    def __init__(self, *args, **kw) -> None:
        super().__init__(*args, **kw)
        self.base_url = (settings.nebius_base_url or "").rstrip("/")

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {settings.nebius_api_key}"}

    def complete(self, lane: str, system: str, user: str, *, json: bool = True) -> tuple[str, str]:
        model = settings.lane(lane)
        body: dict = {
            "model": model,
            "temperature": 0.1,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        if json:
            body["response_format"] = {"type": "json_object"}
        cap = settings.llm_max_tokens_fast if lane == "fast" else settings.llm_max_tokens_deep
        if cap > 0:
            body["max_tokens"] = cap
        return self._send(lane, model, body)


class FakeNightshift:
    """Deterministic stand-in for offline runs.

    `handlers[task](system, user) -> str`, keyed by the task tag in the first
    line of the system prompt (TASK: investigator | skeptic | playbook |
    judge | repair). An unknown task returns '{}' and the node falls back to
    its deterministic path.
    """

    def __init__(self, handlers: dict[str, Callable[[str, str], str]] | None = None) -> None:
        self.handlers = handlers or {}
        self.calls: list[tuple[str, str, str]] = []

    def complete(self, lane: str, system: str, user: str, *, json: bool = True) -> tuple[str, str]:
        task = system.split("\n", 1)[0].replace("TASK:", "").strip().lower()
        self.calls.append((lane, task, user))
        h = self.handlers.get(task)
        return (h(system, user) if h else "{}"), f"fake-{lane}"


def check_lanes(llm: LLM | None = None) -> dict:
    """One tiny completion per lane. {backend, ok, lanes: {lane: {ok, model_id, nemotron, latency_ms, error}}}.

    ``nemotron`` is True when the model id that answered names Nemotron. Needs a real key.
    """
    llm = llm or build_llm()
    lanes: dict[str, dict] = {}
    for lane in ("fast", "deep"):
        t0 = time.time()
        try:
            _, model = llm.complete(lane, "Reply with the single word OK.", "ping", json=False)
            lanes[lane] = {"ok": True, "model_id": model, "nemotron": "nemotron" in model.lower(), "error": None}
        except Exception as e:  # noqa: BLE001 - reported, never raised
            lanes[lane] = {"ok": False, "model_id": None, "nemotron": False, "error": str(e)[:200]}
        lanes[lane]["latency_ms"] = int((time.time() - t0) * 1000)
    return {
        "backend": settings.llm_backend,
        "ok": all(v["ok"] for v in lanes.values()),
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lanes": lanes,
    }


def build_llm() -> LLM:
    if settings.llm_backend == "nebius":
        if settings.llm_mode == "fake":
            return FakeNightshift()
        if not settings.nebius_api_key:
            raise RuntimeError("LLM_BACKEND=nebius but NEBIUS_API_KEY is not set")
        return NebiusClient()
    return _build_nightshift()


def _build_nightshift() -> LLM:
    if settings.llm_mode == "fake" or (
        settings.llm_mode == "auto" and not settings.meterless_base_url
    ):
        log.warning("LLM: METERLESS_BASE_URL unset -> FakeNightshift (offline, deterministic)")
        return FakeNightshift()
    return NightshiftClient()
