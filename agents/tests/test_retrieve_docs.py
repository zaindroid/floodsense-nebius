"""retrieve_docs and its Investigator hook. No network."""

from __future__ import annotations

import hashlib
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

from floodsense_agents import retrieve_docs as retrieve_mod  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import Citation, Claim, Evidence, RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes.investigator import _attach_documents  # noqa: E402
from floodsense_agents.nodes.judge import score_claim  # noqa: E402
from floodsense_agents.retrieve_docs import retrieve_docs  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402
from tests.test_graph import start  # noqa: E402


class RetrieveDocsTest(unittest.TestCase):
    def test_empty_search_returns_no_citations(self) -> None:
        def hydrate(ids):
            raise AssertionError(ids)

        result = retrieve_docs(
            "rain in Paiporta",
            4,
            {"event_id": "EMSR773"},
            embedder=lambda texts, input_type: [[0.0] * 2048],
            search=lambda vector, event_id, k: [],
            hydrate=hydrate,
        )
        self.assertEqual(result.citations, [])
        self.assertIsNone(result.error)

    def test_k_out_of_range_is_a_tool_error(self) -> None:
        def unused(*_args, **_kwargs):
            raise AssertionError("k is rejected before embed, search, or hydrate")

        result = retrieve_docs(
            "q", 0, {"event_id": "EMSR773"}, embedder=unused, search=unused, hydrate=unused
        )
        self.assertEqual(result.citations, [])
        self.assertIn("1 to 20", result.error)

    def test_quote_is_a_substring_and_hashes(self) -> None:
        text = "line one\nline two stays under six hundred"
        row = {
            "chunk_id": "hess-29-6715-2025/p12/para3",
            "text": text,
            "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "title": "HESS",
            "source_url": "https://hess.copernicus.org/articles/29/6715/2025/hess-29-6715-2025.pdf",
            "publisher": "Copernicus Publications",
            "licence": "CC-BY-4.0",
            "attribution": "Rombeek, Hrachowitz, and Uijlenhoet (2025), CC BY 4.0",
            "page": 12,
            "paragraph": 3,
            "lines": "1-2",
            "section": None,
        }

        def embedder(texts, input_type):
            self.assertEqual(input_type, "query")
            return [[0.1] * 2048]

        result = retrieve_docs(
            "rainfall",
            1,
            {"event_id": "EMSR773"},
            embedder=embedder,
            search=lambda vector, event_id, k: [(row["chunk_id"], 0.2)],
            hydrate=lambda ids: ("qid-9", [row]),
        )
        citation = result.citations[0]
        self.assertEqual(citation["query_id"], "qid-9")
        self.assertEqual(citation["storage"], "full_text")
        self.assertIn(citation["quote"], text)
        self.assertLessEqual(len(citation["quote"]), 600)
        self.assertEqual(
            citation["content_sha256"], hashlib.sha256(citation["quote"].encode()).hexdigest()
        )
        self.assertEqual(citation["locator"]["page"], 12)
        self.assertEqual(citation["chunk_id"], row["chunk_id"])
        self.assertNotIn("distance", citation)

    def test_missing_hydrate_row_is_dropped(self) -> None:
        kept = {
            "chunk_id": "kept",
            "text": "The Ahr rose at Altenahr.",
            "text_sha256": hashlib.sha256(b"The Ahr rose at Altenahr.").hexdigest(),
            "title": "EMSR517",
            "source_url": "https://mapping.emergency.copernicus.eu/activations/EMSR517",
            "publisher": "Copernicus Emergency Management Service",
            "licence": "CEMS On-Demand Mapping terms",
            "attribution": "Copernicus Emergency Management Service (© 2021 European Union), EMSR517",
            "page": 1,
            "paragraph": 1,
            "lines": "1-1",
            "section": None,
        }
        result = retrieve_docs(
            "q",
            2,
            {"event_id": "EMSR517"},
            embedder=lambda texts, input_type: [[0.0] * 2048],
            search=lambda vector, event_id, k: [("kept", 0.1), ("gone", 0.2)],
            hydrate=lambda ids: ("qid", [kept]),
        )
        self.assertEqual([c["chunk_id"] for c in result.citations], ["kept"])

    def test_event_sql_stays_event_scoped(self) -> None:
        for statement in (retrieve_mod._HALFVEC_SQL, retrieve_mod._EXACT_SQL):
            self.assertIn("($2::text IS NULL OR event_id = $2)", statement)
            self.assertNotIn("event_id IS NULL", statement)
        for statement in (retrieve_mod._GENERIC_HALFVEC_SQL, retrieve_mod._GENERIC_EXACT_SQL):
            self.assertIn("event_id IS NULL", statement)
            self.assertIn("doc_id = ANY($2)", statement)

    def test_committed_scope_file_loads(self) -> None:
        scope = retrieve_mod.load_scope()
        self.assertEqual(scope.get("boe-a-2004-18910"), "ES")
        self.assertEqual(scope.get("eiopa-19-485"), "EU")


