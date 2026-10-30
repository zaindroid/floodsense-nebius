"""Graph, Skeptic and revise edge on the fake Zetaris and the fake Nightshift. No network."""

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

from langgraph.checkpoint.memory import MemorySaver  # noqa: E402
from langgraph.types import Command  # noqa: E402

from floodsense_agents import labelling  # noqa: E402
from floodsense_agents.events import spec  # noqa: E402
from floodsense_agents.graph import PLANNED_NODES, build_graph  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes import investigator  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


def deps(llm=None) -> Deps:
    return Deps(zetaris=FakeZetaris(), llm=llm or FakeNightshift(), memory=NoMemory())


def start(
    graph,
    rid="t1",
    event_id="EMSR773",
    question="Why are our Valencia sites at risk?",
    replay_ts=None,
):
    cfg = {"configurable": {"thread_id": rid}}
    ev = spec(event_id)
    req = {
        "question": question,
        "event_id": ev.event_id,
        "customer_id": "demo-insurer",
        "replay_ts": replay_ts,
        "lang": "en",
        "reviewer": None,
    }
    served_from, cached_at = labelling.computation_label(replay_ts, live=False)
    out = graph.invoke(
        {
            "run_id": rid,
            "thread_id": rid,
            "event_id": ev.event_id,
            "customer_id": "demo-insurer",
            "replay_ts": replay_ts,
            "request": req,
            "event": ev.as_dict(),
            "served_from": served_from,
            "cached_at": cached_at,
            "trace": [],
            "revise_rounds": 0,
            "repair_rounds": 0,
            "model_ids": [],
        },
        cfg,
    )
    return out, cfg


def planted_investigator(system, user):
    """Per-link model answers: one real claim for rain->catchment, and a planted
    false river->site link whose only claim is backed by no rows."""
    link = re.search(r"LINK: (\S+) (\S+)", user).group(2)
    if link == "rain->catchment":
        blocks = re.findall(r"query_id=(\S+) view=(\S+) rows=(\d+)", user)
        rain = next(q for q, v, n in blocks if v.endswith("hazard_timeline") and int(n) > 0)
        return json.dumps(
            {
                "statement": "Extreme rain over the catchment",
                "claims": [
                    {
                        "text": "Point chiva recorded a peak hour of 96 mm.",
                        "kind": "number",
                        "numbers": [96],
                        "query_ids": [rain],
                    }
                ],
            }
        )
    if link == "river->site":
        return json.dumps(
            {
                "statement": "The river flooded the Valencia city office",
                "claims": [
                    {
                        "text": "Flood water reached the Valencia city office.",
                        "kind": "fact",
                        "numbers": [],
                        "query_ids": [],
                    }
                ],
            }
        )
    return "{}"


