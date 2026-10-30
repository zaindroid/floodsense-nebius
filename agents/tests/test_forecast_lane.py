"""Forecast lane: router cues, the nodes on a fake Zetaris and fake engines, the outlook
guard (no number or place the claims lack), escalation, and the evals' path."""

from __future__ import annotations

import hashlib
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from floodsense_agents import router  # noqa: E402
from floodsense_agents.models import ApprovalDecision, RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes import forecast  # noqa: E402
from floodsense_agents.retrieve_docs import RetrieveResult  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.watch import FORECAST_POINTS, STATIONS  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris, now_utc  # noqa: E402

KOELN = "Do the next 48 hours look safe at Köln?"
BUDAPEST = "Will the Danube at Budapest rise this week?"


def _zetaris(koeln_level: float | None = 412.0) -> FakeZetaris:
    """The fake plus a live Köln reading, a Budapest eu_watch row and Ahr seed rain."""
    z = FakeZetaris()
    with z._lock:
        if koeln_level is not None:
            z._conn.execute(
                "INSERT INTO floodsense.gauge_levels VALUES (?,?,?,?,?)",
                ("KÖLN", "RHEIN", now_utc(), koeln_level, "pegelonline"),
            )
        z._conn.execute(
            "UPDATE floodsense.eu_watch SET discharge_m3s=2210, forecast_max_m3s=2600, "
            "past30_median_m3s=2000, band='below' WHERE point_id='EU08'"
        )
        # Altenahr: 12 hours of 6.5 mm on 14 Jul 2021 (test rows, not the seed extract).
        z._conn.execute("DELETE FROM floodsense_seed.hazard_timeline WHERE point_id='AHR01'")
        for h in range(12):
            z._conn.execute(
                "INSERT INTO floodsense_seed.hazard_timeline VALUES (?,?,?,?,?)",
                ("AHR01", f"2021-07-14T{h:02d}:00:00Z", 6.5, 120.0 + h, None),
            )
        z._conn.commit()
    return z


class FakeMemory:
    """Fake engines: one seeded memory about Köln, one about Valencia."""

    def __init__(self) -> None:
        self.asked: list[dict] = []

    def recall(self, request):
        self.asked.append(request)
        return [
            {
                "memory_id": "m1",
                "run_id": "demo-seed-1",
                "claim_id": "C1",
                "content": "KÖLN (RHEIN) stayed below mean high water in the last approved run.",
                "provenance": {
                    "label": "run demo-seed-1 approved by demo-seed",
                    "learned_at": "2026-10-26",
                },
                "tags": ["entity:demo-seed", "event:EMSR517"],
            },
            {
                "memory_id": "m2",
                "run_id": "r2",
                "content": "Paiporta flooded in 2024.",
                "provenance": {"label": "run r2 approved by ana"},
                "tags": ["event:EMSR773"],
            },
        ]

    def store(self, *a, **k):
        return None


def _passage() -> dict:
    text = "On 14 July 2021 heavy rain over the Eifel led to an extreme flood on the Ahr."
    sha = hashlib.sha256(text.encode()).hexdigest()
    return {
        "layer": "c",
        "query_id": "doc-q1",
        "title": "July 2021 flood, Part 1",
        "source_url": "https://doi.org/10.5194/nhess-23-525-2023",
        "publisher": "NHESS",
        "licence": "CC BY 4.0",
        "attribution": "Mohr et al. (2023)",
        "locator": {"page": 3, "paragraph": 2, "lines": "1-1"},
        "quote": text,
        "content_sha256": sha,
        "storage": "full_text",
        "chunk_id": "nhess-23-525/p3/2",
        "text": text,
        "text_sha256": sha,
    }


