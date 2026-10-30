"""LLM-as-a-Judge: deterministic checks, model floor, repair round. No network."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")

from langgraph.checkpoint.memory import MemorySaver  # noqa: E402

from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import Citation, Claim, Evidence  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes.judge import evaluate, score_claim, run as judge_run  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402
from tests.test_graph import start  # noqa: E402


def ev(qid: str, rows: list[dict]) -> Evidence:
    return Evidence(
        query_id=qid,
        view="floodsense_seed.hazard_timeline",
        sql="SELECT 1",
        rows_sample=rows,
        row_count=len(rows),
        executed_at_utc="2026-10-22T20:00:00Z",
    )


def claim(cid: str, text: str, numbers: list[float], qids: list[str]) -> Claim:
    return Claim(
        claim_id=cid,
        text=text,
        kind="number" if numbers else "fact",
        numbers=numbers,
        citations=[
            Citation(citation_id=f"{cid}-a{i}", claim_id=cid, layer="a", query_id=q)
            for i, q in enumerate(qids, 1)
        ],
    )


class JudgeTest(unittest.TestCase):
    E = {
        "q1": ev(
            "q1",
            [
                {"station_name": "Chiva", "rain_mm": 96.0},
                {"station_name": "Chiva", "rain_mm": 88.0},
            ],
        ),
        "q0": ev("q0", []),
    }

    def test_deterministic_checks(self) -> None:
        claims = [
            claim("C1", "Chiva peaked at 96 mm in one hour.", [96], ["q1"]),
            claim(
                "C2", "Chiva recorded 184 mm over the two hours.", [184], ["q1"]
            ),  # sum of the column
            claim("C3", "Chiva recorded 300 mm.", [300], ["q1"]),  # not in the rows
            claim("C4", "The gauge failed.", [], ["q0"]),  # cited query returned nothing
            claim("C5", "It rained.", [], []),
        ]  # no citation
        scores, rep = evaluate(claims, self.E, None)
        g = {s.claim_id: s.grounding for s in scores}
        self.assertEqual(
            g,
            {
                "C1": "supported",
                "C2": "supported",
                "C3": "unsupported",
                "C4": "unsupported",
                "C5": "unsupported",
            },
        )
        self.assertEqual(rep.n_claims, 5)
        self.assertAlmostEqual(rep.hallucination_rate, 0.6)
        self.assertAlmostEqual(rep.citation_coverage, 0.8)
        self.assertFalse(rep.passes)
        self.assertEqual(rep.flagged_claim_ids, ["C3", "C4", "C5"])
        self.assertTrue(all(0 <= s.score <= 1 for s in scores))

    def test_model_grounding_used_but_numbers_floor_wins(self) -> None:
        def judge_llm(system, user):
            return json.dumps({"grounding": "supported", "rationale": "looks fine"})

        deps = Deps(
            zetaris=FakeZetaris(), llm=FakeNightshift({"judge": judge_llm}), memory=NoMemory()
        )
        scores, rep = evaluate(
            [
                claim("C1", "Chiva recorded 300 mm.", [300], ["q1"]),
                claim("C2", "Chiva peaked at 96 mm.", [96], ["q1"]),
            ],
            self.E,
            deps,
        )
        g = {s.claim_id: s.grounding for s in scores}
        self.assertEqual(g["C2"], "supported")
        self.assertEqual(
            g["C1"],
            "partial",
            "a number absent from the rows can never be 'supported', whatever the model says",
        )
        self.assertTrue(all(s.model_id == "fake-deep" for s in scores))

    def test_bad_json_records_deterministic(self) -> None:
        def judge_llm(system, user):
            return "not json at all"

        llm = FakeNightshift({"judge": judge_llm})
        deps = Deps(zetaris=FakeZetaris(), llm=llm, memory=NoMemory())
        scores, rep = evaluate(
            [claim("C1", "Chiva peaked at 96 mm in one hour.", [96], ["q1"])],
            self.E,
            deps,
        )
        self.assertEqual([lane for lane, _task, _user in llm.calls], ["deep"])
        self.assertEqual(scores[0].grounding, "supported")
        self.assertEqual(scores[0].model_id, "deterministic")
        self.assertEqual(rep.model_id, "deterministic")

    def test_empty_object_records_deterministic(self) -> None:
        def judge_llm(system, user):
            return "{}"

        llm = FakeNightshift({"judge": judge_llm})
        deps = Deps(zetaris=FakeZetaris(), llm=llm, memory=NoMemory())
        scores, rep = evaluate(
            [claim("C1", "Chiva peaked at 96 mm in one hour.", [96], ["q1"])],
            self.E,
            deps,
        )
        self.assertEqual([lane for lane, _task, _user in llm.calls], ["deep"])
        self.assertEqual(scores[0].grounding, "supported")
        self.assertEqual(scores[0].model_id, "deterministic")
        self.assertEqual(rep.model_id, "deterministic")

    def test_empty_claims_fail(self) -> None:
        scores, rep = evaluate([], {}, None)
        self.assertFalse(rep.passes)
        self.assertEqual(rep.hallucination_rate, 1.0)

    def test_skeleton_run_surface(self) -> None:
        out = judge_run(
            {
                "run_id": "r",
                "claims": [claim("C1", "x 96", [96], ["q1"]).model_dump()],
                "evidence": {"q1": self.E["q1"].model_dump()},
            }
        )
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["scores"][0]["grounding"], "supported")


class RepairTest(unittest.TestCase):
    def test_flagged_claim_gets_one_repair_round_and_stays_visible(self) -> None:
        def investigator(system, user):
            import re

            blocks = re.findall(r"query_id=(\S+) view=(\S+) rows=(\d+)", user)
            rain = next(q for q, v, n in blocks if v.endswith("hazard_timeline") and int(n) > 0)
            return json.dumps(
                {
                    "hypotheses": [
                        {
                            "id": "H1",
                            "link": "rain->catchment",
                            "statement": "Extreme rain",
                            "claim_ids": ["C1", "C2"],
                        }
                    ],
                    "claims": [
                        {
                            "claim_id": "C1",
                            "text": "Chiva peaked at 96 mm in one hour.",
                            "kind": "number",
                            "numbers": [96],
                            "query_ids": [rain],
                            "hypothesis_id": "H1",
                        },
                        {
                            "claim_id": "C2",
                            "text": "Chiva recorded 999 mm.",
                            "kind": "number",
                            "numbers": [999],
                            "query_ids": [rain],
                            "hypothesis_id": "H1",
                        },
                    ],
                    "summary": "Rain [C1][C2].",
                }
            )

        llm = FakeNightshift({"investigator": investigator})
        g = build_graph(
            Deps(zetaris=FakeZetaris(), llm=llm, memory=NoMemory()), MemorySaver(), ff_judge=True
        )
        out, _ = start(g, rid="j1")
        payload = out["__interrupt__"][0].value
        c2 = next(c for c in payload["claims"] if c["claim_id"] == "C2")
        self.assertTrue(
            c2["text"].startswith("[repaired]"),
            "the Playbook repaired the flagged claim; nothing was deleted",
        )
        self.assertEqual(
            payload["judge_summary"]["flagged_claim_ids"],
            [],
            "after the repair the number-free claim is supported",
        )
        self.assertEqual(len(payload["judge"]), len(payload["claims"]))
        self.assertIn("C1", {c["claim_id"] for c in payload["claims"]})


class LayerCFaithfulTest(unittest.TestCase):
    def test_layer_c_must_be_a_substring_of_text(self) -> None:
        text = "The gauge at Altenahr rose."
        digest = hashlib.sha256(text.encode()).hexdigest()
        quote = "The gauge at Altenahr rose."
        claim = Claim(
            claim_id="C1",
            text="Altenahr rose.",
            citations=[
                Citation(citation_id="C1-a1", claim_id="C1", layer="a", query_id="q1"),
                Citation(
                    citation_id="C1-c1",
                    claim_id="C1",
                    layer="c",
                    query_id="q1",
                    quote=quote,
                    content_sha256=hashlib.sha256(quote.encode()).hexdigest(),
                ),
            ],
        )
        evidence = {
            "q1": Evidence(
                query_id="q1",
                view="PGVECTOR_RAG.chunks",
                sql="SELECT text FROM PGVECTOR_RAG.chunks WHERE chunk_id = 'kept'",
                rows_sample=[{"text": text, "text_sha256": digest, "rain_mm": 1}],
                row_count=1,
                executed_at_utc="2026-10-26T12:00:00Z",
            )
        }
        score = score_claim(claim, evidence, None)
        self.assertTrue(score.citation_faithful)
        bad = claim.model_copy(deep=True)
        bad.citations[1].quote = "This sentence is not in the passage."
        bad.citations[1].content_sha256 = hashlib.sha256(
            bad.citations[1].quote.encode()
        ).hexdigest()
        self.assertFalse(score_claim(bad, evidence, None).citation_faithful)
        alone = Claim(
            claim_id="C2",
            text="Altenahr rose.",
            citations=[bad.citations[1]],
        )
        self.assertFalse(score_claim(alone, evidence, None).citation_faithful)
        wrong_hash = claim.model_copy(deep=True)
        wrong_hash.citations[1].content_sha256 = "0" * 64
        self.assertFalse(score_claim(wrong_hash, evidence, None).citation_faithful)
        wrong_row = claim.model_copy(deep=True)
        drifted = {
            "q1": evidence["q1"].model_copy(
                update={"rows_sample": [{"text": text, "text_sha256": "ab" * 32, "rain_mm": 1}]}
            )
        }
        self.assertFalse(score_claim(wrong_row, drifted, None).citation_faithful)

    def test_each_hit_under_one_query_id_matches_its_own_passage(self) -> None:
        first = "The gauge at Altenahr rose."
        second = "Paiporta recorded 140 mm in six hours."
        self.assertNotIn("140 mm", first)
        later = "140 mm in six hours."
        claim = Claim(
            claim_id="C1",
            text="Altenahr rose and Paiporta recorded 140 mm.",
            citations=[
                Citation(citation_id="C1-a1", claim_id="C1", layer="a", query_id="q-sql"),
                Citation(
                    citation_id="C1-c1",
                    claim_id="C1",
                    layer="c",
                    query_id="qid",
                    chunk_id="kept",
                    quote=first,
                    content_sha256=hashlib.sha256(first.encode()).hexdigest(),
                ),
                Citation(
                    citation_id="C1-c2",
                    claim_id="C1",
                    layer="c",
                    query_id="qid",
                    chunk_id="other",
                    quote=later,
                    content_sha256=hashlib.sha256(later.encode()).hexdigest(),
                ),
            ],
        )
        evidence = {
            "q-sql": Evidence(
                query_id="q-sql",
                view="floodsense_seed.hazard_timeline",
                sql="SELECT 1",
                rows_sample=[{"rain_mm": 1}],
                row_count=1,
                executed_at_utc="2026-10-26T12:00:00Z",
            ),
            "qid": Evidence(
                query_id="qid",
                view="PGVECTOR_RAG.chunks",
                sql="SELECT text FROM PGVECTOR_RAG.chunks",
                rows_sample=[
                    {
                        "chunk_id": "kept",
                        "text": first,
                        "text_sha256": hashlib.sha256(first.encode()).hexdigest(),
                    },
                    {
                        "chunk_id": "other",
                        "text": second,
                        "text_sha256": hashlib.sha256(second.encode()).hexdigest(),
                    },
                ],
                row_count=2,
                executed_at_utc="2026-10-26T12:00:00Z",
            ),
        }
        self.assertTrue(score_claim(claim, evidence, None).citation_faithful)
        swapped = claim.model_copy(deep=True)
        swapped.citations[2].chunk_id = "kept"
        self.assertFalse(score_claim(swapped, evidence, None).citation_faithful)


if __name__ == "__main__":
    unittest.main()
