"""Germany first: the Ahr 2021 replay and the Rhine right now (gauge_levels)."""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents.events import route_event  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents import live  # noqa: E402
from floodsense_agents.live import OFFICIAL_NOTE  # noqa: E402
from floodsense_agents.models import RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


def gauged(threshold: bool = False) -> FakeZetaris:
    """Live PEGELONLINE rows: seven hourly readings per station, KÖLN rising past 400 cm."""
    z = FakeZetaris()
    if threshold:
        z._conn.execute("ALTER TABLE floodsense.gauge_levels ADD COLUMN threshold_cm REAL")
    base = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    for station, level, step in (
        ("KÖLN", 420.0, 3.0),
        ("BONN", 455.0, 0.0),
        ("KOBLENZ", 380.0, -4.0),
    ):
        for h in range(6, -1, -1):
            ts = (base - timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ")
            row = [station, "RHEIN", ts, level - step * h, "pegelonline"]
            if threshold:
                row.append(400.0 if station == "KÖLN" else None)
            z._conn.execute(
                f"INSERT INTO floodsense.gauge_levels VALUES ({','.join('?' * len(row))})", row
            )
    return z


def run(question: str, z: FakeZetaris | None = None, **kw) -> dict:
    deps = Deps(zetaris=z or FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
    rt = Runtime(graph=build_graph(deps), deps=deps)
    with mock.patch.object(settings, "live_data", True):
        return rt.start(RunRequest(question=question, **kw))


def gauge_qids(out: dict) -> set[str]:
    return {q for q, e in out["evidence"].items() if "gauge_levels" in str(e.get("view"))}


class Routing(unittest.TestCase):
    def test_german_words_pick_the_ahr_event(self) -> None:
        for q in (
            "How high is the Rhine at Köln right now?",
            "Wie hoch ist der Rhein in Koblenz?",
            "Any flood risk in Bonn tonight?",
            "What is happening in NRW?",
            "Hochwasser in Rheinland-Pfalz?",
            "Why did the Ahr flood?",
            "Is Germany at risk?",
        ):
            self.assertEqual(route_event(q, None)[0], "EMSR517", q)

    def test_other_questions_keep_their_event(self) -> None:
        self.assertEqual(route_event("Why were our sites flooded?", None)[0], "EMSR773")
        self.assertEqual(route_event("Rain in Chiva?", None)[0], "EMSR773")
        # Naming Valencia too leaves it to the scope gate.
        self.assertEqual(route_event("Valencia or the Rhine?", None)[0], "EMSR773")
        # A non-default event is the caller's choice.
        self.assertEqual(route_event("Köln?", "ahr_2021")[0], "EMSR517")

    def test_explicit_valencia_is_never_routed(self) -> None:
        self.assertEqual(route_event("How high is the Rhine at Köln?", "EMSR773")[0], "EMSR773")
        self.assertEqual(route_event("What now?", "EMSR773", {"station": "BONN"})[0], "EMSR773")

    def test_ahr_acronym_and_point_ids_route(self) -> None:
        for q in ("What is the AHR doing now?", "Status of AHR01?", "ahr level?"):
            self.assertEqual(route_event(q, None)[0], "EMSR517", q)

    def test_every_valencia_town_keeps_valencia(self) -> None:
        for town in ("Catarroja", "Sedaví", "Alfafar", "Benetússer", "Algemesí", "Utiel"):
            self.assertEqual(route_event(f"{town} or the Rhine?", None)[0], "EMSR773", town)

    def test_a_run_without_event_id_is_routed(self) -> None:
        out = run("How high is the Rhine at Köln right now?")
        self.assertEqual(out["event_id"], "EMSR517")
        self.assertEqual(out["mode"]["mode"], "live")
        gate = next(t for t in out["trace"] if t["node"] == "scope")
        self.assertIn("event EMSR517: question names", gate["summary"])


class AhrReplay(unittest.TestCase):
    def test_full_run_gives_a_cited_chain_with_the_query_numbers(self) -> None:
        out = run("Why did the Ahr flood on 14 July 2021?", event_id="EMSR517")
        self.assertEqual(out["status"], "awaiting_approval")
        self.assertEqual(out["mode"]["mode"], "event")
        links = {h["link"]: h for h in out["hypotheses"]}
        self.assertEqual(links["rain->catchment"]["status"], "supported")
        self.assertEqual(links["catchment->river"]["status"], "supported")
        text = " ".join(c["text"] for c in out["claims"])
        # 142 mm, or 154 mm once PR #62 adds the 13:00 rain hour to the fake.
        self.assertRegex(text, r"Bad Neuenahr-Ahrweiler \(AHR02\) recorded (?:142|154) mm")
        self.assertIn("Altenahr (AHR01) reached 1000 m3/s", text)
        self.assertIn("no discharge value", text)
        self.assertIn("Rain began", text)
        self.assertIn("Ahr catchment", out["summary"])
        # The Valencia portfolio is not EMSR517's footprint.
        self.assertNotIn("EMSR517) covers", text)
        for c in out["claims"]:
            qids = [x["query_id"] for x in c["citations"] if x["layer"] == "a"]
            self.assertTrue(qids and all(q in out["evidence"] for q in qids), c)
        self.assertEqual(out["judge_summary"]["flagged_claim_ids"], [])


@mock.patch.dict("os.environ", {"FF_QUICK_LANE": "false"})  # full-lane test
class RhineNow(unittest.TestCase):
    def test_live_levels_trend_and_threshold(self) -> None:
        out = run("How high is the Rhine at Köln right now?", z=gauged(threshold=True))
        self.assertEqual(out["status"], "awaiting_approval")
        self.assertTrue(out["summary"])
        self.assertIn(OFFICIAL_NOTE, out["summary"])
        qids = gauge_qids(out)
        gauge_claims = [
            c
            for c in out["claims"]
            if any(x.get("query_id") in qids for x in c["citations"] if x["layer"] == "a")
        ]
        by_station = {c["text"].split(" ")[0]: c["text"] for c in gauge_claims}
        koeln = by_station["KÖLN"]
        self.assertIn("420 cm", koeln)
        self.assertRegex(koeln, r"\((?:\d+ h ago|this hour)\)")
        self.assertRegex(koeln, r"rising, from 402 cm at \S+ to 420 cm")
        self.assertIn("at or above the station threshold 400 cm (threshold_cm)", koeln)
        self.assertIn("steady", by_station["BONN"])
        self.assertIn("no threshold", by_station["BONN"])
        self.assertIn("falling", by_station["KOBLENZ"])
        self.assertIn("Not an official warning", koeln)
        # hazard_now has no German point, and the run says so.
        self.assertTrue(any("0 live rows" in c["text"] for c in out["claims"]))
        gauge_h = next(h for h in out["hypotheses"] if "Rhine gauges" in h["statement"])
        self.assertEqual(gauge_h["status"], "supported")
        self.assertTrue(gauge_h["evidence"])
        self.assertEqual(out["judge_summary"]["flagged_claim_ids"], [])

    def test_pr58_columns_mhw_band_trend_and_stale(self) -> None:
        z = gauged()
        for col in ("trend_cm_h REAL", "mhw_cm REAL", "band TEXT", "is_stale INTEGER"):
            z._conn.execute(f"ALTER TABLE floodsense.gauge_levels ADD COLUMN {col}")
        z._conn.execute(
            "UPDATE floodsense.gauge_levels SET trend_cm_h = 2.5, mhw_cm = 410, band = 'above', "
            "is_stale = 0 WHERE station = 'KÖLN'"
        )
        z._conn.execute(
            "UPDATE floodsense.gauge_levels SET trend_cm_h = -1, mhw_cm = 500, band = 'near', "
            "is_stale = 1 WHERE station = 'BONN'"
        )
        out = run("How high is the Rhine at Köln right now?", z=z)
        texts = {c["text"].split(" ")[0]: c["text"] for c in out["claims"]}
        self.assertIn("rising 2.5 cm/h (trend_cm_h)", texts["KÖLN"])
        self.assertIn("at or above the station threshold 410 cm (mhw_cm)", texts["KÖLN"])
        self.assertIn("band 'above'", texts["KÖLN"])
        self.assertIn("stale reading from", texts["BONN"])
        self.assertIn("below the station threshold", texts["BONN"])
        self.assertIn("BONN 455 cm (stale)", out["summary"])
        self.assertIn("STALE", out["summary"])
        self.assertEqual(out["judge_summary"]["flagged_claim_ids"], [])

    def test_no_live_reading_is_said_plainly(self) -> None:
        out = run("Wie hoch ist der Rhein in Bonn jetzt?")
        self.assertEqual(out["event_id"], "EMSR517")
        self.assertEqual(out["status"], "awaiting_approval")
        self.assertIn("No current Rhine gauge level", out["summary"])
        qids = gauge_qids(out)
        self.assertTrue(
            any(
                c["text"].startswith("Status:")
                and not c["numbers"]
                and "no live PEGELONLINE reading" in c["text"]
                and any(x.get("query_id") in qids for x in c["citations"])
                for c in out["claims"]
            )
        )
        self.assertEqual(out["judge_summary"]["flagged_claim_ids"], [])


class Context(unittest.TestCase):
    def test_validation_is_strict(self) -> None:
        from pydantic import ValidationError

        ok = RunRequest(question="q", context={"page": "now", "role": "citizen", "station": "KÖLN"})
        self.assertEqual(ok.context.station, "KÖLN")
        op = RunRequest(
            question="q", context={"page": "situation", "role": "operator", "place": "Köln"}
        )
        self.assertEqual(op.context.role, "operator")
        self.assertEqual(
            live.focus({"request": {"context": {"role": "operator"}}})["role"], "operator"
        )
        self.assertIsNone(live.focus({"request": {"context": {"role": "admin"}}})["role"])
        for bad in (
            {"evil": "x"},
            {"role": "admin"},
            {"point_id": "VAL01'; DROP"},
            {"station": "KÖLN' OR 1=1"},
            {"place": "x" * 65},
            {"replay_date": "yesterday"},
        ):
            with self.assertRaises(ValidationError, msg=bad):
                RunRequest(question="q", context=bad)

    def test_selection_wins_over_the_default_event(self) -> None:
        self.assertEqual(route_event("What now?", None, {"station": "BONN"})[0], "EMSR517")
        self.assertEqual(route_event("What now?", None, {"point_id": "AHR01"})[0], "EMSR517")
        self.assertEqual(route_event("What now?", None, {"place": "Köln"})[0], "EMSR517")
        self.assertEqual(route_event("What now?", None, {"event_id": "EMSR517"})[0], "EMSR517")
        # A question naming one event's place beats the selection.
        self.assertEqual(route_event("Rhine?", None, {"event_id": "EMSR773"})[0], "EMSR517")
        # An unknown point is not trusted.
        self.assertEqual(route_event("What now?", None, {"point_id": "XYZ99"})[0], "EMSR773")

    def test_station_focus_role_and_trace(self) -> None:
        out = run(
            "What is the level right now?",
            z=gauged(),
            context={"page": "now", "role": "citizen", "station": "Bonn"},
        )
        self.assertEqual(out["event_id"], "EMSR517")
        gate = next(t for t in out["trace"] if t["node"] == "scope")
        self.assertIn("station=Bonn", gate["summary"])
        self.assertIn("role=citizen", gate["summary"])
        watch_sql = [e["sql"] for e in out["evidence"].values() if "gauge_levels" in e["sql"]]
        self.assertTrue(any("station = 'BONN'" in sql for sql in watch_sql))
        gauge_h = next(h for h in out["hypotheses"] if "Rhine gauges" in h["statement"])
        self.assertTrue(gauge_h["statement"].startswith("Rhine gauges now (PEGELONLINE): BONN"))
        self.assertTrue(out["summary"].startswith("In plain words:"))
        self.assertIn("What to do", out["summary"])

    def test_point_focus_and_insurer_exposure_first(self) -> None:
        out = run(
            "Why were our sites flooded?",
            event_id="EMSR773",
            context={"role": "insurer", "point_id": "VAL01"},
        )
        self.assertTrue(out["summary"].startswith("Exposure:"), out["summary"])
        rain_sql = next(e["sql"] for e in out["evidence"].values() if "rain_mm >=" in e["sql"])
        self.assertIn("point_id = 'VAL01'", rain_sql)


if __name__ == "__main__":
    unittest.main()