@mock.patch.object(settings, "live_data", True)
class RouterForecastCues(unittest.TestCase):
    def test_forecast_cues_with_a_watched_place(self) -> None:
        for q, place in [
            (KOELN, "KÖLN"),
            (BUDAPEST, "Budapest"),
            ("What is the rain forecast for Dresden?", "DRESDEN"),
            ("Will Paiporta flood tomorrow?", "Paiporta"),
            ("Wie wird der Rhein in Bonn morgen?", "BONN"),
            ("Steigt die Elbe in Dresden in den nächsten 48 Stunden?", "DRESDEN"),
            ("¿Lloverá en Valencia mañana?", "Paiporta"),
            ("Is the Vltava at Prague going to rise over the next 3 days?", "Prague"),
        ]:
            lane, why = router.rules(q)
            self.assertEqual(lane, "forecast", q)
            self.assertIn(place, why, q)

    def test_present_questions_stay_quick(self) -> None:
        for q in ("How high is the Rhine at Köln?", "Is the Danube at Budapest rising?"):
            self.assertEqual(router.rules(q)[0], "quick", q)

    def test_why_and_the_past_go_full(self) -> None:
        for q in (
            "Why will the Rhine at Köln rise tomorrow?",
            "Explain the forecast for Valencia next 48 hours",
            "What happened in Valencia on 29 October 2024?",
        ):
            self.assertEqual(router.rules(q)[0], "full", q)

    def test_greeting_is_not_tomorrow_and_no_place_is_not_forecast(self) -> None:
        self.assertNotEqual(router.rules("Guten Morgen, Köln")[0], "forecast")
        self.assertNotEqual(router.rules("Will it rain tomorrow?")[0], "forecast")

    def test_explicit_requests_and_flags_go_full(self) -> None:
        for req in (
            RunRequest(question=KOELN, event_id="EMSR517"),
            RunRequest(question=KOELN, replay_ts="2021-07-14T18:00:00Z"),
            RunRequest(question=KOELN, mode="event"),
        ):
            self.assertEqual(router.route(req)["lane"], "full")
        with mock.patch.dict("os.environ", {"FF_FORECAST_LANE": "false"}):
            self.assertNotEqual(router.route(RunRequest(question=KOELN))["lane"], "forecast")

    def test_live_data_off_means_full(self) -> None:
        with mock.patch.object(settings, "live_data", False):
            self.assertEqual(router.route(RunRequest(question=KOELN))["lane"], "full")

    def test_every_eval_item_stays_full(self) -> None:
        try:
            import yaml
        except ImportError:
            self.skipTest("pyyaml not installed")
        n = 0
        for f in sorted((ROOT / "evals").glob("*.yaml")):
            spec = yaml.safe_load(f.read_text(encoding="utf-8"))
            for item in spec.get("items") or []:
                req = RunRequest(
                    question=item["question"],
                    event_id=spec.get("event_id"),
                    replay_ts=item.get("replay_ts"),
                )
                self.assertEqual(router.route(req)["lane"], "full", item["id"])
                n += 1
        self.assertGreater(n, 10)


