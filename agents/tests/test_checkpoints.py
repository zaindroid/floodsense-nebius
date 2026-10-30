"""Checkpointer locking, and the run index must not re-enter it.

SqliteSaver.list holds its lock while the generator is open. Snapshotting a
run from inside that loop calls get_tuple on the same thread and wedges.
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents.checkpoints import build_checkpointer  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


def _runtime() -> Runtime:
    deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
    return Runtime(graph=build_graph(deps), deps=deps)


class RebuildIndexTest(unittest.TestCase):
    def test_past_does_not_snapshot_while_the_checkpointer_is_listing(self) -> None:
        rt = _runtime()
        run_id = rt.start(RunRequest(question="q", event_id="EMSR773"))["run_id"]
        rt.index.clear()

        listing = {"on": False, "during": False}
        real_list = rt.graph.checkpointer.list
        real_snapshot = rt.snapshot

        def list_checkpoints(*args, **kwargs):
            listing["on"] = True
            try:
                yield from real_list(*args, **kwargs)
            finally:
                listing["on"] = False

        def snapshot(rid):
            if listing["on"]:
                listing["during"] = True
            return real_snapshot(rid)

        rt.graph.checkpointer.list = list_checkpoints
        rt.snapshot = snapshot
        try:
            rows = rt.past()
        finally:
            rt.graph.checkpointer.list = real_list
            rt.snapshot = real_snapshot
        self.assertIn(run_id, [r["run_id"] for r in rows])
        self.assertFalse(listing["during"])


class LockedSaverTest(unittest.TestCase):
    def test_list_releases_the_connection_before_the_caller_continues(self) -> None:
        """A caller that reads one row and then loads another must not deadlock."""
        from floodsense_agents.checkpoints import _LockedSaver

        inner_lock = threading.Lock()

        class Inner:
            def list(self, config, **kwargs):
                with inner_lock:
                    yield "row"

            def get_tuple(self, config):
                acquired = inner_lock.acquire(timeout=0.2)
                if not acquired:
                    raise AssertionError("list still holds the checkpointer")
                inner_lock.release()
                return "tuple"

            def setup(self):
                return None

        saver = _LockedSaver(Inner())
        seen = []
        for row in saver.list(None):
            seen.append(row)
            self.assertEqual(saver.get_tuple({}), "tuple")
        self.assertEqual(seen, ["row"])

    def test_put_writes_keeps_task_path(self) -> None:
        from inspect import signature

        from floodsense_agents.checkpoints import _LockedSaver

        class Inner:
            def put_writes(self, config, writes, task_id, task_path=""):
                return task_path

        saver = _LockedSaver(Inner())
        self.assertIn("task_path", signature(saver.put_writes).parameters)
        self.assertEqual(saver.put_writes({}, [], "t", task_path="n/playbook"), "n/playbook")

    def test_sqlite_saver_survives_a_paused_run(self) -> None:
        was_mode, was_dir = settings.checkpointer, settings.checkpoint_dir
        saver = again = None
        with tempfile.TemporaryDirectory() as d:
            settings.checkpointer = "sqlite"
            settings.checkpoint_dir = d
            try:
                saver = build_checkpointer()
                deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
                graph = build_graph(deps, saver)
                rt = Runtime(graph=graph, deps=deps)
                run_id = rt.start(RunRequest(question="q", event_id="EMSR773"))["run_id"]
                snap = rt.snapshot(run_id)
                self.assertEqual(snap["status"], "awaiting_approval")
                # Same file, new saver: the lock wrapper must still be a checkpointer.
                again = build_checkpointer()
                resumed = Runtime(graph=build_graph(deps, again), deps=deps)
                self.assertEqual(resumed.snapshot(run_id)["run_id"], run_id)
            finally:
                settings.checkpointer = was_mode
                settings.checkpoint_dir = was_dir
                for item in (saver, again):
                    inner = getattr(item, "_inner", None)
                    conn = getattr(inner, "conn", None)
                    if conn is not None:
                        conn.close()


if __name__ == "__main__":
    unittest.main()
