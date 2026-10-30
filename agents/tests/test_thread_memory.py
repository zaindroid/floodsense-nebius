"""Short-term thread memory: a follow-up run carries the earlier turns of its conversation."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from fastapi.testclient import TestClient  # noqa: E402
from langgraph.checkpoint.memory import MemorySaver  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from floodsense_agents import __main__ as service  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import ApprovalDecision, RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.runtime import THREAD_TURNS_MAX, Runtime, ThreadNotFound  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402

FIRST = "Why are our Valencia sites at risk?"
FOLLOW_UP = "Which of those sites are retail?"


def runtime(llm=None) -> tuple[Runtime, FakeNightshift]:
    llm = llm or FakeNightshift()
    deps = Deps(zetaris=FakeZetaris(), llm=llm, memory=NoMemory())
    return Runtime(graph=build_graph(deps, MemorySaver()), deps=deps), llm


def ask(rt: Runtime, question: str, thread_id: str | None = None, approve: bool = True) -> dict:
    s = rt.start(RunRequest(question=question, event_id="EMSR773", thread_id=thread_id))
    if approve:
        s = rt.resume(s["run_id"], ApprovalDecision(action="approve", reviewer="ayush"))
    return s


def investigator_prompts(llm: FakeNightshift) -> list[str]:
    return [user for lane, task, user in llm.calls if task == "investigator"]


class ThreadTest(unittest.TestCase):
    def test_a_first_run_starts_its_own_thread(self) -> None:
        rt, llm = runtime()
        s = ask(rt, FIRST)
        self.assertEqual(s["thread_id"], s["run_id"])
        self.assertEqual(s["thread"], [])
        self.assertNotIn("memory", [e["node"] for e in s["trace"]])
        self.assertNotIn("EARLIER IN THIS THREAD", investigator_prompts(llm)[0])

    def test_a_follow_up_carries_the_earlier_turn(self) -> None:
        rt, llm = runtime()
        first = ask(rt, FIRST)
        s = rt.start(RunRequest(question=FOLLOW_UP, thread_id=first["thread_id"]))
        self.assertEqual(s["thread_id"], first["run_id"])
        (turn,) = s["thread"]
        self.assertEqual(turn["run_id"], first["run_id"])
        self.assertEqual(turn["question"], FIRST)
        self.assertEqual(turn["approval"], "approved")
        self.assertEqual(turn["summary"], first["summary"][: len(turn["summary"])])
        self.assertTrue(turn["summary"])

        note = next(e for e in s["trace"] if e["node"] == "memory")
        self.assertIn(f"1 earlier turn(s) in thread {first['run_id']}", note["summary"])
        prompt = investigator_prompts(llm)[-1]
        self.assertIn("EARLIER IN THIS THREAD", prompt)
        self.assertIn(FIRST, prompt)

        payload = rt.approval(s["run_id"])
        self.assertEqual([t["run_id"] for t in payload["thread"]], [first["run_id"]])

    def test_the_thread_keeps_the_last_turns_oldest_first(self) -> None:
        rt, _ = runtime()
        first = ask(rt, FIRST)
        tid = first["thread_id"]
        asked = [FIRST]
        for i in range(THREAD_TURNS_MAX + 1):
            q = f"Follow-up {i}: which sites changed?"
            ask(rt, q, thread_id=tid)
            asked.append(q)
        s = rt.start(RunRequest(question="Last one", thread_id=tid))
        self.assertEqual([t["question"] for t in s["thread"]], asked[-THREAD_TURNS_MAX:])

    def test_a_rejected_or_pending_turn_says_so(self) -> None:
        rt, _ = runtime()
        first = rt.start(RunRequest(question=FIRST))
        s = rt.start(RunRequest(question=FOLLOW_UP, thread_id=first["thread_id"]))
        self.assertEqual(s["thread"][0]["status"], "awaiting_approval")
        rt.resume(first["run_id"], ApprovalDecision(action="reject", reviewer="ayush"))
        s = rt.start(RunRequest(question=FOLLOW_UP, thread_id=first["thread_id"]))
        self.assertEqual(s["thread"][0]["approval"], "rejected")

    def test_an_unknown_thread_is_refused(self) -> None:
        rt, _ = runtime()
        with self.assertRaises(ThreadNotFound):
            rt.start(RunRequest(question=FOLLOW_UP, thread_id="nope"))

    def test_past_runs_filter_by_thread(self) -> None:
        rt, _ = runtime()
        first = ask(rt, FIRST)
        second = ask(rt, FOLLOW_UP, thread_id=first["thread_id"])
        other = ask(rt, "A different conversation")
        rows = rt.past(thread_id=first["thread_id"])
        self.assertEqual({r["run_id"] for r in rows}, {first["run_id"], second["run_id"]})
        self.assertNotIn(other["run_id"], {r["run_id"] for r in rows})
        self.assertTrue(all(r["thread_id"] == first["thread_id"] for r in rows))

    def test_a_restarted_runtime_still_finds_the_thread_and_its_start_time(self) -> None:
        rt, _ = runtime()
        first = ask(rt, FIRST)
        again = Runtime(graph=rt.graph, deps=rt.deps)  # empty index, as after a restart
        s = again.start(RunRequest(question=FOLLOW_UP, thread_id=first["thread_id"]))
        self.assertEqual(s["thread"][0]["run_id"], first["run_id"])
        row = next(r for r in again.past() if r["run_id"] == first["run_id"])
        self.assertEqual(row["created_at"], first["trace"][0]["ts"])

    def test_a_malformed_thread_id_is_rejected_by_the_model(self) -> None:
        with self.assertRaises(ValidationError):
            RunRequest(question=FOLLOW_UP, thread_id="../../etc")


class ServiceThreadTest(unittest.TestCase):
    def setUp(self) -> None:
        rt, _ = runtime()
        service.set_runtime(rt)
        self.c = TestClient(service.app)

    def test_unknown_thread_is_a_404_and_a_known_one_continues(self) -> None:
        r = self.c.post("/runs", json={"question": FOLLOW_UP, "thread_id": "nope"})
        self.assertEqual(r.status_code, 404)
        self.assertIn("omit thread_id", r.json()["detail"])
        first = self.c.post("/runs", json={"question": FIRST}).json()
        r = self.c.post("/runs", json={"question": FOLLOW_UP, "thread_id": first["thread_id"]})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["thread"][0]["run_id"], first["run_id"])
        rows = self.c.get("/runs/past", params={"thread_id": first["thread_id"]}).json()["runs"]
        self.assertEqual(len(rows), 2)


if __name__ == "__main__":
    unittest.main()