class PlacesTest(unittest.TestCase):
    def test_all_45_places_and_the_migration_agree(self) -> None:
        self.assertEqual(len(FORECAST_POINTS), 45)
        kinds = [p[1] for p in FORECAST_POINTS]
        self.assertEqual(
            (kinds.count("gauge"), kinds.count("eu"), kinds.count("valencia")), (26, 11, 8)
        )
        self.assertEqual([p[2] for p in FORECAST_POINTS[:26]], [s for s, _ in STATIONS])
        mig = (ROOT / "zetaris" / "migrations" / "071_create_view_weather_forecast.sql").read_text(
            encoding="utf-8"
        )
        rows = re.findall(
            r"\((\d+), '(\w+)', '(\w+)', '[^']*', '[^']*', (-?[\d.]+), (-?[\d.]+)\)", mig
        )
        self.assertEqual(
            [(int(i), pid, kind, float(lat), float(lon)) for i, pid, kind, lat, lon in rows],
            [(i, p[0], p[1], p[5], p[6]) for i, p in enumerate(FORECAST_POINTS)],
        )
        rest = (
            ROOT / "zetaris" / "migrations" / "070_create_rest_table_weather_forecast_live.sql"
        ).read_text(encoding="utf-8")
        lats = re.search(r"latitude=([-\d.,]+)", rest).group(1).split(",")
        self.assertEqual([float(x) for x in lats], [p[5] for p in FORECAST_POINTS])
        self.assertIn("models=icon_seamless", rest)

    @mock.patch.object(settings, "live_data", True)
    def test_every_place_reads_its_forecast_row(self) -> None:
        z = FakeZetaris()
        deps = Deps(zetaris=z, llm=None, memory=NoMemory())
        node = forecast.make_forecast_data(deps)
        for p in FORECAST_POINTS:
            with mock.patch.object(forecast, "_asked", return_value=[p]):
                out = node({"run_id": "t", "trace": []})
            place = out["live_findings"]["forecast_places"][0]
            self.assertIn("weather", place, p[0])
            ev = out["evidence"][place["weather"]]
            self.assertEqual(ev["rows_sample"][0]["point_id"], p[0])

    def test_memories_name_the_place_and_state_something(self) -> None:
        koeln = next(p for p in FORECAST_POINTS if p[0] == "PEG07")
        mems = [
            {"memory_id": "a", "content": "No supporting evidence was provided about KÖLN."},
            {"memory_id": "b", "content": "Paiporta flooded."},
            {
                "memory_id": "c",
                "content": "KÖLN read 412 cm.",
                "provenance": {"label": "run r by ana"},
            },
        ]
        rows = forecast._memory_rows(mems, koeln)
        self.assertEqual([r["memory_id"] for r in rows], ["c"])
        self.assertEqual(rows[0]["reviewer"], "ana")
        self.assertFalse(rows[0]["seeded"])

    def test_place_resolution(self) -> None:
        got = lambda q, c=None: [p[0] for p in forecast.forecast_places(q, c)]  # noqa: E731
        self.assertEqual(got(KOELN), ["PEG07"])
        self.assertEqual(got(BUDAPEST), ["EU08"])
        self.assertEqual(got("Will Chiva flood tomorrow?"), ["VAL07"])
        self.assertEqual(got("Valencia next 48 hours"), ["VAL01", "VAL07"])
        self.assertEqual(len(got("Will the Danube rise this week?")), forecast.MAX_PLACES)
        self.assertEqual(got("next 48 hours?", {"station": "KÖLN"}), ["PEG07"])