class GraphTest(unittest.TestCase):
    def test_planned_nodes_are_all_wired(self) -> None:
        g = build_graph(deps(), MemorySaver(), ff_judge=True)
        nodes = set(g.get_graph().nodes)
        for n in PLANNED_NODES:
            self.assertIn(n, nodes)

    def test_chain_is_cited_and_pauses_for_approval(self) -> None:
        g = build_graph(deps(), MemorySaver(), ff_judge=True)
        out, cfg = start(g)
        self.assertIn("__interrupt__", out)
        p = out["__interrupt__"][0].value
        self.assertEqual(p["run_id"], "t1")
        self.assertEqual(p["event_id"], "EMSR773")
        self.assertEqual(
            [h["link"] for h in p["hypotheses"]],
            ["rain->catchment", "catchment->river", "river->site", "site->exposure"],
        )
        self.assertTrue(all(h["status"] == "supported" for h in p["hypotheses"]))
        self.assertTrue(all(h["rounds"] <= 3 for h in p["hypotheses"]))
        self.assertTrue(p["claims"])
        for c in p["claims"]:
            self.assertTrue(c["citations"], f"{c['claim_id']} has no citation")
            self.assertTrue(
                any(x["layer"] == "a" and x["query_id"] for x in c["citations"]),
                f"{c['claim_id']} has no layer (a) citation",
            )
        self.assertTrue(
            any(x["layer"] == "b" and x["licence"] for c in p["claims"] for x in c["citations"]),
            "layer (b) from provenance",
        )
        self.assertTrue(p["judge_summary"]["passes"])
        self.assertEqual(p["judge_summary"]["citation_coverage"], 1.0)
        self.assertEqual(len(p["judge"]), len(p["claims"]))
        self.assertTrue(p["exposure"]["policies"] > 0 and p["exposure"]["sum_insured_eur"] > 0)
        self.assertTrue(
            any(a["outbound"] for a in p["playbook"])
            and not any(a["released"] for a in p["playbook"])
        )
        self.assertEqual(p["served_from"], "replay")
        self.assertIsNotNone(p["cached_at"])
        self.assertEqual(g.get_state(cfg).next, ("hitl",))

    def test_trace_events_follow_the_contract(self) -> None:
        g = build_graph(deps(), MemorySaver(), ff_judge=True)
        _, cfg = start(g, rid="t1b")
        tr = g.get_state(cfg).values["trace"]
        self.assertEqual([e["seq"] for e in tr], list(range(1, len(tr) + 1)))
        for e in tr:
            for k in (
                "run_id",
                "seq",
                "ts",
                "node",
                "lane",
                "model_id",
                "latency_ms",
                "tokens",
                "summary",
                "evidence_ids",
            ):
                self.assertIn(k, e)
        self.assertEqual(
            [e["node"] for e in tr],
            ["scope", "watchers", "investigator", "skeptic", "exposure", "playbook", "judge"],
        )

    def test_replay_ts_hides_the_future(self) -> None:
        g = build_graph(deps(), MemorySaver(), ff_judge=True)
        out, _ = start(g, rid="t2", replay_ts="2024-10-29T12:00:00Z")
        p = out["__interrupt__"][0].value
        whens = [a["ts_utc"] for a in p["anomalies"]]
        self.assertTrue(whens and all(w <= "2024-10-29T12:00:00Z" for w in whens))
        self.assertFalse(
            any("2282" in c["text"] for c in p["claims"]),
            "the 17:55 peak is in the future at 12:00",
        )

    def test_ahr_2021_runs_too(self) -> None:
        g = build_graph(deps(), MemorySaver(), ff_judge=True)
        out, _ = start(
            g, rid="t3", event_id="ahr_2021", question="What happened on the Ahr in July 2021?"
        )
        p = out["__interrupt__"][0].value
        self.assertEqual(p["event_id"], "EMSR517")
        self.assertTrue(any("AHR01" in c["text"] for c in p["claims"]))

    def test_planted_false_hypothesis_is_not_supported_and_removed_on_revise(self) -> None:
        llm = FakeNightshift({"investigator": planted_investigator})
        g = build_graph(deps(llm), MemorySaver(), ff_judge=True)
        out, _ = start(g, rid="t4")
        p = out["__interrupt__"][0].value
        self.assertNotIn(
            "H3",
            {h["id"] for h in p["hypotheses"]},
            "the planted hypothesis must be removed on the revise edge",
        )
        self.assertFalse(
            any(c.get("hypothesis_id") == "H3" or "city office" in c["text"] for c in p["claims"])
        )
        skeptic_calls = [c for c in llm.calls if c[1] == "skeptic"]
        self.assertTrue(
            any("H3" in c[2] and "not_supported" in c[2] for c in skeptic_calls),
            "first pass judged H3 not_supported",
        )
        self.assertEqual(
            len([c for c in llm.calls if c[1] == "investigator"]),
            3,
            "one call per link; the revise edge does not call the model again",
        )

    def test_a_chain_the_skeptic_emptied_still_carries_a_summary(self) -> None:
        """Every hypothesis broken used to leave summary empty, and the desk's
        replay adapter drops a recorded run with no summary and shows its own
        fixture without reporting it."""
        node = investigator.make(deps())
        out = node(
            {
                "hypotheses": [
                    {
                        "id": "H1",
                        "link": "rain_to_discharge",
                        "statement": "Rain drove the discharge peak",
                        "citations": ["C1"],
                        "status": "not_supported",
                    }
                ],
                "claims": [{"claim_id": "C1", "text": "a claim", "hypothesis_id": "H1"}],
                "revise_rounds": 1,
                "summary": "what the first pass wrote",
                "trace": [],
            }
        )
        self.assertEqual(out["hypotheses"], [], "the Skeptic broke the only hypothesis")
        self.assertTrue(out["summary"], "an emptied chain still owes the analyst a summary")
        self.assertNotEqual(
            out["summary"],
            "what the first pass wrote",
            "the first pass described a case the Skeptic has since broken",
        )

    def test_skeptic_flag_off_skips_the_node(self) -> None:
        g = build_graph(deps(), MemorySaver(), ff_skeptic=False, ff_judge=False)
        self.assertNotIn("skeptic", set(g.get_graph().nodes))
        out, _ = start(g, rid="t5")
        self.assertIn("__interrupt__", out)
        self.assertEqual(out["__interrupt__"][0].value["judge"], [])


