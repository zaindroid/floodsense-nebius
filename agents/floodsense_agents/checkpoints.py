"""Checkpointer for pause / review / resume.

SQLite under CHECKPOINT_DIR, so a paused run survives a restart. Falls back
to memory when the directory is unwritable or CHECKPOINTER=memory, in which
case a paused run dies with the process.

FastAPI runs these sync routes on a threadpool, so one connection serves a
long POST /runs and a concurrent GET. SqliteSaver locks each cursor, and
list() keeps that lock until the caller finishes the generator. A nested
read on the same thread never gets the lock back. _LockedSaver serializes
the public calls and finishes the list before it returns the rows.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from collections.abc import Iterator
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import MemorySaver

from floodsense_agents.settings import settings

log = logging.getLogger("floodsense.checkpoints")


class _LockedSaver(BaseCheckpointSaver):
    """One lock around a shared SqliteSaver.

    list() is consumed under the lock and handed back as a plain iterator,
    so the caller can load another checkpoint without re-entering the saver.
    """

    def __init__(self, inner: Any) -> None:
        super().__init__(serde=getattr(inner, "serde", None))
        self._inner = inner
        self._lock = threading.Lock()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def setup(self) -> None:
        with self._lock:
            self._inner.setup()

    def get_tuple(self, config: Any) -> Any:
        with self._lock:
            return self._inner.get_tuple(config)

    def list(
        self,
        config: Any,
        *,
        filter: dict[str, Any] | None = None,
        before: Any = None,
        limit: int | None = None,
    ) -> Iterator[Any]:
        with self._lock:
            rows = tuple(self._inner.list(config, filter=filter, before=before, limit=limit))
        return iter(rows)

    def put(self, config: Any, checkpoint: Any, metadata: Any, new_versions: Any) -> Any:
        with self._lock:
            return self._inner.put(config, checkpoint, metadata, new_versions)

    def put_writes(self, config: Any, writes: Any, task_id: str, task_path: str = "") -> None:
        with self._lock:
            return self._inner.put_writes(config, writes, task_id, task_path=task_path)

    def delete_thread(self, thread_id: str) -> None:
        with self._lock:
            self._inner.delete_thread(thread_id)

    def get_next_version(self, current: Any, channel: Any) -> Any:
        return self._inner.get_next_version(current, channel)

    def get_delta_channel_history(self, *, config: Any, channels: Any) -> Any:
        with self._lock:
            return self._inner.get_delta_channel_history(config=config, channels=channels)


def build_checkpointer():
    if settings.checkpointer == "memory":
        return MemorySaver()
    try:
        from langgraph.checkpoint.sqlite import SqliteSaver

        os.makedirs(settings.checkpoint_dir, exist_ok=True)
        path = os.path.join(settings.checkpoint_dir, "floodsense.sqlite")
        # timeout is the backstop when a second connection hits the file.
        # This process serializes on _LockedSaver.
        conn = sqlite3.connect(path, check_same_thread=False, timeout=5.0)
        saver = _LockedSaver(SqliteSaver(conn))
        saver.setup()
        log.info("checkpointer: sqlite %s", path)
        return saver
    except Exception as e:
        if settings.checkpointer == "sqlite":
            raise
        log.warning(
            "checkpointer: sqlite unavailable (%s) -> MemorySaver; paused runs will not survive a "
            "restart",
            str(e)[:120],
        )
        return MemorySaver()