@mock.patch.object(settings, "live_data", True)
class ForecastLaneTest(unittest.TestCase):
    def _run(self, question=KOELN, z=None, llm=None, memory=None, docs=None):
        deps = Deps(
            zetaris=z or _zetaris(),
            llm=llm or FakeNightshift(),
            memory=memory or NoMemory(),
            retrieve_docs=docs,
        )
        return Runtime(deps=deps).start(RunRequest(question=question))

    @mock.patch.object(settings, "ff_rag_docs", True)
    def test_koeln_claims_history_memory_passage_and_template_lead(self) -> None:
        mem = FakeMemory()
        docs = mock.Mock(return_value=RetrieveResult([_passage()], None))
        snap = self._run(memory=mem, docs=docs)
        self.assertEqual(
            (snap["lane"], snap["status"]), ("forecast", "answered"), snap["router_reason"]
        )
        self.assertEqual(
            [e["node"] for e in snap["trace"]],
            ["router", "scope", "forecast_data", "history", "forecast_answer", "judge"],
        )
        self.assertTrue(snap["judge_summary"]["passes"], snap["judge"])
        self.assertEqual(snap["approval"]["status"], "not_reached")
        texts = [c["text"] for c in snap["claims"]]
        self.assertTrue(
            texts[0].startswith("KÖLN: forecast precipitation for the next 48 hours is 4.8 mm")
        )
        self.assertTrue(any("level 412 cm" in t for t in texts))
        past = next(t for t in texts if t.startswith("Past pattern"))
        self.assertIn("reached 78 mm at Altenahr", past)
        self.assertIn("at KÖLN is 4.8 mm (a comparison, not a prediction for KÖLN)", past)
        memory = next(t for t in texts if t.startswith("Approved memory"))
        self.assertIn("demo seed", memory)
        self.assertNotIn("Paiporta", memory)  # only the memory that names the place
        self.assertTrue(any(t.startswith("July 2021 flood, Part 1") for t in texts))
        docs.assert_called_once()
        self.assertIn("KÖLN flood", docs.call_args.args[0])
        self.assertEqual(docs.call_args.args[2], {"event_id": "EMSR517"})
        # every claim cites only its own evidence
        views = {
            c["claim_id"]: {
                snap["evidence"][x["query_id"]]["view"] for x in c["citations"] if x.get("query_id")
            }
            for c in snap["claims"]
        }
        self.assertEqual(views["F1"], {"floodsense.weather_forecast"})
        self.assertEqual(views["F2"], {"floodsense.gauge_levels"})
        self.assertEqual(
            views["F3"], {"floodsense_seed.hazard_timeline", "floodsense.weather_forecast"}
        )
        self.assertIn({"hmem.recall"}, views.values())
        self.assertIn({"PGVECTOR_RAG.chunks"}, views.values())
        fc = snap["forecast"]
        self.assertEqual(fc["status"], "Normal")
        self.assertTrue(snap["summary"].startswith(fc["lead"]))
        self.assertIn("Status: Normal for KÖLN", fc["lead"])
        self.assertNotIn("utlook", snap["summary"])
        self.assertIn("not an official warning; follow DWD", fc["disclaimer"])
        self.assertTrue(snap["summary"].endswith(fc["disclaimer"]))
        # no model call anywhere in the lane
        self.assertNotIn("fast", {e.get("lane") for e in snap["trace"]})
        self.assertEqual(
            {e.get("model_id") for e in snap["trace"] if e["node"] == "forecast_answer"},
            {"deterministic"},
        )

    def test_budapest_reads_eu_watch_and_names_the_national_service(self) -> None:
        snap = self._run(BUDAPEST, llm=None)
        self.assertEqual(
            (snap["lane"], snap["status"]), ("forecast", "answered"), snap["router_reason"]
        )
        self.assertIn("forecast maximum 2600 m3/s", " ".join(c["text"] for c in snap["claims"]))
        self.assertIn("HungaroMet", snap["forecast"]["disclaimer"])

    def test_chiva_rain_is_elevated(self) -> None:
        snap = self._run("Will Chiva flood in the next 48 hours?", llm=None)
        self.assertEqual(snap["forecast"]["status"], "Elevated")
        self.assertIn("Past pattern: before the October 2024 Valencia DANA flood", snap["summary"])
        self.assertIn("AEMET", snap["forecast"]["disclaimer"])

    def test_no_forecast_rows_escalates(self) -> None:
        z = _zetaris(koeln_level=None)
        with z._lock:
            z._conn.execute("DELETE FROM floodsense.weather_forecast WHERE point_id='PEG07'")
            z._conn.commit()
        snap = self._run(z=z, llm=None)
        self.assertEqual(snap["lane"], "full")
        self.assertIn("escalated: no forecast rows", snap["router_reason"])
        self.assertIn("watchers", [e["node"] for e in snap["trace"]])

    def test_a_judge_flag_escalates(self) -> None:
        def wrong(p, row):
            return ("KÖLN: forecast precipitation 999 mm.", [999.0]), 999.0, None

        with mock.patch.object(forecast, "weather_claim", wrong):
            snap = self._run(llm=None)
        self.assertEqual(snap["lane"], "full")
        self.assertIn("escalated: judge flagged F1", snap["router_reason"])
        self.assertEqual(snap["forecast"], {})


