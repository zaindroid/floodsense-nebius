"""The engines sidecar in the graph: H-MEM recall and Learn, the World Model, the Playbook rule.

A fake engines server answers over httpx.MockTransport with the same shapes
engines/ returns, and rejects what engines/ would reject. No network.
"""

from __future__ import annotations

import json
import os
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

import httpx  # noqa: E402
from langgraph.checkpoint.memory import MemorySaver  # noqa: E402
from langgraph.types import Command  # noqa: E402

from floodsense_agents import graph as graph_mod  # noqa: E402
from floodsense_agents.engines import EnginesClient, EnginesError, NoWorld, build_engines  # noqa: E402
from floodsense_agents.events import spec  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402

RECALLED = {
    "memory_id": "m-past",
    "content": "Paiporta sits on the outflow of the Poyo ravine.",
    "relevance": 0.82,
    "confidence": 0.8,
    "run_id": "r-past",
    "claim_id": "C1",
    "query_ids": ["q-past"],
    "tags": ["floodsense", "run:r-past", "claim:C1", "event:EMSR773"],
}
ELSEWHERE = {
    **RECALLED,
    "memory_id": "m-ahr",
    "content": "Altenahr's gauge failed during the Ahr flood.",
    "relevance": 0.9,
    "run_id": "r-ahr",
    "tags": ["floodsense", "run:r-ahr", "claim:C2", "event:EMSR517"],
}
ANOMALY_KEYS = ("id", "kind", "point_id", "ts_utc", "why", "query_id")


