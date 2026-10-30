"""The Ahr 2021 replay on the real Open-Meteo extract, with FF_LIVE_DATA on.

A live run scored Judge 0.40: every hazard query read floodsense.* (Valencia
only), the Skeptic counted Valencia's footprint sites as the Ahr's, the hourly
rain line (30 mm/h) never fires on ERA5's smoothed 5.6-18.5 mm/h, and the
model copied the bbox literals into a claim's numbers. The fake here holds the
Ahr rows only in floodsense_seed, parsed from migrations 051/052 (the real
GloFAS / ERA5 values), and none in floodsense.
"""

from __future__ import annotations

import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents.events import EVENTS, hazard_schema  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import Evidence, RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes.investigator import cited_numbers  # noqa: E402
from floodsense_agents.nodes.memory import _same_event  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402

MIGRATIONS = Path(__file__).resolve().parents[2] / "zetaris" / "migrations"
_HOURLY = re.compile(
    r"\('(AHR0\d)', '(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})', ([\d.]+)D, ([\d.]+)D\)"
)
_DAILY = re.compile(r"\('(AHR0\d)', '(\d{4}-\d{2}-\d{2})', ([\d.]+)D, '([^']+)'\)")


def real_ahr() -> FakeZetaris:
    """FakeZetaris whose Ahr rows are the real 051/052 extract, in floodsense_seed only."""
    z = FakeZetaris()
    for schema in ("floodsense_seed", "floodsense"):
        for view in ("hazard_timeline", "discharge_daily", "hazard_now"):
            z._conn.execute(f"DELETE FROM {schema}.{view} WHERE point_id LIKE 'AHR%'")
    hourly = _HOURLY.findall((MIGRATIONS / "052_seed_hazard_timeline_ahr.sql").read_text("utf-8"))
    daily = _DAILY.findall((MIGRATIONS / "051_seed_discharge_daily_ahr.sql").read_text("utf-8"))
    assert len(hourly) == 384 and len(daily) == 44, (len(hourly), len(daily))
    z._conn.executemany(
        "INSERT INTO floodsense_seed.hazard_timeline VALUES (?,?,?,?,NULL)",
        [(p, f"{d}T{t}Z", float(r), float(q)) for p, d, t, r, q in hourly],
    )
    z._conn.executemany(
        "INSERT INTO floodsense_seed.discharge_daily VALUES (?,?,?,?)",
        [(p, d, float(q), s) for p, d, q, s in daily],
    )
    z._conn.commit()
    return z


def run_replay(z: FakeZetaris) -> dict:
    deps = Deps(zetaris=z, llm=FakeNightshift(), memory=NoMemory())
    rt = Runtime(graph=build_graph(deps), deps=deps)
    with mock.patch.object(settings, "live_data", True):
        return rt.start(
            RunRequest(
                question="Why was Altenahr at risk on 14 Jul 2021?",
                event_id="EMSR517",
                context={
                    "page": "replay",
                    "role": "insurer",
                    "event_id": "EMSR517",
                    "replay_date": "2021-07-14",
                },
            )
        )