class HitlTest(unittest.TestCase):
    def test_approve_releases_outbound_actions_and_records_approval(self) -> None:
        g = build_graph(deps(), MemorySaver(), ff_judge=True)
        _, cfg = start(g, rid="h1")
        final = g.invoke(
            Command(resume={"action": "approve", "reviewer": "zain", "reviewer_note": "ok"}), cfg
        )
        self.assertEqual(final["status"], "approved")
        self.assertTrue(all(a["released"] for a in final["playbook"]))
        self.assertEqual(final["approval"]["status"], "approved")
        self.assertEqual(final["approval"]["decision"], "approve")
        self.assertEqual(final["approval"]["reviewer_note"], "ok")
        self.assertEqual(final["trace"][-1]["node"], "hitl")

    def test_edit_replaces_summary(self) -> None:
        g = build_graph(deps(), MemorySaver(), ff_judge=True)
        _, cfg = start(g, rid="h2")
        final = g.invoke(
            Command(resume={"action": "edit", "edits": "Analyst wording.", "reviewer": "mihir"}),
            cfg,
        )
        self.assertEqual(final["approval"]["status"], "edited")
        self.assertEqual(final["summary"], "Analyst wording.")
        self.assertEqual(final["approval"]["edits"], "Analyst wording.")

    def test_reject_releases_nothing(self) -> None:
        g = build_graph(deps(), MemorySaver(), ff_judge=True)
        _, cfg = start(g, rid="h3")
        final = g.invoke(
            Command(resume={"action": "reject", "reviewer_note": "wrong footprint"}), cfg
        )
        self.assertEqual(final["status"], "rejected")
        self.assertEqual(final["approval"]["status"], "rejected")
        self.assertFalse(any(a["released"] for a in final["playbook"]))

    def test_pause_survives_a_new_graph_on_the_same_checkpointer(self) -> None:
        saver = MemorySaver()
        g1 = build_graph(deps(), saver, ff_judge=True)
        _, cfg = start(g1, rid="h4")
        g2 = build_graph(deps(), saver, ff_judge=True)  # "process restart"
        final = g2.invoke(Command(resume={"action": "approve"}), cfg)
        self.assertEqual(final["status"], "approved")

    def test_sqlite_checkpointer_persists_across_processes(self) -> None:
        import sqlite3
        import tempfile
        from langgraph.checkpoint.sqlite import SqliteSaver

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "cp.sqlite")
            c1 = sqlite3.connect(path, check_same_thread=False)
            c2 = sqlite3.connect(path, check_same_thread=False)
            try:
                s1 = SqliteSaver(c1)
                s1.setup()
                _, cfg = start(build_graph(deps(), s1, ff_judge=True), rid="h5")
                s2 = SqliteSaver(c2)  # "process restart"
                final = build_graph(deps(), s2, ff_judge=True).invoke(
                    Command(resume={"action": "approve"}), cfg
                )
                self.assertEqual(final["status"], "approved")
            finally:
                # Windows will not unlink an open file, so the temp dir cannot
                # be cleaned up while either connection is still held.
                c1.close()
                c2.close()


if __name__ == "__main__":
    unittest.main()