class GenericRankingTest(unittest.TestCase):
    """A fake vector table: the event top k is never displaced, generic passages are
    appended (at most 2), and a Spain-only document never reaches an EMSR517 run."""

    # chunk_id, event_id, doc_id, vector. The query vector is (1, 0).
    CHUNKS = (
        ("ev773-a", "EMSR773", "hess", (0.60, 0.80)),
        ("ev773-b", "EMSR773", "hess", (0.50, 0.87)),
        ("ev773-c", "EMSR773", "s19", (0.30, 0.95)),
        ("ev517-a", "EMSR517", "nhess", (0.55, 0.83)),
        ("ev517-b", "EMSR517", "nhess", (0.40, 0.92)),
        ("eu-1", None, "eea", (0.99, 0.10)),
        ("eu-2", None, "eiopa", (0.98, 0.20)),
        ("eu-3", None, "eea", (0.97, 0.24)),
        ("es-1", None, "boe", (1.00, 0.00)),
        ("de-1", None, "de-only", (0.995, 0.05)),
    )
    SCOPE = {"eea": "EU", "eiopa": "EU", "boe": "ES", "de-only": "DE"}

    @staticmethod
    def _distance(vector: list[float], other: tuple[float, float]) -> float:
        dot = sum(a * b for a, b in zip(vector, other, strict=True))
        norm = (sum(a * a for a in vector) * sum(b * b for b in other)) ** 0.5
        return 1.0 - dot / norm

    def _search(self, vector, event_id, k):
        rows = [c for c in self.CHUNKS if event_id is None or c[1] == event_id]
        ranked = sorted(rows, key=lambda c: self._distance(vector, c[3]))
        return [(c[0], self._distance(vector, c[3])) for c in ranked[:k]]

    def _generic(self, vector, doc_ids, k):
        rows = [c for c in self.CHUNKS if c[1] is None and c[2] in doc_ids]
        ranked = sorted(rows, key=lambda c: self._distance(vector, c[3]))
        return [(c[0], self._distance(vector, c[3])) for c in ranked[:k]]

    @staticmethod
    def _hydrate(ids):
        return "q-1", [_hit_row(chunk_id, f"text of {chunk_id}", 1) for chunk_id in ids]

    def _run(self, query: str, event_id: str, k: int = 2, role: str | None = None):
        filters = {"event_id": event_id, **({"role": role} if role else {})}
        result = retrieve_docs(
            query,
            k,
            filters,
            embedder=lambda texts, _kind: [[1.0, 0.0]],
            search=self._search,
            hydrate=self._hydrate,
            search_generic=self._generic,
            scope=self.SCOPE,
        )
        self.assertIsNone(result.error)
        return [c["chunk_id"] for c in result.citations]

    def test_event_passages_lead_and_generic_is_capped(self) -> None:
        ids = self._run("What share of flood losses was insured?", "EMSR773", k=2)
        # Generic chunks are closer to the query, yet the event top 2 comes first.
        self.assertEqual(ids[:2], ["ev773-a", "ev773-b"])
        self.assertEqual(len(ids), 2 + retrieve_mod.GENERIC_MAX)
        self.assertEqual(ids[2:], ["es-1", "eu-1"])

    def test_spanish_document_never_reaches_the_ahr_run(self) -> None:
        ids = self._run("insurance protection gap", "EMSR517", k=2)
        self.assertEqual(ids[:2], ["ev517-a", "ev517-b"])
        self.assertNotIn("es-1", ids)
        self.assertEqual(ids[2:], ["de-1", "eu-1"])

    def test_german_document_never_reaches_the_valencia_run(self) -> None:
        ids = self._run("insured losses", "EMSR773", k=3)
        self.assertNotIn("de-1", ids)
        self.assertEqual(ids[:3], ["ev773-a", "ev773-b", "ev773-c"])

    def test_watch_run_reads_only_event_agnostic_documents(self) -> None:
        ids = self._run("When did the Elbe flood?", "LIVE-EU", k=4)
        self.assertEqual(ids, ["es-1", "de-1", "eu-1", "eu-2"])
        self.assertFalse(any(i.startswith("ev") for i in ids))

    def test_watch_run_with_a_country_keeps_that_country_and_eu(self) -> None:
        result = retrieve_docs(
            "When did the Elbe flood?",
            4,
            {"event_id": "LIVE-EU", "country": "de"},
            embedder=lambda texts, _kind: [[1.0, 0.0]],
            search=self._search,
            hydrate=self._hydrate,
            search_generic=self._generic,
            scope=self.SCOPE,
        )
        self.assertIsNone(result.error)
        self.assertEqual(
            [c["chunk_id"] for c in result.citations], ["de-1", "eu-1", "eu-2", "eu-3"]
        )

    def test_committed_scope_has_the_river_history_documents(self) -> None:
        watch = retrieve_mod.load_watch_scope()
        self.assertEqual(watch.get("wiki-2002-european-floods"), "EU")
        self.assertIn("wiki-2002-european-floods", retrieve_mod.watch_doc_ids(watch, "CZ"))
        self.assertNotIn("wiki-seine", retrieve_mod.watch_doc_ids(watch, "DE"))

    def test_river_history_never_takes_an_insurer_slot_in_an_event_run(self) -> None:
        scope = retrieve_mod.load_scope()
        self.assertIn("eiopa-19-485", scope)
        for event in ("EMSR773", "EMSR517"):
            allowed = retrieve_mod.generic_doc_ids(event, scope)
            self.assertTrue(allowed)
            self.assertFalse([d for d in allowed if d.startswith("wiki-")])

    def test_wiki_chunks_nearer_than_eiopa_do_not_displace_it_in_event_runs(self) -> None:
        chunks = (
            ("wiki-near", "wiki-2013-european-floods", (1.0, 0.0)),
            ("eiopa-far", "eiopa-19-485", (0.6, 0.8)),
        )

        def generic(vector, doc_ids, k):
            rows = [c for c in chunks if c[1] in doc_ids]
            return [(c[0], 1.0 - c[2][0]) for c in rows][:k]

        result = retrieve_docs(
            "insurance protection gap",
            1,
            {"event_id": "EMSR773"},
            embedder=lambda texts, _kind: [[1.0, 0.0]],
            search=lambda v, e, k: [("ev", 0.1)],
            hydrate=lambda ids: ("q", [_hit_row(i, f"text {i}", 1) for i in ids]),
            search_generic=generic,
        )
        self.assertEqual([c["chunk_id"] for c in result.citations], ["ev", "eiopa-far"])

    def test_no_generic_without_insurer_words_or_role(self) -> None:
        self.assertEqual(
            self._run("How much rain fell in Chiva?", "EMSR773"), ["ev773-a", "ev773-b"]
        )
        ids = self._run("How much rain fell in Chiva?", "EMSR773", role="insurer")
        self.assertEqual(ids, ["ev773-a", "ev773-b", "es-1", "eu-1"])

    def test_bare_loss_or_claims_does_not_pull_generic(self) -> None:
        for query in ("What losses did Paiporta see?", "Which claims came in?", "loss of power"):
            self.assertFalse(retrieve_mod.wants_generic(query, {"event_id": "EMSR773"}), query)
        for query in (
            "economic losses 1980-2023",
            "insured loss share",
            "claims paid by the Consorcio",
            "Versicherungsdichte",
            "seguro de inundación",
            "protection gap",
            "policy wording",
        ):
            self.assertTrue(retrieve_mod.wants_generic(query, None), query)

    def test_generic_citations_are_flagged(self) -> None:
        result = retrieve_docs(
            "insured losses",
            2,
            {"event_id": "EMSR773"},
            embedder=lambda texts, _kind: [[1.0, 0.0]],
            search=self._search,
            hydrate=self._hydrate,
            search_generic=self._generic,
            scope=self.SCOPE,
        )
        flags = {c["chunk_id"]: c.get("generic", False) for c in result.citations}
        self.assertEqual(flags, {"ev773-a": False, "ev773-b": False, "es-1": True, "eu-1": True})

    def test_generic_citation_sits_only_on_its_own_passage_claim(self) -> None:
        result = retrieve_docs(
            "insured losses",
            2,
            {"event_id": "EMSR773"},
            embedder=lambda texts, _kind: [[1.0, 0.0]],
            search=self._search,
            hydrate=self._hydrate,
            search_generic=self._generic,
            scope=self.SCOPE,
        )
        for request in ({}, {"doc_claim_id": "C1"}):
            base = [Claim(claim_id="C1", text="Chiva rain", kind="fact")]
            claims, _evidence = _attach_documents(base, result.citations, request, "q")
            by_chunk = {c["chunk_id"]: c for c in result.citations}
            generic_claims = 0
            for claim in claims:
                for cit in claim.citations:
                    raw = by_chunk[cit.chunk_id]
                    if raw.get("generic"):
                        generic_claims += 1
                        # one generic passage, and the claim text is that passage
                        self.assertEqual(len(claim.citations), 1)
                        self.assertTrue(claim.claim_id.startswith("C-doc-g"))
                        excerpt = claim.text.split(': "', 1)[1].rstrip('"')
                        self.assertIn(excerpt.rstrip("."), " ".join(raw["quote"].split()))
                    else:
                        self.assertFalse(claim.claim_id.startswith("C-doc-g"))
            self.assertEqual(generic_claims, 2, request)

    def test_missing_scope_file_logs_a_warning(self) -> None:
        saved = (retrieve_mod._SCOPE_FILE, retrieve_mod._SCOPE_CACHE)
        try:
            retrieve_mod._SCOPE_FILE = Path(__file__).with_name("no-such-scope.json")
            retrieve_mod._SCOPE_CACHE = None
            with self.assertLogs("floodsense.retrieve_docs", level="WARNING"):
                self.assertEqual(retrieve_mod.load_scope(), {})
        finally:
            retrieve_mod._SCOPE_FILE, retrieve_mod._SCOPE_CACHE = saved

    def test_generic_failure_keeps_event_passages(self) -> None:
        def broken(_vector, _ids, _k):
            raise RuntimeError("generic search failed")

        result = retrieve_docs(
            "insured losses",
            2,
            {"event_id": "EMSR773"},
            embedder=lambda texts, _kind: [[1.0, 0.0]],
            search=self._search,
            hydrate=self._hydrate,
            search_generic=broken,
            scope=self.SCOPE,
        )
        self.assertEqual([c["chunk_id"] for c in result.citations], ["ev773-a", "ev773-b"])

    def test_search_binds_each_reused_placeholder(self) -> None:
        """Halfvec and the exact fallback reuse $1 and $2. Each use must be bound."""

        class Cursor:
            def __init__(self) -> None:
                self.sql = ""
                self.params: object = None

            def execute(self, sql, params) -> None:
                self.sql = sql
                self.params = params

            def fetchall(self):
                return [("chunk-a", 0.2)]

            def __enter__(self):
                return self

            def __exit__(self, *_args) -> bool:
                return False

        class Conn:
            def __init__(self) -> None:
                self.cur = Cursor()

            def cursor(self) -> Cursor:
                return self.cur

            def __enter__(self) -> "Conn":
                return self

            def __exit__(self, *_args) -> bool:
                return False

        rendered = "[0.1,0.2]"
        cases = (
            (retrieve_mod._HALFVEC_SQL, "EMSR773", "EMSR773"),
            (retrieve_mod._EXACT_SQL, None, None),
        )
        original = retrieve_mod._connect
        try:
            for statement, event_id, expect_event in cases:
                self.assertEqual(statement.count("$1"), 2)
                self.assertEqual(statement.count("$2"), 2)
                self.assertEqual(statement.count("$3"), 1)
                conn = Conn()
                retrieve_mod._connect = lambda _dsn, conn=conn: conn
                rows = retrieve_mod._search(
                    "postgresql://127.0.0.1/rag", statement, [0.1, 0.2], event_id, 4
                )
                self.assertEqual(rows, [("chunk-a", 0.2)])
                self.assertEqual(
                    _bound_values(conn.cur.sql, conn.cur.params),
                    [
                        rendered,
                        expect_event,
                        expect_event,
                        rendered,
                        4,
                    ],
                )
                self.assertNotIn("$1", conn.cur.sql)
        finally:
            retrieve_mod._connect = original

    def test_two_hydrated_hits_stay_on_one_query_and_both_match(self) -> None:
        first = "The gauge at Altenahr rose."
        second = "Paiporta recorded 140 mm in six hours."
        self.assertNotIn("140 mm", first)
        hits = (
            ("kept", first, 1),
            ("other", second, 2),
        )
        rows = [_hit_row(chunk_id, text, page) for chunk_id, text, page in hits]
        result = retrieve_docs(
            "rainfall",
            2,
            {"event_id": "EMSR773"},
            embedder=lambda texts, input_type: [[0.1] * 2048],
            search=lambda vector, event_id, k: [(row["chunk_id"], 0.1) for row in rows],
            hydrate=lambda ids: ("qid", rows),
        )
        self.assertEqual([item["query_id"] for item in result.citations], ["qid", "qid"])
        claims = [
            Claim(
                claim_id="C1",
                text="Altenahr rose.",
                citations=[
                    Citation(citation_id="C1-a1", claim_id="C1", layer="a", query_id="q-sql")
                ],
            )
        ]
        claims, doc_evidence = _attach_documents(
            claims, result.citations, {"doc_claim_id": "C1"}, "rainfall"
        )
        self.assertEqual(len(doc_evidence), 1)
        self.assertEqual(
            [row["chunk_id"] for row in doc_evidence[0].rows_sample], ["kept", "other"]
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
            "qid": doc_evidence[0],
        }
        self.assertTrue(score_claim(claims[0], evidence, None).citation_faithful)

    def test_other_nodes_do_not_name_the_tool(self) -> None:
        root = Path(__file__).resolve().parents[1] / "floodsense_agents" / "nodes"
        for name in ("watchers.py", "exposure.py", "skeptic.py"):
            text = (root / name).read_text(encoding="utf-8")
            self.assertNotIn("retrieve_docs", text)

    def test_a_run_without_doc_query_does_not_retrieve(self) -> None:
        def boom(*_args, **_kwargs):
            raise AssertionError("retrieve_docs was called")

        for flag in (True, False):
            bundle = Deps(
                zetaris=FakeZetaris(),
                llm=FakeNightshift(),
                memory=NoMemory(),
                retrieve_docs=boom,
            )
            graph = build_graph(
                bundle,
                MemorySaver(),
                ff_rag_docs=flag,
                ff_skeptic=False,
                ff_judge=False,
            )
            out, _ = start(graph, rid=f"rag-{flag}")
            self.assertNotIn("retrieve_docs error", str(out.get("trace")))

    def test_zetaris_string_columns_still_cite(self) -> None:
        # Zetaris REST hydrates page and paragraph as strings ('3', '1').
        row = _hit_row("kept", "Paiporta recorded 140 mm in six hours.", 3)
        row.update(page="3", paragraph="1")
        result = retrieve_docs(
            "rainfall",
            1,
            {"event_id": "EMSR773"},
            embedder=lambda texts, input_type: [[0.1] * 2048],
            search=lambda vector, event_id, k: [("kept", 0.1)],
            hydrate=lambda ids: ("qid", [row]),
        )
        self.assertEqual(len(result.citations), 1)
        self.assertEqual(result.citations[0]["locator"]["page"], 3)
        self.assertEqual(result.citations[0]["locator"]["paragraph"], 1)
        row.update(page="0")
        self.assertEqual(
            retrieve_docs(
                "rainfall",
                1,
                None,
                embedder=lambda texts, input_type: [[0.1] * 2048],
                search=lambda vector, event_id, k: [("kept", 0.1)],
                hydrate=lambda ids: ("qid", [row]),
            ).citations,
            [],
        )

    def test_the_run_request_keeps_doc_query(self) -> None:
        # The runtime hands req.model_dump() to the graph; a dropped field never retrieves.
        req = RunRequest(question="Why Paiporta?", doc_query="Barranc del Poyo discharge")
        self.assertEqual(req.model_dump()["doc_query"], "Barranc del Poyo discharge")
        self.assertIsNone(RunRequest(question="q").model_dump()["doc_query"])


def _hit_row(chunk_id: str, text: str, page: int) -> dict:
    return {
        "chunk_id": chunk_id,
        "text": text,
        "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "title": "HESS",
        "source_url": "https://hess.copernicus.org/articles/29/6715/2025/hess-29-6715-2025.pdf",
        "publisher": "Copernicus Publications",
        "licence": "CC-BY-4.0",
        "attribution": "Rombeek, Hrachowitz, and Uijlenhoet (2025), CC BY 4.0",
        "page": page,
        "paragraph": 1,
        "lines": "1-1",
        "section": None,
    }


def _bound_values(sql: str, params: object) -> list:
    """Values in placeholder order. A short tuple against a reused $n fails here."""
    names = re.findall(r"%\((\w+)\)s", sql)
    bare = re.sub(r"%\(\w+\)s", "", sql)
    if names:
        if not isinstance(params, dict):
            raise AssertionError(params)
        return [params[name] for name in names]
    slots = bare.count("%s")
    if not isinstance(params, (tuple, list)) or slots != len(params):
        raise AssertionError(f"{slots} placeholders, {params!r}")
    return list(params)


if __name__ == "__main__":
    unittest.main()