class AhrReplayOnRealData(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.out = run_replay(real_ahr())

    def _hazard(self) -> list[dict]:
        return [
            e
            for e in self.out["evidence"].values()
            if re.search(r"\b(hazard_timeline|discharge_daily)\b", e.get("sql") or "")
        ]

    def test_hazard_schema_is_seed_for_the_ahr_and_configured_for_valencia(self) -> None:
        self.assertEqual(
            hazard_schema(EVENTS["EMSR517"].as_dict(), "floodsense"), "floodsense_seed"
        )
        self.assertEqual(hazard_schema({"event_id": "EMSR517"}, "floodsense"), "floodsense_seed")
        self.assertEqual(hazard_schema(EVENTS["EMSR773"].as_dict(), "floodsense"), "floodsense")

    def test_every_hazard_query_reads_floodsense_seed(self) -> None:
        hazard = self._hazard()
        self.assertTrue(hazard)
        for e in hazard:
            self.assertIn("floodsense_seed.", e["sql"])
            self.assertNotRegex(e["sql"], r"(?<!_)\bfloodsense\.(hazard_timeline|discharge_daily)")

    def test_watchers_flag_the_real_discharge_and_rain_total(self) -> None:
        kinds = {(a["kind"], a.get("unit")) for a in self.out["anomalies"]}
        self.assertIn(("discharge", "m3/s"), kinds)
        self.assertIn(("rain", "mm"), kinds, "the window total catches ERA5's smoothed storm")
        peak = max(a["value"] for a in self.out["anomalies"] if a["kind"] == "discharge")
        self.assertLess(peak, 300, "GloFAS reanalysis, not the ~1000 m3/s literature figure")

    def test_rain_and_river_hypotheses_survive_the_skeptic(self) -> None:
        status = {h["link"]: h["status"] for h in self.out["hypotheses"]}
        self.assertEqual(status.get("rain->catchment"), "supported", self.out["hypotheses"])
        self.assertEqual(status.get("catchment->river"), "supported", self.out["hypotheses"])

    def test_footprint_check_is_inside_the_ahr_bbox(self) -> None:
        site = [h for h in self.out["hypotheses"] if h["link"] == "river->site"]
        for h in site:
            for q in h.get("evidence") or []:
                sql = self.out["evidence"][q]["sql"]
                if "exposure_join" in sql:
                    self.assertIn("lat BETWEEN 50.2 AND 50.7", sql)

    def test_number_claims_match_their_rows(self) -> None:
        scores = {s["claim_id"]: s for s in self.out["judge"]}
        numbered = [c for c in self.out["claims"] if c["numbers"] and c["claim_id"] in scores]
        self.assertTrue(numbered)
        for c in numbered:
            self.assertTrue(scores[c["claim_id"]]["numbers_match"], (c, scores[c["claim_id"]]))


class EmptyCitationClaims(unittest.TestCase):
    def test_a_model_claim_citing_only_an_empty_query_is_dropped(self) -> None:
        import json

        def investigator(system, user):
            if "LINK: H2 catchment->river" not in user:
                return "{}"
            blocks = re.findall(r"query_id=(\S+) view=(\S+) .*?rows=(\d+)", user)
            empty = next(q for q, v, n in blocks if int(n) == 0)
            full = next(q for q, v, n in blocks if v.endswith("discharge_daily") and int(n) > 0)
            return json.dumps(
                {
                    "statement": "River rose",
                    "claims": [
                        {
                            "text": "Daily discharge at Altenahr reached 249.61 m3/s.",
                            "kind": "number",
                            "numbers": [249.61],
                            "query_ids": [full],
                        },
                        {
                            "text": "No warning level was recorded.",
                            "kind": "fact",
                            "numbers": [],
                            "query_ids": [empty],
                        },
                    ],
                }
            )

        deps = Deps(
            zetaris=real_ahr(),
            llm=FakeNightshift({"investigator": investigator}),
            memory=NoMemory(),
        )
        rt = Runtime(graph=build_graph(deps), deps=deps)
        with mock.patch.object(settings, "live_data", True):
            out = rt.start(
                RunRequest(question="Why was Altenahr at risk on 14 Jul 2021?", event_id="EMSR517")
            )
        texts = [c["text"] for c in out["claims"]]
        self.assertIn("Daily discharge at Altenahr reached 249.61 m3/s.", texts)
        self.assertNotIn("No warning level was recorded.", texts)
        inv = [e for e in out["trace"] if e["node"] == "investigator"]
        self.assertTrue(
            any("dropped model claim H2.2 (empty evidence)" in e["summary"] for e in inv)
        )
        # The warning check cannot apply to reanalysis rows: recorded as skipped.
        h2 = next(h for h in out["hypotheses"] if h["link"] == "catchment->river")
        self.assertIn("skipped: a warning was issued for the river point", h2["rationale"])


class DocumentClaims(unittest.TestCase):
    TEXT = "Heavy rain fell over the Eifel on 14 July 2021. Warnings were issued by DWD."

    def _raw(self, quote: str | None = None) -> dict:
        import hashlib

        quote = quote or self.TEXT
        return {
            "query_id": "dq",
            "chunk_id": "ch1",
            "title": "NHESS 23-525",
            "text": self.TEXT,
            "text_sha256": hashlib.sha256(self.TEXT.encode()).hexdigest(),
            "quote": quote,
            "content_sha256": hashlib.sha256(quote.encode()).hexdigest(),
            "locator": {"page": 8, "paragraph": 1, "lines": "1-4"},
        }

    def test_c_doc_asserts_the_top_verified_passage_not_the_query(self) -> None:
        from floodsense_agents.models import Evidence as Ev
        from floodsense_agents.nodes.investigator import _attach_documents
        from floodsense_agents.nodes.judge import score_claim

        claims, evid = _attach_documents(
            [], [self._raw()], {}, "July 2021 Ahr flood rainfall warning"
        )
        c = claims[0]
        self.assertNotIn("rainfall warning", c.text)
        self.assertIn("Heavy rain fell over the Eifel", c.text)
        self.assertIn("page 8", c.text)
        ev = {e.query_id: e for e in evid}
        self.assertEqual(score_claim(c, ev, None).grounding, "supported")
        # Text that no verified passage contains is not supported.
        bad = c.model_copy(update={"text": 'NHESS: "Rain was light."'})
        self.assertEqual(score_claim(bad, ev, None).grounding, "unsupported")
        self.assertIsInstance(next(iter(ev.values())), Ev)

    def test_no_verifiable_passage_no_c_doc(self) -> None:
        from floodsense_agents.nodes.investigator import _attach_documents

        raw = self._raw()
        raw["content_sha256"] = "0" * 64
        claims, _ = _attach_documents([], [raw], {}, "query")
        self.assertEqual(claims, [])

    def test_missing_layer_a_ids_are_unsupported_not_document_only(self) -> None:
        from floodsense_agents.models import Citation
        from floodsense_agents.nodes.investigator import _attach_documents
        from floodsense_agents.nodes.judge import score_claim

        claims, evid = _attach_documents([], [self._raw()], {}, "q")
        c = claims[0]
        c.citations.append(
            Citation(citation_id="C-doc-a1", claim_id="C-doc", layer="a", query_id="gone")
        )
        self.assertEqual(
            score_claim(c, {e.query_id: e for e in evid}, None).grounding, "unsupported"
        )


class NumbersAndMemory(unittest.TestCase):
    BBOX_SQL = (
        "SELECT COUNT(*) AS n FROM floodsense.exposure_join WHERE in_footprint = TRUE "
        "AND lat BETWEEN 50.2 AND 50.7 AND lon BETWEEN 6.6 AND 7.4"
    )

    def _ev(self, rows, sql="SELECT 1") -> Evidence:
        return Evidence(
            query_id="q",
            view="floodsense.x",
            sql=sql,
            rows_sample=rows,
            row_count=len(rows),
            executed_at_utc="2026-10-27T00:00:00Z",
        )

    def test_bbox_written_as_a_filter_is_dropped_and_recorded(self) -> None:
        e = self._ev([{"n": 0}], self.BBOX_SQL)
        text = "The exposure query (lat 50.2-50.7, lon 6.6-7.4) found 0 sites in the footprint."
        kept, dropped = cited_numbers([0.0, 50.2, 50.7, 6.6, 7.4], [e], text)
        self.assertEqual(kept, [0.0])
        self.assertEqual({d["value"] for d in dropped}, {50.2, 50.7, 6.6, 7.4})
        self.assertTrue(all(d["reason"] == "query filter" for d in dropped))
        # The same literal stated as a value is kept: the Judge decides.
        kept, dropped = cited_numbers([50.2], [e], "Rain reached 50.2 mm.")
        self.assertEqual((kept, dropped), ([50.2], []))

    def test_dates_drop_only_inside_a_date_expression(self) -> None:
        e = self._ev([{"discharge_m3s": "13.0", "date": "2021-07-13"}])
        kept, dropped = cited_numbers(
            [13.0, 2021.0], [e], "Rain began on 13 Jul 2021 at 00:00 UTC."
        )
        # 13 is a cell (string from the REST API), so it stays; 2021 is a date part.
        self.assertEqual(kept, [13.0])
        self.assertEqual(dropped, [{"value": 2021.0, "reason": "date"}])
        # Live run: the fallback list read "00:00 UTC" as [0, 0].
        kept, dropped = cited_numbers(
            [0.0, 0.0], [self._ev([{"x": 5.0}])], "Rain began at 00:00 UTC."
        )
        self.assertEqual(kept, [])
        self.assertEqual(len(dropped), 2)
        e2 = self._ev([{"discharge_m3s": 250.0}])
        kept, dropped = cited_numbers([13.0, 13.0], [e2], "Discharge was 13 m3/s on 13 Jul.")
        self.assertEqual(kept, [13.0, 13.0], "one of the two 13s is a value")

    def test_a_threshold_drops_only_when_named_as_the_line(self) -> None:
        e = self._ev([{"discharge_m3s": 250.0}])
        kept, dropped = cited_numbers(
            [250.0, 100.0], [e], "Discharge reached 250 m3/s, above the 100 m3/s line."
        )
        self.assertEqual(kept, [250.0])
        self.assertEqual(dropped, [{"value": 100.0, "reason": "named line"}])
        kept, dropped = cited_numbers([100.0], [e], "Discharge peaked at 100 m3/s.")
        self.assertEqual((kept, dropped), ([100.0], []))
        # Review round 2: no comparison word, or the wrong unit, keeps the number.
        for text in ("Discharge peaked at the 100 m3/s line.", "Rain reached the 30 m3/s line."):
            n = 100.0 if "100" in text else 30.0
            kept, dropped = cited_numbers([n], [e], text)
            self.assertEqual((kept, dropped), ([n], []), text)
        kept, dropped = cited_numbers([30.0], [e], "No hour went over the 30 mm/h line.")
        self.assertEqual(dropped, [{"value": 30.0, "reason": "named line"}])

    def test_dropped_only_numbers_are_unverified_in_the_judge(self) -> None:
        from floodsense_agents.models import Citation, Claim
        from floodsense_agents.nodes.judge import score_claim

        e = self._ev([{"discharge_m3s": 250.0}])
        for text in ("Discharge peaked at the 100 m3/s line.", "Rain reached the 30 m3/s line."):
            n = 100.0 if "100" in text else 30.0
            kept, dropped = cited_numbers([n], [e], text)
            c = Claim(
                claim_id="C1",
                text=text,
                kind="number",
                numbers=kept,
                numbers_dropped=dropped,
                citations=[Citation(citation_id="C1-a1", claim_id="C1", layer="a", query_id="q")],
            )
            self.assertFalse(score_claim(c, {"q": e}, None).numbers_match, text)
        c = Claim(
            claim_id="C2",
            text="Discharge stayed under the 100 m3/s line.",
            kind="number",
            numbers=[],
            numbers_dropped=[{"value": 100.0, "reason": "named line"}],
            citations=[Citation(citation_id="C2-a1", claim_id="C2", layer="a", query_id="q")],
        )
        self.assertFalse(score_claim(c, {"q": e}, None).numbers_match, "unverified, never a pass")

    def test_a_wrong_value_equal_to_a_threshold_is_flagged_by_the_judge(self) -> None:
        from floodsense_agents.models import Citation, Claim
        from floodsense_agents.nodes.judge import score_claim

        e = self._ev([{"point_id": "AHR01", "discharge_m3s": 250.0}])
        kept, _ = cited_numbers([100.0], [e], "Altenahr peaked at 100 m3/s.")
        c = Claim(
            claim_id="C1",
            text="Altenahr peaked at 100 m3/s.",
            kind="number",
            numbers=kept,
            citations=[Citation(citation_id="C1-a1", claim_id="C1", layer="a", query_id="q")],
        )
        s = score_claim(c, {"q": e}, None)
        self.assertFalse(s.numbers_match)
        self.assertEqual(s.grounding, "unsupported")

    def test_memory_from_another_event_is_not_recalled(self) -> None:
        mems = [
            {"memory_id": "v", "tags": ["event:EMSR773"]},
            {"memory_id": "a", "tags": ["event:EMSR517"]},
            {"memory_id": "u", "tags": []},
        ]
        self.assertEqual([m["memory_id"] for m in _same_event(mems, "EMSR517")], ["a", "u"])


if __name__ == "__main__":
    unittest.main()
