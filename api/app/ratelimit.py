"""Rate limits for the write routes (GAMEPLAN "Caching and the honest demo").

Two guards, both in this process, no new dependency:

- A token bucket per client IP on ``POST /runs`` (RATE_LIMIT_RUNS_PER_MIN, burst
  of the same size, at least 1). Approval is not limited: it starts no new run. Empty -> 429 + Retry-After.
- A cap on live ``POST /runs`` calls in flight to the agents
  (RATE_LIMIT_MAX_CONCURRENT_RUNS). Full -> 429 + Retry-After. A cache hit does
  not take a slot. GET routes are never limited.

0 turns a guard off. A restart empties both.
"""

from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass, field


def _num(name: str, default: float) -> float:
    v = os.environ.get(name)
    try:
        return float(v) if v not in (None, "") else default
    except ValueError:
        return default


@dataclass
class RateLimitSettings:
    runs_per_min: float = field(default_factory=lambda: _num("RATE_LIMIT_RUNS_PER_MIN", 10))
    max_concurrent_runs: int = field(
        default_factory=lambda: int(_num("RATE_LIMIT_MAX_CONCURRENT_RUNS", 2))
    )
    concurrency_retry_after_s: int = field(
        default_factory=lambda: max(1, int(_num("RATE_LIMIT_CONCURRENCY_RETRY_AFTER_S", 30)))
    )


class TokenBuckets:
    """One bucket per key. Refill ``per_min`` per minute, capacity ``max(1, per_min)``."""

    def __init__(self, per_min: float, clock=time.monotonic, max_keys: int = 4096) -> None:
        self.per_min = per_min
        self.clock = clock
        self.max_keys = max_keys
        self._buckets: dict[str, tuple[float, float]] = {}

    def take(self, key: str) -> int | None:
        """Take one token. None when allowed, else the seconds to wait (>= 1)."""
        if self.per_min <= 0:
            return None
        now = self.clock()
        rate = self.per_min / 60.0
        cap = max(1.0, self.per_min)
        tokens, last = self._buckets.get(key, (cap, now))
        tokens = min(cap, tokens + (now - last) * rate)
        if tokens >= 1:
            if key not in self._buckets and len(self._buckets) >= self.max_keys:
                self._buckets.pop(next(iter(self._buckets)))
            self._buckets[key] = (tokens - 1, now)
            return None
        self._buckets[key] = (tokens, now)
        return max(1, math.ceil((1 - tokens) / rate))


class RunSlots:
    """Non-blocking cap on in-flight live runs. asyncio is single-threaded here."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.in_flight = 0

    def try_acquire(self) -> bool:
        if self.limit > 0 and self.in_flight >= self.limit:
            return False
        self.in_flight += 1
        return True

    def release(self) -> None:
        self.in_flight = max(0, self.in_flight - 1)


class RateLimiter:
    def __init__(self, settings: RateLimitSettings | None = None, clock=time.monotonic) -> None:
        self.settings = settings or RateLimitSettings()
        self.buckets = TokenBuckets(self.settings.runs_per_min, clock=clock)
        self.slots = RunSlots(self.settings.max_concurrent_runs)