class NoModelAndStatusTest(unittest.TestCase):
    @mock.patch.object(settings, "live_data", True)
    def test_the_lane_makes_no_model_call(self) -> None:
        llm = FakeNightshift()
        deps = Deps(zetaris=_zetaris(), llm=llm, memory=NoMemory())
        snap = Runtime(deps=deps).start(RunRequest(question=KOELN))
        self.assertEqual(snap["status"], "answered")
        self.assertEqual(llm.calls, [])

    def test_status_uses_fixed_cuts_only(self) -> None:
        self.assertEqual(forecast._rain_status(24.9, 19.9), "Normal")
        self.assertEqual(forecast._rain_status(25.0, None), "Watch")
        self.assertEqual(forecast._rain_status(10.0, 20.0), "Watch")
        self.assertEqual(forecast._rain_status(50.0, None), "Elevated")
        self.assertEqual(forecast._rain_status(1.0, 30.0), "Elevated")
        import inspect

        self.assertEqual(list(inspect.signature(forecast._rain_status).parameters), ["r48", "hour"])

    @mock.patch.object(settings, "live_data", True)
    def test_the_past_pattern_never_moves_the_status(self) -> None:
        # Köln forecast 30 mm is above half the Altenahr 12 x 6.5 = 78 mm: still Watch only by the 25 mm cut.
        z = _zetaris()
        with z._lock:
            z._conn.execute(
                "UPDATE floodsense.weather_forecast SET precip_mm=0.5 WHERE point_id='PEG07' AND lead_h < 48"
            )
            z._conn.commit()  # 48 x 0.5 = 24 mm: under 25
        deps = Deps(zetaris=z, llm=FakeNightshift(), memory=NoMemory())
        snap = Runtime(deps=deps).start(RunRequest(question=KOELN))
        self.assertIn("24 mm", snap["claims"][0]["text"])
        self.assertEqual(snap["forecast"]["status"], "Normal")

    @mock.patch.object(settings, "live_data", True)
    def test_all_asked_places_share_one_weather_query(self) -> None:
        deps = Deps(zetaris=_zetaris(), llm=FakeNightshift(), memory=NoMemory())
        snap = Runtime(deps=deps).start(
            RunRequest(question="Will Chiva and Paiporta flood in the next 48 hours?")
        )
        weather = [
            e for e in snap["evidence"].values() if e["view"] == "floodsense.weather_forecast"
        ]
        self.assertEqual(len(weather), 1)
        self.assertIn("point_id IN (", weather[0]["sql"])
        self.assertEqual({r["point_id"] for r in weather[0]["rows_sample"]}, {"VAL01", "VAL07"})
        self.assertEqual(snap["status"], "answered")


@mock.patch.object(settings, "live_data", True)
class RoutingNegativeTest(unittest.TestCase):
    def test_non_forecast_phrases_with_a_place_are_not_forecast(self) -> None:
        for q in (
            "Das war die nächste Frage zu Köln",
            "Die nächste Frage: wo liegt Köln?",
            "Mi próxima pregunta es sobre Valencia",
            "Guten Morgen, Köln",
            "I will outline the Rhine at Köln",
            "How high is the Rhine at Köln?",
            "Is the Danube at Budapest rising?",
            "Show the weekly report for Dresden",
            "What is the forecasting model's name for Köln?",
        ):
            self.assertNotEqual(router.rules(q)[0], "forecast", q)

    def test_a_forecast_cue_without_a_place_is_not_forecast(self) -> None:
        for q in ("Will it flood tomorrow?", "What is the forecast?", "next 48 hours"):
            self.assertNotEqual(router.rules(q)[0], "forecast", q)


