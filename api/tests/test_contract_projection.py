"""The API projection of a graph run validates against the shared schema.

No live Nightshift or Zetaris. The run is the in-process fake graph, the
same one the proxy test uses.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "agents"))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from jsonschema import Draft202012Validator  # noqa: E402
from jsonschema.exceptions import ValidationError  # noqa: E402

from app.project import _SCHEMA_MODEL_IDS, project_run  # noqa: E402

SCHEMA = json.loads(
    (ROOT / "contracts" / "schemas" / "floodsense.schema.json").read_text(encoding="utf-8")
)


def validator_for(def_name: str) -> Draft202012Validator:
    wrapper = {
        "$schema": SCHEMA["$schema"],
        "$defs": SCHEMA["$defs"],
        "$ref": f"#/$defs/{def_name}",
    }
    return Draft202012Validator(wrapper, format_checker=Draft202012Validator.FORMAT_CHECKER)


def _fake_run() -> dict:
    from fastapi.testclient import TestClient
    from langgraph.checkpoint.memory import MemorySaver

    from floodsense_agents import __main__ as service
    from floodsense_agents.graph import build_graph
    from floodsense_agents.nightshift import FakeNightshift
    from floodsense_agents.runtime import Runtime
    from floodsense_agents.state import Deps, NoMemory
    from floodsense_agents.zetaris import FakeZetaris

    deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
    service.set_runtime(Runtime(graph=build_graph(deps, MemorySaver(), ff_judge=True), deps=deps))
    client = TestClient(service.app)
    response = client.post(
        "/runs", json={"question": "Which sites are exposed?", "event_id": "EMSR773"}
    )
    if response.status_code != 201:
        raise AssertionError(response.text)
    return response.json()


class ProjectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.graph_run = _fake_run()
        cls.projected = project_run(cls.graph_run)
        if cls.projected is None:
            raise AssertionError("project_run returned nothing for a completed fake run")

    def test_answer_evidence_playbook_and_approval_match_the_schema(self) -> None:
        answer = self.projected["answer"]
        self.assertNotEqual(answer["served_from"], "live")
        self.assertEqual(answer["served_from"], "replay")
        self.assertIsNotNone(answer["cached_at"])
        try:
            validator_for("answer").validate(answer)
        except ValidationError as e:
            self.fail(f"answer failed schema: {e.message} at {list(e.absolute_path)}")
        self.assertTrue(answer["evidence"])
        self.assertTrue(answer["playbook_actions"])
        self.assertTrue(self.projected["approvals"])
        blob = json.dumps(self.projected)
        self.assertNotIn("urn:floodsense:query:", blob)
        self.assertNotIn("1970-01-01", blob)
        for row in answer["evidence"]:
            validator_for("evidence").validate(row)
            self.assertNotIn("source", row)
            self.assertNotIn("error", row)
        for row in answer["citations"]:
            self.assertTrue(row["source_url"].startswith(("http://", "https://")))
        for row in answer["playbook_actions"]:
            validator_for("playbook_action").validate(row)
        for row in self.projected["approvals"]:
            validator_for("approval").validate(row)
            self.assertIn(row["status"], ("pending", "approved", "edited", "rejected"))
            self.assertNotEqual(row["status"], "auto")

    def test_numbers_dropped_is_projected_and_matches_the_schema(self) -> None:
        import copy

        run = copy.deepcopy(self.graph_run)
        cid = run["claims"][0]["claim_id"]
        run["claims"][0]["numbers_dropped"] = [
            {"value": 2021, "reason": "date"},
            {"value": "bad", "reason": "x"},
        ]
        out = project_run(run)
        self.assertIsNotNone(out)
        claim = next(c for c in out["answer"]["claims"] if c["claim_id"] == cid)
        self.assertEqual(claim["numbers_dropped"], [{"value": 2021.0, "reason": "date"}])
        validator_for("answer").validate(out["answer"])
        judge = out["answer"].get("judge")
        if judge:
            row = next((c for c in judge["claims"] if c["claim_id"] == cid), None)
            if row is not None:
                self.assertEqual(row["numbers_dropped"], [{"value": 2021.0, "reason": "date"}])
        # Absent stays absent.
        self.assertNotIn("numbers_dropped", self.projected["answer"]["claims"][-1])

    def test_a_live_label_is_not_invented_for_a_seed_run(self) -> None:
        self.assertNotEqual(self.graph_run["served_from"], "live")
        self.assertEqual(self.projected["answer"]["served_from"], self.graph_run["served_from"])

    def test_the_judge_is_omitted_when_the_graph_id_is_outside_the_schema(self) -> None:
        schema_ids = set(SCHEMA["$defs"]["judge_claim"]["properties"]["model_id"]["enum"])
        graph_ids = [
            row.get("model_id")
            for row in self.graph_run.get("judge") or []
            if isinstance(row, dict)
        ]
        self.assertTrue(graph_ids)
        judge = self.projected["answer"].get("judge")
        if judge is None:
            self.assertTrue(any(model_id not in schema_ids for model_id in graph_ids))
        else:
            by_claim = {
                row["claim_id"]: row.get("model_id")
                for row in self.graph_run["judge"]
                if isinstance(row, dict)
            }
            for claim in judge["claims"]:
                self.assertEqual(claim["model_id"], by_claim[claim["claim_id"]])
                self.assertIn(claim["model_id"], schema_ids)
        blob = json.dumps(self.projected)
        for invented in schema_ids:
            if invented not in graph_ids:
                self.assertNotIn(invented, blob)


def _minimal_run(**overrides) -> dict:
    body = {
        "run_id": "r1",
        "question": "Which sites?",
        "served_from": "replay",
        "cached_at": "2024-10-29T12:00:00Z",
        "claims": [
            {
                "claim_id": "C1",
                "text": "Seven policies.",
                "citations": [
                    {
                        "citation_id": "C1-b1",
                        "claim_id": "C1",
                        "layer": "b",
                        "source_url": "https://example.com/data",
                        "title": "discharge",
                        "publisher": "Open-Meteo",
                        "accessed_at": "2024-10-29T12:00:00Z",
                        "licence": "CC BY 4.0",
                        "attribution": "Open-Meteo",
                    }
                ],
            }
        ],
        "evidence": [
            {
                "query_id": "q-ok",
                "view": "floodsense_seed.discharge_daily",
                "sql": "SELECT 1",
                "rows_sample": [{"v": 1}],
                "row_count": 1,
                "executed_at_utc": "2024-10-29T12:00:00Z",
            },
            {
                "query_id": "q-bad",
                "view": "floodsense_seed.discharge_daily",
                "sql": "SELECT 1",
                "rows_sample": [],
                "row_count": 0,
                "executed_at_utc": "2024-10-29T12:00:00Z",
                "error": "connection reset",
            },
        ],
        "judge": [
            {
                "claim_id": "C1",
                "grounding": "supported",
                "citation_faithful": True,
                "numbers_match": True,
                "score": 1,
                "rationale": "matches the row",
                "model_id": "fake-deep",
            }
        ],
        "judge_summary": {"overall": 1},
        "approval": {"status": "awaiting"},
        "playbook": [
            {"action_id": "A1", "text": "Call the site.", "claim_ids": ["C1"]},
        ],
    }
    body.update(overrides)
    return body


class ProjectionHonestyTest(unittest.TestCase):
    def test_an_error_row_is_omitted_rather_than_shown_as_empty_success(self) -> None:
        projected = project_run(_minimal_run())
        self.assertIsNotNone(projected)
        ids = [row["query_id"] for row in projected["answer"]["evidence"]]
        self.assertEqual(ids, ["q-ok"])
        self.assertNotIn("error", json.dumps(projected["evidence"]))

    def test_a_layer_c_locator_and_chunk_id_survive_projection(self) -> None:
        body = _minimal_run()
        body["claims"][0]["citations"].append(
            {
                "citation_id": "C1-c1",
                "claim_id": "C1",
                "layer": "c",
                "source_url": (
                    "https://hess.copernicus.org/articles/29/6715/2025/hess-29-6715-2025.pdf"
                ),
                "title": "HESS",
                "publisher": "Copernicus Publications",
                "accessed_at": "2024-10-29T12:00:00Z",
                "licence": "CC-BY-4.0",
                "attribution": "Rombeek, Hrachowitz, and Uijlenhoet (2025), CC BY 4.0",
                "quote": "line one",
                "content_sha256": "ab" * 32,
                "storage": "full_text",
                "query_id": "qid-9",
                "chunk_id": "hess-29-6715-2025/p12/para3",
                "locator": {"page": 12, "paragraph": 3, "lines": "1-2", "section": None},
            }
        )
        projected = project_run(body)
        self.assertIsNotNone(projected)
        layer_c = [row for row in projected["answer"]["citations"] if row["layer"] == "c"]
        self.assertEqual(len(layer_c), 1)
        self.assertEqual(layer_c[0]["locator"], {"page": 12, "paragraph": 3, "lines": "1-2"})
        self.assertEqual(layer_c[0]["chunk_id"], "hess-29-6715-2025/p12/para3")
        self.assertEqual(layer_c[0]["query_id"], "qid-9")
        self.assertEqual(layer_c[0]["storage"], "full_text")
        validator_for("citation").validate(layer_c[0])

    def test_javascript_and_a_bare_scheme_are_not_citation_links(self) -> None:
        body = _minimal_run()
        good = body["claims"][0]["citations"][0]
        body["claims"][0]["citations"] = [
            {**good, "citation_id": "C1-b1", "source_url": "javascript:alert(1)"},
            {**good, "citation_id": "C1-b2", "source_url": "https://example.com/data"},
            {**good, "citation_id": "C1-b3", "source_url": "https://"},
            {**good, "citation_id": "C1-b4", "source_url": "http://example.com/data"},
            {**good, "citation_id": "C1-b5", "source_url": "https://[::1"},
        ]
        projected = project_run(body)
        self.assertIsNotNone(projected)
        urls = [row["source_url"] for row in projected["answer"]["citations"]]
        self.assertEqual(urls, ["https://example.com/data", "http://example.com/data"])

    def test_a_citation_without_an_http_url_is_omitted(self) -> None:
        body = _minimal_run()
        body["claims"][0]["citations"] = [
            {
                "citation_id": "C1-a1",
                "claim_id": "C1",
                "layer": "a",
                "query_id": "q-ok",
                "title": "floodsense_seed.discharge_daily",
                "accessed_at": "2024-10-29T12:00:00Z",
            }
        ]
        self.assertIsNone(project_run(body))

    def test_a_missing_timestamp_is_not_filled_with_the_epoch(self) -> None:
        body = _minimal_run()
        body["claims"][0]["citations"][0].pop("accessed_at")
        self.assertIsNone(project_run(body))
        body = _minimal_run()
        body["cached_at"] = None
        body.pop("replay_ts", None)
        self.assertIsNone(project_run(body))

    def test_a_zetaris_timestamp_is_a_timestamp(self) -> None:
        """Zetaris returns 2026-10-23 00:00:00.0. Rejecting the fraction dropped
        the citation it timed, and with no citation left the whole projection
        was None, so a live run carried no contract at all."""
        body = _minimal_run()
        body["claims"][0]["citations"][0]["accessed_at"] = "2026-10-23 00:00:00.0"
        projected = project_run(body)
        self.assertIsNotNone(projected)
        cited = projected["answer"]["citations"][0]
        self.assertEqual(cited["accessed_at"], "2026-10-23T00:00:00Z")

    def test_auto_approval_is_not_rewritten_to_approved(self) -> None:
        projected = project_run(_minimal_run(approval={"status": "auto"}))
        self.assertEqual(projected["approvals"], [])

    def test_projection_model_ids_match_the_schema_enum(self) -> None:
        schema_ids = SCHEMA["$defs"]["judge_claim"]["properties"]["model_id"]["enum"]
        self.assertEqual(_SCHEMA_MODEL_IDS, frozenset(schema_ids))

    def test_lane_and_recorded_model_ids_keep_the_judge(self) -> None:
        accepted = (
            "meterless/fast",
            "meterless/deep",
            "nvidia/nemotron-3.5-super-vl-120b-a12b",
            "nvidia/nemotron-3.5-lightning-30b-a3b",
            "nvidia/Nemotron-3.5-Super-VL",
            "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
            "deterministic",
        )
        for model_id in accepted:
            body = _minimal_run()
            body["judge"][0]["model_id"] = model_id
            projected = project_run(body)
            judge = projected["answer"]["judge"]
            validator_for("judge").validate(judge)
            validator_for("approval").validate(projected["approvals"][0])
            self.assertEqual(judge["claims"][0]["model_id"], model_id)
            self.assertEqual(
                projected["approvals"][0]["judge"]["claims"][0]["model_id"],
                model_id,
            )

    def test_one_id_outside_the_enum_drops_the_whole_judge(self) -> None:
        body = _minimal_run()
        body["judge"][0]["model_id"] = "meterless/deep"
        body["judge"].append(
            {
                "claim_id": "C2",
                "grounding": "partial",
                "citation_faithful": True,
                "numbers_match": True,
                "score": 0.5,
                "rationale": "partial match",
                "model_id": "fake-fast",
            }
        )
        projected = project_run(body)
        self.assertNotIn("judge", projected["answer"])
        self.assertNotIn("judge", projected["approvals"][0])
        blob = json.dumps(projected)
        self.assertNotIn("meterless/deep", blob)
        self.assertNotIn("fake-fast", blob)

    def test_ids_outside_the_enum_omit_the_judge(self) -> None:
        schema_ids = set(SCHEMA["$defs"]["judge_claim"]["properties"]["model_id"]["enum"])
        outside = (
            "fake-deep",
            "fake-fast",
            "meterless/auto",
            "nvidia/nemotron-3-super-120b-a12b",
        )
        for model_id in outside:
            body = _minimal_run()
            body["judge"][0]["model_id"] = model_id
            projected = project_run(body)
            self.assertNotIn("judge", projected["answer"], model_id)
            self.assertNotIn("judge", projected["approvals"][0])
            blob = json.dumps(projected)
            self.assertNotIn(model_id, blob)
            for invented in schema_ids:
                self.assertNotIn(invented, blob)


if __name__ == "__main__":
    unittest.main()