class FakeEngines:
    """engines/ in miniature: same routes, same reply shapes, same refusals."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def paths(self) -> list[str]:
        return [p for p, _ in self.calls]

    def bodies(self, path: str) -> list[dict]:
        return [b for p, b in self.calls if p == path]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        path = request.url.path
        self.calls.append((path, body))
        if path == "/hmem/recall":
            if not str(body.get("query", "")).strip():
                return self.bad("query must be a non-empty string")
            return httpx.Response(200, json={"memories": [ELSEWHERE, RECALLED], "trace": {}})
        if path == "/hmem/memories":
            return httpx.Response(200, json={"total": 0, "memories": []})
        if path == "/hmem/store":
            claims = body.get("claims")
            if not body.get("run_id") or not body.get("question") or not isinstance(claims, list):
                return self.bad("run_id, question and claims are required")
            if any(not c.get("claim_id") or not str(c.get("text", "")).strip() for c in claims):
                return self.bad("every claim needs claim_id and text")
            status = (body.get("approval") or {}).get("status")
            if status not in ("approved", "edited"):
                return httpx.Response(
                    200,
                    json={
                        "stored": [],
                        "already_stored": [],
                        "skipped": len(claims),
                        "reason": f"approval.status is {status}",
                    },
                )
            stored = [
                {"claim_id": c["claim_id"], "memory_id": f"m-{c['claim_id']}"} for c in claims
            ]
            return httpx.Response(200, json={"stored": stored, "already_stored": [], "skipped": 0})
        if path == "/wm/observations":
            anomalies = body.get("anomalies") or []
            if not anomalies:
                return self.bad("send a non-empty observations or anomalies list")
            for a in anomalies:
                missing = [k for k in ANOMALY_KEYS if not a.get(k)]
                if missing:
                    return self.bad(f"anomaly is missing {missing}")
            n = len(anomalies)
            return httpx.Response(
                200,
                json={
                    "processed": n,
                    "skipped_unchanged": 0,
                    "events_appended": n,
                    "changed": True,
                },
            )
        if path == "/wm/hypotheses":
            hyps = body.get("hypotheses") or []
            if not hyps or not body.get("run_id") or not body.get("at"):
                return self.bad("run_id, at and a non-empty hypotheses list are required")
            if any(h.get("status") not in ("proposed", "supported", "not_supported") for h in hyps):
                return self.bad("hypothesis status must be proposed, supported or not_supported")
            board = [{"hypothesis_id": h["id"], "status": h["status"]} for h in hyps]
            return httpx.Response(200, json={"board": board})
        return httpx.Response(404, json={"error": f"no route for {request.method} {path}"})

    @staticmethod
    def bad(message: str) -> httpx.Response:
        return httpx.Response(400, json={"error": message})


def refuse(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


def client(handler) -> EnginesClient:
    return EnginesClient("http://engines.test", transport=httpx.MockTransport(handler))


def engines_deps(handler, llm=None) -> tuple[Deps, FakeNightshift]:
    llm = llm or FakeNightshift()
    c = client(handler)
    return Deps(zetaris=FakeZetaris(), llm=llm, memory=c, world=c), llm


def start(graph, rid="e1", question="Why are our Valencia sites at risk?"):
    cfg = {"configurable": {"thread_id": rid}}
    ev = spec("EMSR773")
    req = {
        "question": question,
        "event_id": ev.event_id,
        "customer_id": "demo-insurer",
        "replay_ts": None,
        "lang": "en",
        "reviewer": None,
    }
    out = graph.invoke(
        {
            "run_id": rid,
            "thread_id": rid,
            "event_id": ev.event_id,
            "customer_id": "demo-insurer",
            "replay_ts": None,
            "request": req,
            "event": ev.as_dict(),
            "served_from": "live",
            "cached_at": None,
            "trace": [],
            "revise_rounds": 0,
            "repair_rounds": 0,
            "model_ids": [],
        },
        cfg,
    )
    return out, cfg


def planted_investigator(system, user):
    """Per-link answers: one real rain claim, and a planted river->site link backed
    by no rows (as in test_graph)."""
    link = re.search(r"LINK: (\S+) (\S+)", user).group(2)
    if link == "rain->catchment":
        blocks = re.findall(r"query_id=(\S+) view=(\S+) rows=(\d+)", user)
        rain = next(q for q, v, n in blocks if v.endswith("hazard_timeline") and int(n) > 0)
        claim = {"text": "Point chiva recorded a peak hour of 96 mm.", "query_ids": [rain]}
        return json.dumps({"statement": "Extreme rain", "claims": [claim]})
    if link == "river->site":
        claim = {"text": "Flood water reached the Valencia city office.", "query_ids": []}
        return json.dumps({"statement": "City office flooded", "claims": [claim]})
    return "{}"


def nodes(trace: list[dict]) -> list[str]:
    return [e["node"] for e in trace]


class FlagCase(unittest.TestCase):
    """Sets FF_HMEM (and optionally ENGINES_URL) for one test and puts them back."""

    hmem = False

    def setUp(self) -> None:
        self._was = (settings.ff_hmem, settings.engines_url)
        settings.ff_hmem = self.hmem

    def tearDown(self) -> None:
        settings.ff_hmem, settings.engines_url = self._was


class ClientTest(unittest.TestCase):
    def test_recall_keeps_past_findings_on_the_same_event(self) -> None:
        fake = FakeEngines()
        got = client(fake).recall({"question": "Why Paiporta?", "event_id": "EMSR773"})
        self.assertEqual(got, [RECALLED])
        body = {"query": "Why Paiporta?", "top_n": 50, "threshold": 0.0}
        self.assertEqual(fake.calls[0], ("/hmem/recall", body))

    def test_recall_without_an_event_keeps_the_top_n(self) -> None:
        c = EnginesClient(
            "http://engines.test", recall_top_n=1, transport=httpx.MockTransport(FakeEngines())
        )
        self.assertEqual(c.recall({"question": "Why Paiporta?"}), [ELSEWHERE])

    def test_recall_without_a_question_sends_nothing(self) -> None:
        fake = FakeEngines()
        self.assertEqual(client(fake).recall({"question": "  "}), [])
        self.assertEqual(fake.calls, [])

    def test_store_sends_the_run_as_the_agents_have_it(self) -> None:
        fake = FakeEngines()
        claims = [
            {"claim_id": "C1", "text": "x", "citations": [{"query_id": "q1"}], "kind": "fact"}
        ]
        report = client(fake).store(
            "r1",
            {"question": "q", "event_id": "EMSR773"},
            claims,
            {"status": "approved", "reviewer": "ayush", "decision": "approve"},
        )
        self.assertEqual(report["stored"], [{"claim_id": "C1", "memory_id": "m-C1"}])
        (body,) = fake.bodies("/hmem/store")
        self.assertEqual(body["run_id"], "r1")
        self.assertEqual(body["event_id"], "EMSR773")
        self.assertEqual(body["approval"], {"status": "approved", "reviewer": "ayush"})
        self.assertEqual(body["claims"], claims)

    def test_empty_writes_send_nothing(self) -> None:
        fake = FakeEngines()
        c = client(fake)
        self.assertEqual(c.observe([]), {})
        self.assertEqual(c.update_hypotheses("r1", "2024-10-30T00:00:00Z", "x", []), [])
        self.assertEqual(fake.calls, [])

    def test_an_error_reply_names_the_route_and_the_reason(self) -> None:
        with self.assertRaises(EnginesError) as caught:
            client(FakeEngines()).update_hypotheses(
                "r1", "2024-10-30T00:00:00Z", "x", [{"id": "H1", "status": "refuted"}]
            )
        self.assertIn("/wm/hypotheses", str(caught.exception))
        self.assertIn("HTTP 400", str(caught.exception))
        self.assertIn("proposed, supported or not_supported", str(caught.exception))

    def test_unreachable_engines_raise_engines_error(self) -> None:
        with self.assertRaises(EnginesError) as caught:
            client(refuse).observe([{"id": "A1"}])
        self.assertIn("not reachable", str(caught.exception))


class BuildDepsTest(FlagCase):
    def test_no_url_means_no_engines(self) -> None:
        settings.engines_url = None
        settings.ff_hmem = True
        self.assertIsNone(build_engines())
        d = graph_mod.build_deps()
        self.assertIs(type(d.memory), NoMemory)
        self.assertIsInstance(d.world, NoWorld)

    def test_url_turns_on_the_world_model_and_the_flag_turns_on_memory(self) -> None:
        settings.engines_url = "http://127.0.0.1:8300"
        settings.ff_hmem = False
        d = graph_mod.build_deps()
        self.assertIs(type(d.memory), NoMemory)
        self.assertIsInstance(d.world, EnginesClient)
        settings.ff_hmem = True
        d = graph_mod.build_deps()
        self.assertIsInstance(d.memory, EnginesClient)
        self.assertIs(d.memory, d.world)


class EnginesOffTest(FlagCase):
    hmem = True

    def test_without_engines_the_trace_is_unchanged(self) -> None:
        d = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        g = build_graph(d, MemorySaver())
        out, cfg = start(g)
        self.assertIn("__interrupt__", out)
        out = g.invoke(Command(resume={"action": "approve", "reviewer": "ayush"}), cfg)
        self.assertEqual(out["status"], "approved")
        seen = set(nodes(out["trace"]))
        self.assertFalse(seen & {"memory", "world_model", "learn"}, seen)


class WorldModelTest(FlagCase):
    hmem = False

    def test_anomalies_and_every_hypothesis_write_reach_the_board(self) -> None:
        fake = FakeEngines()
        d, _ = engines_deps(fake)
        g = build_graph(d, MemorySaver())
        out, _ = start(g)
        state = g.get_state({"configurable": {"thread_id": "e1"}}).values

        (observed,) = fake.bodies("/wm/observations")
        self.assertEqual(observed["anomalies"], state["anomalies"])
        writes = fake.bodies("/wm/hypotheses")
        self.assertGreaterEqual(len(writes), 2)
        first = writes[0]
        self.assertEqual(first["by"], "floodsense-investigator")
        self.assertEqual(first["run_id"], "e1")
        self.assertEqual({h["status"] for h in first["hypotheses"]}, {"proposed"})
        # at is the scenario clock: the end of the event window, not the wall clock
        self.assertEqual(first["at"], spec("EMSR773").as_dict()["window_to_utc"])
        self.assertIn("floodsense-skeptic", [w["by"] for w in writes])
        self.assertFalse([p for p in fake.paths() if p.startswith("/hmem")])

        trail = nodes(state["trace"])
        for node in ("watchers", "investigator", "skeptic"):
            i = trail.index(node)
            self.assertEqual(trail[i + 1], "world_model", trail)
        notes = [e["summary"] for e in state["trace"] if e["node"] == "world_model"]
        self.assertTrue(notes[0].endswith("events appended"), notes)
        self.assertTrue(any(n.startswith("board after skeptic:") for n in notes), notes)

    def test_engines_down_leaves_a_note_and_the_run_carries_on(self) -> None:
        d, _ = engines_deps(refuse)
        g = build_graph(d, MemorySaver())
        out, cfg = start(g)
        self.assertIn("__interrupt__", out)
        state = g.get_state(cfg).values
        notes = [e["summary"] for e in state["trace"] if e["node"] == "world_model"]
        self.assertTrue(notes and all("not reachable" in n for n in notes), notes)
        self.assertTrue(state["hypotheses"])


class MemoryTest(FlagCase):
    hmem = True

    def test_recall_feeds_the_investigator_and_learn_stores_the_approved_run(self) -> None:
        fake = FakeEngines()
        d, llm = engines_deps(fake)
        g = build_graph(d, MemorySaver())
        out, cfg = start(g)
        payload = out["__interrupt__"][0].value
        self.assertEqual(payload["memories"], [RECALLED])

        paths = fake.paths()
        self.assertEqual(paths.count("/hmem/recall"), 1)
        self.assertLess(paths.index("/hmem/recall"), paths.index("/wm/hypotheses"))
        prompts = [user for lane, task, user in llm.calls if task == "investigator"]
        self.assertTrue(prompts)
        self.assertIn("PAST APPROVED FINDINGS", prompts[0])
        self.assertIn(RECALLED["content"], prompts[0])

        trail = nodes(g.get_state(cfg).values["trace"])
        self.assertEqual(trail[trail.index("investigator") - 1], "memory")

        out = g.invoke(Command(resume={"action": "approve", "reviewer": "ayush"}), cfg)
        (stored,) = fake.bodies("/hmem/store")
        self.assertEqual(stored["run_id"], "e1")
        self.assertEqual(stored["approval"], {"status": "approved", "reviewer": "ayush"})
        self.assertEqual([{k: v for k, v in c.items() if k != "entities"} for c in stored["claims"]], out["claims"])
        self.assertEqual(stored["event_id"], out["event_id"])
        last = out["trace"][-1]
        self.assertEqual(last["node"], "learn")
        self.assertIn(f"{len(out['claims'])} claim(s) stored in H-MEM", last["summary"])

    def test_a_rejected_run_writes_nothing(self) -> None:
        fake = FakeEngines()
        d, _ = engines_deps(fake)
        g = build_graph(d, MemorySaver())
        _, cfg = start(g)
        out = g.invoke(Command(resume={"action": "reject", "reviewer": "ayush"}), cfg)
        self.assertEqual(fake.bodies("/hmem/store"), [])
        self.assertEqual(out["trace"][-1]["node"], "learn")
        self.assertIn("approval is rejected", out["trace"][-1]["summary"])

    def test_the_revise_edge_does_not_recall_again_and_the_board_keeps_the_verdict(self) -> None:
        fake = FakeEngines()
        d, _ = engines_deps(fake, FakeNightshift({"investigator": planted_investigator}))
        g = build_graph(d, MemorySaver())
        _, cfg = start(g)
        state = g.get_state(cfg).values
        self.assertGreaterEqual(state["revise_rounds"], 1)
        self.assertNotIn("H3", {h["id"] for h in state["hypotheses"]})
        self.assertEqual(fake.paths().count("/hmem/recall"), 1)
        verdicts = {
            h["id"]: h["status"]
            for w in fake.bodies("/wm/hypotheses")
            if w["by"] == "floodsense-skeptic"
            for h in w["hypotheses"]
        }
        self.assertEqual(verdicts.get("H3"), "not_supported")

    def test_memory_down_keeps_the_run_and_the_approval(self) -> None:
        d, _ = engines_deps(refuse)
        g = build_graph(d, MemorySaver())
        out, cfg = start(g)
        self.assertEqual(out["__interrupt__"][0].value["memories"], [])
        out = g.invoke(Command(resume={"action": "approve", "reviewer": "ayush"}), cfg)
        self.assertEqual(out["status"], "approved")
        self.assertIn("store failed", out["trace"][-1]["summary"])
        self.assertIn("the approval stands", out["trace"][-1]["summary"])

    def test_flag_off_means_no_recall_and_no_store(self) -> None:
        settings.ff_hmem = False
        fake = FakeEngines()
        d, _ = engines_deps(fake)
        g = build_graph(d, MemorySaver())
        _, cfg = start(g)
        out = g.invoke(Command(resume={"action": "approve", "reviewer": "ayush"}), cfg)
        self.assertFalse([p for p in fake.paths() if p.startswith("/hmem")])
        self.assertNotIn("learn", nodes(out["trace"]))


def playbook_model(actions):
    def answer(system, user):
        return json.dumps({"actions": actions})

    return answer


class PlaybookCitesTest(unittest.TestCase):
    def run_playbook(self, actions) -> dict:
        llm = FakeNightshift({"playbook": playbook_model(actions)})
        d = Deps(zetaris=FakeZetaris(), llm=llm, memory=NoMemory())
        g = build_graph(d, MemorySaver(), ff_judge=False)
        out, cfg = start(g)
        return g.get_state(cfg).values

    def test_uncited_model_actions_are_dropped(self) -> None:
        state = self.run_playbook(
            [
                {"action_id": "A1", "horizon_h": 6, "text": "cited", "claim_ids": ["C1"]},
                {"action_id": "A2", "horizon_h": 24, "text": "cites nothing", "claim_ids": []},
                {"action_id": "A3", "horizon_h": 72, "text": "unknown claim", "claim_ids": ["C99"]},
            ]
        )
        self.assertEqual([a["action_id"] for a in state["playbook"]], ["A1"])
        note = next(e["summary"] for e in state["trace"] if e["node"] == "playbook")
        self.assertIn("2 uncited draft(s) dropped", note)

    def test_when_no_model_action_is_cited_the_standard_set_stays(self) -> None:
        state = self.run_playbook(
            [{"action_id": "X1", "horizon_h": 6, "text": "cites nothing", "claim_ids": []}]
        )
        self.assertNotIn("X1", [a["action_id"] for a in state["playbook"]])
        self.assertTrue(state["playbook"])


if __name__ == "__main__":
    unittest.main()