class StoringMemory:
    """Engines in miniature: keeps what store() gets, recalls it like the real client."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    def store(self, run_id, request, claims, approval):
        self.stored = (request, claims)
        for c in claims:
            tags = [f"run:{run_id}", *(f"entity:{e.lower()}" for e in c.get("entities") or [])]
            if request.get("event_id"):
                tags.append(f"event:{request['event_id']}")
            self.rows.append(
                {
                    "memory_id": f"m-{c['claim_id']}",
                    "run_id": run_id,
                    "content": c["text"],
                    "tags": tags,
                    "provenance": {"label": f"run {run_id} approved by ana"},
                }
            )
        return {"stored": [{"claim_id": c["claim_id"]} for c in claims], "already_stored": []}

    def recall(self, request):
        return list(self.rows)


@mock.patch.object(settings, "live_data", True)
@mock.patch.object(settings, "ff_hmem", True)
class ApprovedLiveMemoryTest(unittest.TestCase):
    def test_approved_live_run_is_recalled_for_the_same_place(self) -> None:
        mem = StoringMemory()
        deps = Deps(zetaris=_zetaris(), llm=FakeNightshift(), memory=mem)
        rt = Runtime(deps=deps)
        run = rt.start(RunRequest(question="Assess the flood risk on the Loire at Orléans", mode="live"))
        self.assertEqual(run["event_id"], "LIVE-EU")
        rt.resume(run["run_id"], ApprovalDecision(action="approve", reviewer="ana"))
        request, claims = mem.stored
        self.assertEqual(request["event_id"], "LIVE-EU")
        self.assertIn("Loire", claims[0]["entities"])
        snap = Runtime(deps=deps).start(
            RunRequest(question="Do the next 48 hours look safe at Orléans today?")
        )
        self.assertEqual(snap["lane"], "forecast")
        used = {m["memory_id"]: m for m in snap["memory_used"]}
        self.assertTrue(any(m["run_id"] == run["run_id"] and not m["seeded"] for m in used.values()))
        self.assertIn(run["run_id"], snap["plain"]["context"])
        self.assertNotIn("demo seed", snap["plain"]["context"])

    def test_untagged_older_memory_matches_by_place_name_with_accent(self) -> None:
        eu03 = next(p for p in FORECAST_POINTS if p[0] == "EU03")
        old = {"memory_id": "old", "run_id": "r0", "content": "Orléans peaked.", "tags": []}
        self.assertEqual([r["memory_id"] for r in forecast._memory_rows([old], eu03)], ["old"])


RECENT = {
    "memory_id": "mem-213",
    "content": "Loire at Orleans (FR, EU03): level 2.1 m, rising.",
    "confidence": 0.8,
    "run_id": "f6cc",
    "claim_id": "C1",
    "event_id": "LIVE-EU",
    "tags": ["floodsense", "event:LIVE-EU"],
    "provenance": {"label": "run f6cc approved by insurer-desk", "learned_at": "2026-10-27"},
}


def _engines(calls: list[str]):
    from floodsense_agents.engines import EnginesClient

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/hmem/recall":
            old = [
                {"memory_id": f"old-{i}", "content": "Ahr peaked.", "tags": ["event:EMSR517"]}
                for i in range(5)
            ]
            return httpx.Response(200, json={"memories": old})
        return httpx.Response(200, json={"total": 1, "memories": [RECENT]})

    return EnginesClient("http://e.test", transport=httpx.MockTransport(handler))


@mock.patch.object(settings, "live_data", True)
@mock.patch.object(settings, "ff_hmem", True)
class RecentMemoryTest(unittest.TestCase):
    def test_recent_memory_the_ranker_missed_reaches_the_forecast_lane(self) -> None:
        deps = Deps(zetaris=_zetaris(), llm=FakeNightshift(), memory=_engines([]))
        snap = Runtime(deps=deps).start(
            RunRequest(question="Do the next 48 hours look safe at Orléans right now?")
        )
        used = {m["memory_id"]: m for m in snap["memory_used"]}
        self.assertIn("mem-213", used)
        self.assertFalse(used["mem-213"]["seeded"])

    def test_recent_list_is_read_once_within_the_cache_window(self) -> None:
        calls: list[str] = []
        c = _engines(calls)
        for _ in range(2):
            got = c.recall({"question": "Orleans Loire flood", "event_id": "LIVE-EU"})
        self.assertEqual(calls.count("/hmem/memories"), 1)
        self.assertEqual(got[-1]["memory_id"], "mem-213")


if __name__ == "__main__":
    unittest.main()
