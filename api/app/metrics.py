"""In-process counters for GET /system. Reset when the API restarts.

Nothing here is persisted or shared between replicas. The numbers say what
this one process saw since it started, and /system labels them that way.
"""

from __future__ import annotations

import threading
import time
from collections import deque

RECENT_WINDOW_S = 300.0  # "recent" 429s: the last five minutes


class Counters:
    def __init__(self, clock=time.time) -> None:
        self.clock = clock
        self.started_at = clock()
        self._lock = threading.Lock()
        self.cache_hits = 0
        self.cache_misses = 0
        self.replays_served = 0
        self.rejected_total = 0
        self._rejected_at: deque[float] = deque(maxlen=10_000)
        self._latency_ms: dict[str, deque[int]] = {}

    def cache_hit(self) -> None:
        with self._lock:
            self.cache_hits += 1

    def cache_miss(self) -> None:
        with self._lock:
            self.cache_misses += 1

    def replay_served(self) -> None:
        with self._lock:
            self.replays_served += 1

    def rejected(self) -> None:
        with self._lock:
            self.rejected_total += 1
            self._rejected_at.append(self.clock())

    def run_latency(self, lane: str, ms: int) -> None:
        with self._lock:
            self._latency_ms.setdefault(lane, deque(maxlen=200)).append(int(ms))

    def latency_stats(self) -> dict:
        """Per lane {n, p50_ms, p95_ms} over the last 200 synchronous runs (nearest rank)."""
        with self._lock:
            lanes = {k: sorted(v) for k, v in self._latency_ms.items() if v}
        return {
            k: {"n": len(v), "p50_ms": v[(len(v) - 1) // 2], "p95_ms": v[-(-95 * len(v) // 100) - 1]}
            for k, v in lanes.items()
        }

    def recent_rejections(self, window_s: float = RECENT_WINDOW_S) -> int:
        cutoff = self.clock() - window_s
        with self._lock:
            return sum(1 for t in self._rejected_at if t >= cutoff)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "since_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.started_at)),
                "cache_hits": self.cache_hits,
                "cache_misses": self.cache_misses,
                "replays_served": self.replays_served,
                "rejected_429_total": self.rejected_total,
            }


counters = Counters()
