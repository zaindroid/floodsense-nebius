"""Control tower: status diffing, the event schema, the caps and switches, persistence, the forecast hook.

No network and no model: a stub Zetaris answers the views, and the run lifecycle uses the fakes.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "contracts" / "python"))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from fastapi.testclient import TestClient  # noqa: E402
from langgraph.checkpoint.memory import MemorySaver  # noqa: E402

from floodsense_contracts.models import WatchEvent, WatchStatus  # noqa: E402
from floodsense_agents import __main__ as service  # noqa: E402
from floodsense_agents import router, tower  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import Evidence, RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris, now_utc  # noqa: E402


CASES = json.loads(
    (HERE.parent / "contracts" / "examples" / "status_cases.json").read_text(encoding="utf-8")
)


def iso(delta_h: float = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=delta_h)).strftime("%Y-%m-%dT%H:%M:%SZ")


def gauge(station="KÖLN", water="RHEIN", level=812, mhw=780, band="above", stale=False):
    return {
        "station": station, "water": water, "ts_utc": iso(-1), "level_cm": level, "mhw_cm": mhw,
        "mw_cm": 300, "band": band, "is_stale": stale, "trend_cm_h": 2,
    }  # fmt: skip


def eu(pid="EU03", name="Orleans", river="Loire", cc="FR", band="above", fmax=840, med=350):
    return {
        "point_id": pid, "name": name, "country": cc, "river": river, "lat": 47.875, "lon": 1.875,
        "discharge_m3s": 400, "forecast_max_m3s": fmax, "past30_median_m3s": med, "band": band,
    }  # fmt: skip


def hazard(pid="VAL01", now_q=4.0, fmax=180.0):
    rows = []
    for h in range(-5, 1):
        rows.append({"point_id": pid, "ts_utc": iso(h), "discharge_m3s": now_q, "horizon": "past"})
    for h in range(1, 49):
        q = fmax if h == 20 else 4.0
        rows.append({"point_id": pid, "ts_utc": iso(h), "discharge_m3s": q, "horizon": "forecast"})
    return rows


def weather(pid, r48=12.0, hour=3.0):
    return {
        "point_id": pid, "name": pid, "river": "", "rain_48h_mm": r48, "rain_72h_mm": r48 + 1,
        "max_hour_48h_mm": hour, "from_utc": iso(0), "to_utc": iso(72), "hours": 72,
    }  # fmt: skip


class Stub:
    """Answers each contract view with canned rows and records every query."""

    def __init__(self, gauges=(), eus=(), hazards=(), weathers=(), exposure=None, fail=()):
        self.rows = {
            "gauge_levels": list(gauges), "eu_watch": list(eus), "hazard_now": list(hazards),
            "weather_forecast": list(weathers),
            "exposure_join": [exposure] if exposure else [{"sites": 0, "policies": 0, "insured_eur": None}],
        }  # fmt: skip
        self.fail = set(fail)
        self.fail_msg = "boom"
        self.queries: list[tuple[str, str]] = []

    def run_sql(self, sql, params=None, sample=20):
        view = next(v for v in self.rows if v in sql)
        self.queries.append((view, sql))
        err = self.fail_msg if view in self.fail else None
        rows = [] if err else self.rows[view]
        return Evidence(
            query_id=f"q-{len(self.queries)}", view=view, sql=sql, rows_sample=rows[:sample],
            row_count=len(rows), executed_at_utc=now_utc(), error=err,
        )  # fmt: skip


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class FakeRuntime:
    """Records start_async calls; snapshot is whatever a test sets."""

    def __init__(self):
        self.started: list[RunRequest] = []
        self.snaps: dict[str, dict] = {}

    def start_async(self, req):
        self.started.append(req)
        return {"run_id": f"run{len(self.started)}", "thread_id": "t", "status": "running"}

    def snapshot(self, run_id):
        return self.snaps[run_id]


def make(stub, tmp, **kw):
    kw.setdefault("clock", Clock())
    kw.setdefault("loop_enabled", False)
    return tower.ControlTower(lambda: stub, kw.pop("runtime", None), data_dir=tmp, **kw)


def full_stub(**kw):
    base = dict(
        gauges=[gauge(), gauge("BONN", level=300, mhw=700, band="below")],
        eus=[eu(), eu("EU04", "Piacenza", "Po", "IT", band="near", fmax=500, med=300), eu("EU01", "Paris", "Seine", "FR", band="below", fmax=100, med=120)],
        hazards=hazard("VAL01"),
        weathers=[weather("PEG07"), weather("EU03", 60.0, 31.0), weather("EU04"), weather("VAL01", 5.0, 1.0)],
        exposure={"sites": 4, "policies": 5, "insured_eur": 12_000_000.0},
    )  # fmt: skip
    base.update(kw)
    return Stub(**base)


class StatusTest(unittest.TestCase):
    def test_plain_words_and_tones_match_the_ui(self):
        words = {
            ("gauge", "over"): ("Above mean high water", "elevated"),
            ("gauge", "near"): ("Close to mean high water", "watch"),
            ("model", "over"): ("Elevated (model)", "elevated"),
            ("model", "near"): ("Watch (model)", "watch"),
            ("valencia", "over"): ("Far above its recent normal (model)", "elevated"),
            ("valencia", "near"): ("Above its recent normal (model)", "neutral"),
            ("gauge", "ok"): ("Normal", "normal"),
            ("model", "unknown"): ("No reading", "unknown"),
        }
        for (kind, st), (word, tone) in words.items():
            v = tower.status_view(kind, st)
            self.assertEqual((v["word"], v["tone"]), (word, tone))
        for kind in ("gauge", "model", "valencia"):
            for st in ("ok", "near", "over", "unknown"):
                v = tower.status_view(kind, st)
                self.assertNotIn("warning", v["word"].lower())
                self.assertNotIn("red", v["tone"])

    def test_gauge_status_follows_the_ui(self):
        for case in CASES["gauge_rows"]:
            with self.subTest(case["name"]):
                self.assertEqual(tower.gauge_status(case["row"]), case["event_status"])

    def test_shared_cases_words_model_bands_and_valencia(self):
        for c in CASES["words"]:
            v = tower.status_view(c["kind"], c["status"])
            self.assertEqual((v["word"], v["tone"], v["rank"]), (c["word"], c["tone"], c["rank"]))
        for c in CASES["model_bands"]:
            ev = Stub(eus=[eu(band=c["band"])]).run_sql("eu_watch", None, 100)
            self.assertEqual(tower.model_sources(ev)[0]["status"], c["status"], c)
        for c in CASES["valencia"]:
            rows = []
            past = c["past"]
            for i, q in enumerate(past):
                rows.append(
                    {
                        "point_id": "VAL01",
                        "ts_utc": iso(i - len(past) + 1),
                        "discharge_m3s": q,
                        "horizon": "past",
                    }
                )
            if c["forecast_max"] is not None:
                rows.append(
                    {
                        "point_id": "VAL01",
                        "ts_utc": iso(5),
                        "discharge_m3s": c["forecast_max"],
                        "horizon": "forecast",
                    }
                )
            ev = Stub(hazards=rows).run_sql("hazard_now", None, 100)
            got = tower.valencia_sources(ev)
            # no rows at all: the tower has no source for the point (never an event), the UI says "no reading"
            self.assertEqual(got[0]["status"] if got else "unknown", c["status"], c)

    def test_valencia_takes_the_higher_of_now_and_the_48h_forecast(self):
        ev = Stub(
            hazards=hazard("VAL01", 4.0, 180.0) + hazard("VAL02", 25.0, 4.0) + hazard("VAL03")[:6]
        ).run_sql("hazard_now", None, 6000)
        by = {s["ref"]: s for s in tower.valencia_sources(ev)}
        # hazard() holds the past flat at "now", so a point's own median is its now (floored at 5)
        self.assertEqual(by["VAL01"]["status"], "over")  # forecast 180 >= 4 x 5
        self.assertEqual(by["VAL02"]["status"], "ok")  # 25 against its own normal of 25
        self.assertEqual(by["VAL03"]["status"], "ok")
        self.assertNotIn("demo line", tower.detected_text(by["VAL01"], None))
        self.assertEqual(by["VAL01"]["row"]["warning_m3s"], 20.0)


class DiffTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def kinds(self, t, since=None):
        return [(e["kind"], e["place"]) for e in t.store.since(since, 500)]

    def test_first_cycle_flags_every_elevated_source_then_nothing_new(self):
        t = make(full_stub(), self.tmp.name)
        out = t.cycle()
        self.assertTrue(out["ran"])
        self.assertEqual((out["sources"], out["elevated"], out["new"]), (3 + 2 + 1, 4, 4))
        detected = {p for k, p in self.kinds(t) if k == "detected"}
        self.assertEqual(detected, {"Köln", "Orleans", "Piacenza", "Paiporta"})
        last = t.store.latest_id()
        out2 = t.cycle()
        self.assertEqual(out2["new"], 0)
        self.assertEqual(t.store.since(last, 50), [])  # an unchanged world adds nothing

    def test_escalation_is_flagged_and_says_where_it_came_from(self):
        stub = full_stub(eus=[eu("EU04", "Piacenza", "Po", "IT", band="near", fmax=500, med=300)])
        t = make(stub, self.tmp.name)
        t.cycle()
        mark = t.store.latest_id()
        stub.rows["eu_watch"] = [
            eu("EU04", "Piacenza", "Po", "IT", band="above", fmax=700, med=300)
        ]
        out = t.cycle()
        self.assertEqual(out["new"], 1)
        ev = [e for e in t.store.since(mark, 50) if e["kind"] == "detected"]
        self.assertEqual(len(ev), 1)
        self.assertIn("Elevated (model)", ev[0]["text"])
        self.assertIn("up from watch (model)", ev[0]["text"])
        # a drop from above to near is not a new alarm
        mark = t.store.latest_id()
        stub.rows["eu_watch"] = [eu("EU04", "Piacenza", "Po", "IT", band="near", fmax=500, med=300)]
        self.assertEqual(t.cycle()["new"], 0)
        self.assertEqual([e for e in t.store.since(mark, 50) if e["kind"] == "detected"], [])

    def test_return_to_normal_is_an_info_event(self):
        stub = full_stub(eus=[eu("EU04", "Piacenza", "Po", "IT", band="near", fmax=500, med=300)])
        t = make(stub, self.tmp.name)
        t.cycle()
        mark = t.store.latest_id()
        stub.rows["eu_watch"] = [
            eu("EU04", "Piacenza", "Po", "IT", band="below", fmax=100, med=300)
        ]
        t.cycle()
        info = [e for e in t.store.since(mark, 50) if e["kind"] == "info"]
        self.assertEqual(len(info), 1)
        self.assertIn("back to normal", info[0]["text"])

    def test_a_view_that_cannot_be_read_keeps_its_last_status(self):
        stub = full_stub()
        t = make(stub, self.tmp.name)
        t.cycle()
        mark = t.store.latest_id()
        stub.fail = {"eu_watch"}
        out = t.cycle()
        self.assertIn("eu_watch", out["errors"])
        new = t.store.since(mark, 50)
        self.assertEqual([e["kind"] for e in new], ["info"])  # one note, no false "recovered"
        self.assertEqual(
            new[0]["text"],
            "The river model feed could not be read this scan; sources keep their last status.",
        )
        self.assertEqual(new[0]["detail"], "boom")
        stub.fail = set()
        mark = t.store.latest_id()
        self.assertEqual(t.cycle()["new"], 0)  # the Loire is not "new" again after the outage
        self.assertEqual(
            [e["text"] for e in t.store.since(mark, 50)],
            ["The river model feed can be read again."],
        )

    def test_a_rate_limit_is_said_plainly_and_the_raw_error_stays_in_detail(self):
        raw = (
            'Zetaris HTTP 400: {"msg":"REST API call failed: Server returned HTTP response code: '
            '429 for URL: https://flood-api.open-meteo.com/v1/flood?x=1"}'
        )
        stub = full_stub()
        stub.fail_msg = raw
        stub.fail = {"eu_watch", "hazard_now"}
        t = make(stub, self.tmp.name)
        t.cycle()
        notes = [e for e in t.store.all() if e["kind"] == "info" and e.get("detail")]
        self.assertTrue(notes)
        for e in notes:
            self.assertEqual(
                e["text"],
                "Open-Meteo is rate-limiting the model feed right now, so these sources keep "
                "their last status.",
            )
            for bad in ("http", "{", "429", "open-meteo.com", "Zetaris"):
                self.assertNotIn(bad, e["text"])
            self.assertIn("429", e["detail"])
        self.assertIn("could not be read", tower.friendly_error("gauge_levels", "boom"))
        self.assertNotIn("Open-Meteo", tower.friendly_error("gauge_levels", "HTTP 429"))

    def test_repeated_identical_failures_share_a_key_and_count(self):
        stub = full_stub()
        t = make(stub, self.tmp.name)
        t.cycle()
        stub.fail = {"eu_watch"}
        for _ in range(3):
            t.cycle()
        rows = [e for e in t.store.all() if e["data"].get("dedupe_key")]
        self.assertEqual([e["data"]["repeats"] for e in rows], [1, 2, 3])
        self.assertEqual(len({e["data"]["dedupe_key"] for e in rows}), 1)
        self.assertRegex(rows[-1]["data"]["since"], r"^\d\d:\d\d$")
        stub.fail = set()
        t.cycle()
        stub.fail = {"eu_watch"}
        t.cycle()  # a new outage after a recovery is a new row with its own count
        last = [e for e in t.store.all() if e["data"].get("dedupe_key")][-1]
        self.assertEqual(last["data"]["repeats"], 1)
        self.assertNotEqual(last["data"]["dedupe_key"], rows[0]["data"]["dedupe_key"])

    def test_a_stale_gauge_is_never_an_event(self):
        t = make(full_stub(gauges=[gauge(stale=True)], eus=[], hazards=[]), self.tmp.name)
        self.assertEqual(t.cycle()["new"], 0)


class EventTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_every_event_matches_the_contract_and_uses_fixed_templates(self):
        t = make(full_stub(), self.tmp.name)
        t.cycle()
        events = t.store.all()
        self.assertGreaterEqual(
            {e["kind"] for e in events}, {"detected", "checked", "exposure", "info"}
        )
        ids = [e["id"] for e in events]
        self.assertEqual(ids, sorted(ids))
        for e in events:
            WatchEvent.model_validate(e)
            self.assertIn(e["agent"], tower.AGENTS)
            self.assertEqual(e["agent"], tower.KIND_AGENT[e["kind"]])
            self.assertNotIn("Warning", e["status"])
        orleans = next(e for e in events if e["kind"] == "detected" and e["place"] == "Orleans")
        self.assertEqual(orleans["place_id"], "model:EU03")
        self.assertEqual(
            orleans["source"], {"view": "eu_watch", "query_id": orleans["source"]["query_id"]}
        )
        self.assertEqual(
            orleans["text"],
            "Loire at Orleans: Elevated (model). The 7-day model maximum is 840 m³/s, 2.4 times the "
            "past-30-day median of 350 m³/s. Model, not an official warning.",
        )

    def test_numbers_in_the_text_come_from_the_rows(self):
        t = make(full_stub(), self.tmp.name)
        t.cycle()
        cologne = next(e for e in t.store.all() if e["kind"] == "detected" and e["place"] == "Köln")
        self.assertIn("Level 812 cm against a long-term mean high water of 780 cm", cologne["text"])
        self.assertIn("Not a warning level", cologne["text"])
        self.assertTrue(cologne["text"].startswith("Rhine at Köln: above mean high water"))

    def test_forecast_hook_records_rain_forecast_max_and_screening(self):
        stub = full_stub()
        t = make(stub, self.tmp.name)
        t.cycle()
        checked = {e["place"]: e for e in t.store.all() if e["kind"] == "checked"}
        self.assertEqual(set(checked), {"Köln", "Orleans", "Piacenza", "Paiporta"})
        o = checked["Orleans"]
        self.assertEqual(o["agent"], "Forecast")
        self.assertEqual(o["data"]["rain_48h_mm"], 60.0)
        self.assertEqual(o["data"]["forecast_max_m3s"], 840)
        self.assertEqual(o["data"]["screening"], "Elevated")  # the lane's own cut: 50 mm in 48 h
        self.assertIn("rain forecast 60 mm over the next 48 h (wettest hour 31 mm)", o["text"])
        self.assertIn("FloodSense screening: elevated", o["text"])
        self.assertEqual(checked["Piacenza"]["data"]["screening"], "Watch")  # band near
        self.assertEqual(o["source"]["view"], "weather_forecast")
        # one weather query serves every flagged place
        self.assertEqual(sum(1 for v, _ in stub.queries if v == "weather_forecast"), 1)

    def test_forecast_gap_is_stated_not_invented(self):
        stub = full_stub(
            weathers=[],
            eus=[{**eu(band="near", fmax=None, med=None), "discharge_m3s": None}],
            gauges=[],
            hazards=[],
        )
        t = make(stub, self.tmp.name)
        t.cycle()
        chk = next(e for e in t.store.all() if e["kind"] == "checked")
        self.assertIn("no forecast rows are held for this place right now", chk["text"])

    def test_exposure_only_for_valencia_and_the_demo_books_area(self):
        stub = full_stub()
        t = make(stub, self.tmp.name)
        t.cycle()
        ex = [e for e in t.store.all() if e["kind"] == "exposure"]
        self.assertEqual([e["place"] for e in ex], ["Paiporta"])
        self.assertEqual(ex[0]["data"]["sites"], 4)
        self.assertIn(
            "4 insured sites of the demo book within about 25 km, 12,000,000 EUR", ex[0]["text"]
        )
        self.assertEqual(ex[0]["agent"], "Exposure")
        queries = [s for v, s in stub.queries if v == "exposure_join"]
        self.assertEqual(len(queries), 1)
        self.assertIn("BETWEEN", queries[0])
        self.assertTrue(tower.near_demo_book({"kind": "valencia", "row": {}, "ref": "VAL01"}))
        self.assertFalse(
            tower.near_demo_book({"kind": "model", "ref": "EU01", "row": {"lat": 48.9, "lon": 2.3}})
        )
        self.assertTrue(
            tower.near_demo_book({"kind": "model", "ref": "X", "row": {"lat": 39.45, "lon": -0.4}})
        )

    def test_story_is_per_source_and_nearby_points_share_one_exposure_read(self):
        stub = full_stub(
            hazards=hazard("VAL01") + hazard("VAL02", 4.0, 12.0),
            eus=[],
            gauges=[],
            weathers=[weather("VAL01"), weather("VAL02")],
        )
        t = make(stub, self.tmp.name)
        t.cycle()
        story = [(e["kind"], e["place"]) for e in t.store.all() if e["kind"] != "info"]
        self.assertEqual(
            story,
            [
                ("detected", "Paiporta"),  # worst first: far above its recent normal
                ("checked", "Paiporta"),
                ("exposure", "Paiporta"),
                ("detected", "Catarroja"),
                ("checked", "Catarroja"),
            ],
        )
        ex = next(e for e in t.store.all() if e["kind"] == "exposure")
        self.assertEqual(ex["data"]["also_covers"], ["Catarroja"])
        self.assertIn("(also covering Catarroja)", ex["text"])
        self.assertEqual(sum(1 for v, _ in stub.queries if v == "exposure_join"), 1)

    def test_exposure_zero_sites_says_so(self):
        stub = full_stub(exposure={"sites": 0, "policies": 0, "insured_eur": None})
        t = make(stub, self.tmp.name)
        t.cycle()
        ex = next(e for e in t.store.all() if e["kind"] == "exposure")
        self.assertIn("no insured sites of the demo book within about 25 km", ex["text"])

    def test_with_the_fake_zetaris_a_cycle_runs_without_a_model(self):
        t = tower.ControlTower(
            lambda: FakeZetaris(), None, data_dir=self.tmp.name, loop_enabled=False
        )
        out = t.cycle()
        self.assertTrue(out["ran"])
        self.assertEqual(out["errors"], {})


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def ev(self, i):
        return {"kind": "info", "agent": "Watch", "place": "", "river": "", "country": "", "status": "",
                "tone": "unknown", "text": f"e{i}", "source": {"view": "watch", "query_id": None}, "data": {}}  # fmt: skip

    def test_ring_is_bounded_at_500_and_since_pages(self):
        s = tower.EventStore(self.tmp.name)
        for i in range(520):
            s.append(self.ev(i))
        self.assertEqual(len(s), 500)
        self.assertEqual(s.all()[0]["text"], "e20")
        self.assertEqual(len(s.since(None, 1000)), 500)
        first = s.since("w00000100", 5)
        self.assertEqual([e["id"] for e in first], [f"w{n:08d}" for n in range(101, 106)])
        self.assertEqual(s.since(s.latest_id()), [])
        self.assertEqual([e["text"] for e in s.since(None, 3)], ["e517", "e518", "e519"])

    def test_history_survives_a_restart_and_ids_keep_counting(self):
        s = tower.EventStore(self.tmp.name)
        for i in range(3):
            s.append(self.ev(i))
        again = tower.EventStore(self.tmp.name)
        self.assertEqual([e["text"] for e in again.all()], ["e0", "e1", "e2"])
        new = again.append(self.ev(3))
        self.assertEqual(new["id"], "w00000004")
        lines = (
            (Path(self.tmp.name) / "watch_events.jsonl").read_text(encoding="utf-8").splitlines()
        )
        self.assertEqual(len(lines), 4)
        self.assertEqual(json.loads(lines[-1])["text"], "e3")

    def test_a_restart_remembers_statuses_so_the_loire_is_not_new_again(self):
        stub = full_stub()
        make(stub, self.tmp.name).cycle()
        t2 = make(stub, self.tmp.name)
        self.assertGreater(len(t2.store), 0)
        self.assertEqual(t2.cycle()["new"], 0)

    def test_a_corrupt_line_and_an_unwritable_directory_do_not_break_it(self):
        p = Path(self.tmp.name) / "watch_events.jsonl"
        p.write_text('not json\n{"id": "w00000007", "kind": "info"}\n', encoding="utf-8")
        s = tower.EventStore(self.tmp.name)
        self.assertEqual(s.append(self.ev(0))["id"], "w00000008")
        blocker = Path(self.tmp.name) / "file"
        blocker.write_text("x")
        mem = tower.EventStore(blocker / "sub")  # cannot mkdir under a file
        self.assertIsNone(mem.path)
        mem.append(self.ev(1))
        self.assertEqual(len(mem), 1)


class AutoAssessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_auto_assess_is_off_by_default_and_starts_nothing(self):
        os.environ.pop("FF_AUTO_ASSESS", None)
        rt = FakeRuntime()
        t = tower.ControlTower(
            lambda: full_stub(), lambda: rt, data_dir=self.tmp.name, loop_enabled=False
        )
        self.assertFalse(t.auto_assess)
        t.cycle()
        self.assertEqual(rt.started, [])
        self.assertFalse(t.status()["auto_assess"]["enabled"])

    def test_the_first_ever_scan_never_auto_assesses(self):
        rt = FakeRuntime()
        t = make(full_stub(), self.tmp.name, runtime=lambda: rt, auto_assess=True)
        out = t.cycle()
        self.assertEqual(out["new"], 4)  # everything raised is announced ...
        self.assertIsNone(out["auto_assess_run_id"])  # ... and marked seen, but nothing is started
        self.assertEqual(rt.started, [])
        self.assertEqual(t.auto_status()["used_day"], 0)

    def test_a_first_scan_that_reads_nothing_keeps_the_baseline(self):
        rt = FakeRuntime()
        stub = full_stub(fail={"gauge_levels", "eu_watch", "hazard_now"})
        t = make(stub, self.tmp.name, runtime=lambda: rt, auto_assess=True)
        out = t.cycle()
        self.assertEqual(out["sources"], 0)
        self.assertFalse(
            (Path(self.tmp.name) / "watch_state.json").exists()
        )  # nothing learned, nothing saved
        stub.fail = set()
        t.cycle()  # the real first read: announced, never auto-assessed
        self.assertEqual(rt.started, [])
        stub.rows["eu_watch"].append(eu("EU07", "Vienna", "Danube", "AT", band="above"))
        self.assertIsNotNone(t.cycle()["auto_assess_run_id"])
        # a restart after an empty first scan is still a first start
        t2 = make(full_stub(), tempfile.mkdtemp(), runtime=lambda: rt, auto_assess=True)
        self.assertTrue(t2._baseline)

    def test_switch_and_the_one_per_hour_cap(self):
        clock = Clock()
        rt = FakeRuntime()
        stub = full_stub()
        t = make(stub, self.tmp.name, runtime=lambda: rt, auto_assess=True, clock=clock)
        t.cycle()  # baseline: learns what is raised
        stub.rows["eu_watch"].append(
            eu("EU07", "Vienna", "Danube", "AT", band="above", fmax=2000, med=900)
        )
        clock.t += 100
        out = t.cycle()
        self.assertEqual(out["auto_assess_run_id"], "run1")
        self.assertEqual(len(rt.started), 1)
        req = rt.started[0]
        self.assertIn("Vienna", req.question)
        self.assertEqual(
            req.context.model_dump(exclude_none=True),
            {"role": "insurer", "page": "control-tower", "place": "Vienna", "auto": True},
        )
        self.assertEqual(
            router.route(req, None)["lane"], "full"
        )  # "insured sites" sends it to the full lane
        started = [e for e in t.store.all() if e["run_id"] == "run1"]
        self.assertEqual(len(started), 1)
        self.assertIn("model calls", started[0]["text"])
        # a new elevated source half an hour later: the hourly cap holds it back
        stub.rows["eu_watch"].append(
            eu("EU11", "Prague", "Vltava", "CZ", band="above", fmax=900, med=300)
        )
        clock.t += 1800
        self.assertEqual(t.cycle()["auto_assess_run_id"], None)
        self.assertEqual(len(rt.started), 1)
        self.assertEqual(t.auto_status()["used_hour"], 1)
        self.assertIsNotNone(t.auto_status()["next_allowed_at"])
        # after the hour the next new source may start one
        stub.rows["eu_watch"].append(
            eu("EU09", "Szeged", "Tisza", "HU", band="above", fmax=900, med=300)
        )
        clock.t += 3600
        self.assertEqual(t.cycle()["auto_assess_run_id"], "run2")

    def test_three_per_day_cap(self):
        clock = Clock()
        rt = FakeRuntime()
        stub = Stub(eus=[eu("EU08", "Budapest", "Danube", "HU", band="below", fmax=100, med=120)])
        t = make(stub, self.tmp.name, runtime=lambda: rt, auto_assess=True, clock=clock)
        t.cycle()  # baseline
        started = []
        for pid in ["EU01", "EU02", "EU03", "EU04", "EU05"]:
            stub.rows["eu_watch"].append(eu(pid, pid, "R", "FR", band="above"))
            clock.t += 3700  # outside the hourly window each time
            started.append(t.cycle()["auto_assess_run_id"])
        self.assertEqual(started, ["run1", "run2", "run3", None, None])
        self.assertEqual(t.auto_status()["used_day"], 3)
        clock.t += 86400
        stub.rows["eu_watch"].append(eu("EU06", "EU06", "R", "PL", band="above"))
        self.assertEqual(t.cycle()["auto_assess_run_id"], "run4")

    def test_the_cap_is_saved_before_the_run_starts_and_survives_a_restart(self):
        clock = Clock()
        stub = Stub(eus=[eu("EU08", "Budapest", "Danube", "HU", band="below", fmax=100, med=120)])

        class Crash(FakeRuntime):
            def start_async(self, req):
                saved = tower.JsonState(self_dir).load()
                seen.append(len(saved.get("auto_times") or []))
                raise SystemExit  # a crash right after the cap was counted

        self_dir, seen = self.tmp.name, []
        rt = Crash()
        t = make(stub, self.tmp.name, runtime=lambda: rt, auto_assess=True, clock=clock)
        t.cycle()
        stub.rows["eu_watch"].append(eu("EU07", "Vienna", "Danube", "AT", band="above"))
        with self.assertRaises(SystemExit):
            t.cycle()
        self.assertEqual(seen, [1])  # already on disk when start_async was called
        t2 = make(stub, self.tmp.name, runtime=lambda: FakeRuntime(), auto_assess=True, clock=clock)
        self.assertEqual(t2.auto_status()["used_hour"], 1)

    def test_a_failed_start_gives_the_cap_back(self):
        class Fails(FakeRuntime):
            def start_async(self, req):
                raise RuntimeError("no")

        stub = Stub(eus=[eu("EU08", "Budapest", "Danube", "HU", band="below", fmax=100, med=120)])
        t = make(stub, self.tmp.name, runtime=lambda: Fails(), auto_assess=True)
        t.cycle()
        stub.rows["eu_watch"].append(eu("EU07", "Vienna", "Danube", "AT", band="above"))
        self.assertIsNone(t.cycle()["auto_assess_run_id"])
        self.assertEqual(t.auto_status()["used_day"], 0)
        self.assertEqual(tower.JsonState(self.tmp.name).load()["auto_times"], [])

    def test_unpersisted_state_fails_closed(self):
        rt = FakeRuntime()
        stub = Stub(eus=[eu("EU08", "Budapest", "Danube", "HU", band="below", fmax=100, med=120)])
        t = tower.ControlTower(
            lambda: stub, lambda: rt, data_dir=None, loop_enabled=False, auto_assess=True
        )
        # data_dir=None means the default dir, which is none under CHECKPOINTER=memory
        self.assertIsNone(t.state.path)
        self.assertFalse(t.auto_assess)
        st = t.status()
        self.assertFalse(st["persisted"])
        self.assertIn("CHECKPOINTER=memory", st["persisted_reason"])
        self.assertIn("CHECKPOINTER=memory", st["auto_assess"]["blocked"])
        t.set_auto_assess(True)
        self.assertFalse(t.auto_status()["enabled"])
        t.cycle()
        stub.rows["eu_watch"].append(eu("EU07", "Vienna", "Danube", "AT", band="above"))
        t.cycle()
        self.assertEqual(rt.started, [])

    def test_a_scan_that_raises_still_records_what_it_read(self):
        stub = full_stub()
        t = make(stub, self.tmp.name)

        def boom(*a, **k):
            raise ValueError("boom")

        t.emit_orig = t.emit
        calls = {"n": 0}

        def flaky(kind, text, **kw):
            if kind == "detected":
                calls["n"] += 1
                if calls["n"] == 2:
                    raise ValueError("boom")
            return t.emit_orig(kind, text, **kw)

        t.emit = flaky
        with self.assertRaises(ValueError):
            t.cycle()
        self.assertGreater(len(t.prev), 0)  # the next scan diffs against what was read
        self.assertEqual(tower.JsonState(self.tmp.name).load()["statuses"], t.prev)
        t.emit = t.emit_orig
        self.assertEqual(t.cycle()["new"], 0)

    def test_no_weather_query_when_nothing_new_was_raised(self):
        stub = full_stub()
        t = make(stub, self.tmp.name)
        t.cycle()
        first = sum(1 for v, _ in stub.queries if v == "weather_forecast")
        self.assertEqual(first, 1)
        t.cycle()
        t.cycle()
        self.assertEqual(sum(1 for v, _ in stub.queries if v == "weather_forecast"), 1)
        self.assertEqual(sum(1 for v, _ in stub.queries if v == "exposure_join"), 1)

    def test_default_interval_is_900_seconds(self):
        os.environ.pop("WATCH_INTERVAL_S", None)
        t = tower.ControlTower(lambda: full_stub(), None, data_dir=self.tmp.name)
        self.assertEqual(t.interval_s, 900)

    def test_runtime_switch_never_approves_anything(self):
        rt = FakeRuntime()
        t = make(full_stub(), self.tmp.name, runtime=lambda: rt)
        self.assertFalse(t.auto_assess)
        t.set_auto_assess(True)
        self.assertTrue(t.auto_status()["enabled"])
        self.assertTrue(t.auto_status()["uses_model_calls"])
        self.assertFalse(hasattr(rt, "resume"))  # the tower has no way to approve
        t.set_auto_assess(False)
        t.cycle()
        self.assertEqual(rt.started, [])

    def test_manual_scan_is_rate_limited_and_never_overlaps(self):
        clock = Clock()
        t = make(full_stub(), self.tmp.name, clock=clock)
        self.assertTrue(t.force(block=True)["ran"])
        again = t.force(block=True)
        self.assertFalse(again["ran"])
        self.assertGreaterEqual(again["retry_after_s"], 1)
        clock.t += 10
        self.assertTrue(t.force(block=True)["ran"])
        t._cycle_lock.acquire()
        try:
            self.assertEqual(t.cycle()["reason"], "a scan is already running")
        finally:
            t._cycle_lock.release()

    def test_loop_switch(self):
        os.environ["FF_WATCH_LOOP"] = "false"
        try:
            t = tower.ControlTower(lambda: full_stub(), None, data_dir=self.tmp.name)
            self.assertFalse(t.loop_enabled)
            self.assertFalse(t.start())
        finally:
            os.environ.pop("FF_WATCH_LOOP", None)
        t = tower.ControlTower(lambda: full_stub(), None, data_dir=self.tmp.name, interval_s=300)
        self.assertTrue(t.loop_enabled)
        self.assertEqual(t.interval_s, 300)


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        self.rt = Runtime(graph=build_graph(deps, MemorySaver(), ff_judge=True), deps=deps)
        service.set_runtime(self.rt)
        self.t = tower.ControlTower(
            lambda: self.rt.deps.zetaris,
            lambda: self.rt,
            data_dir=self.tmp.name,
            loop_enabled=False,
        )
        service.set_tower(self.t)
        self.addCleanup(lambda: service.set_tower(None))
        self.c = TestClient(service.app)

    def test_endpoints_status_events_cycle(self):
        r = self.c.post("/watch/cycle")
        self.assertEqual(r.status_code, 202)  # answered at once; the scan runs on a thread
        self.assertTrue(r.json()["cycle"]["started"])
        self.assertTrue(r.json()["status"]["scanning"])
        for _ in range(100):
            if not self.t.scanning and self.t.last_cycle:
                break
            time.sleep(0.05)
        self.assertTrue(self.t.last_cycle["ran"])
        self.assertEqual(self.c.post("/watch/cycle").status_code, 429)
        self.assertIn("Retry-After", self.c.post("/watch/cycle").headers)
        st = self.c.get("/watch/status").json()
        body = {k: v for k, v in st.items() if k != "label"}
        WatchStatus.model_validate(body)
        self.assertFalse(st["auto_assess"]["enabled"])
        self.assertEqual((st["auto_assess"]["per_hour"], st["auto_assess"]["per_day"]), (1, 3))
        self.assertIn("no model calls", st["note"])
        ev = self.c.get("/watch/events").json()
        self.assertEqual(ev["latest_id"], ev["events"][-1]["id"])
        for e in ev["events"]:
            WatchEvent.model_validate(e)
        self.assertEqual(self.c.get(f"/watch/events?since={ev['latest_id']}").json()["events"], [])
        self.assertEqual(len(self.c.get("/watch/events?limit=1").json()["events"]), 1)
        cfg = self.c.get("/config").json()
        self.assertEqual(cfg["watch"]["FF_AUTO_ASSESS"], False)
        self.assertEqual(cfg["watch"]["auto_assess_per_hour"], 1)
        self.assertNotIn(
            "FF_AUTO_ASSESS", cfg["flags"]
        )  # the flags are the API cache key; the switch moves

    def test_auto_assess_toggle(self):
        on = self.c.post("/watch/auto-assess", json={"enabled": True}).json()
        self.assertTrue(on["auto_assess"]["enabled"])
        self.assertTrue(self.c.get("/config").json()["watch"]["FF_AUTO_ASSESS"])
        off = self.c.post("/watch/auto-assess", json={"enabled": False}).json()
        self.assertFalse(off["auto_assess"]["enabled"])
        self.assertEqual(
            self.c.post("/watch/auto-assess", json={"enabled": "maybe"}).status_code, 422
        )

    def test_the_switch_needs_the_admin_token_when_one_is_set(self):
        os.environ["WATCH_ADMIN_TOKEN"] = "s3cret"
        try:
            self.assertEqual(
                self.c.post("/watch/auto-assess", json={"enabled": True}).status_code, 401
            )
            bad = self.c.post(
                "/watch/auto-assess", json={"enabled": True}, headers={"x-watch-admin-token": "no"}
            )
            self.assertEqual(bad.status_code, 401)
            self.assertFalse(self.t.auto_assess)
            ok = self.c.post(
                "/watch/auto-assess",
                json={"enabled": True},
                headers={"x-watch-admin-token": "s3cret"},
            )
            self.assertEqual(ok.status_code, 200)
            self.assertTrue(ok.json()["auto_assess"]["enabled"])
            self.assertEqual(self.c.get("/watch/status").status_code, 200)  # reading needs no token
        finally:
            os.environ.pop("WATCH_ADMIN_TOKEN", None)

    def test_switching_on_without_saved_state_is_refused(self):
        t = tower.ControlTower(
            lambda: self.rt.deps.zetaris, lambda: self.rt, data_dir=None, loop_enabled=False
        )
        service.set_tower(t)
        r = self.c.post("/watch/auto-assess", json={"enabled": True})
        self.assertEqual(r.status_code, 409)
        self.assertIn("auto-assess stays off", r.json()["detail"])
        self.assertFalse(self.c.get("/watch/status").json()["persisted"])

    def test_open_streams_are_bounded(self):
        service._streams = service.STREAM_MAX_CONNECTIONS
        try:
            r = self.c.get("/watch/stream")
            self.assertEqual(r.status_code, 429)
            self.assertIn("Retry-After", r.headers)
        finally:
            service._streams = 0

    def test_stream_sends_events_after_since_with_ids(self):
        self.t.emit("info", "first")
        self.t.emit("info", "second")
        service.STREAM_MAX_S, service.STREAM_POLL_S = 1.5, 0.2
        try:
            with self.c.stream("GET", "/watch/stream?since=w00000001") as s:
                text = "".join(s.iter_text())
        finally:
            service.STREAM_MAX_S, service.STREAM_POLL_S = 900, 1.0
        self.assertIn("id: w00000002\nevent: watch\n", text)
        self.assertIn('"text": "second"', text)
        self.assertNotIn('"text": "first"', text)

    def test_a_full_run_tells_the_whole_story_and_never_approves_itself(self):
        run = self.rt.start(
            RunRequest(
                question="Why are our Valencia sites at risk?",
                event_id="EMSR773",
                replay_ts="2024-10-29T18:00:00Z",
            )
        )
        self.assertEqual(run["status"], "awaiting_approval")
        kinds = [
            (e["kind"], e["agent"]) for e in self.t.store.all() if e["run_id"] == run["run_id"]
        ]
        self.assertEqual(kinds, [("drafted", "Playbook"), ("awaiting_approval", "Judge")])
        self.assertEqual(self.t.status()["counts"]["awaiting_approval"], 1)
        self.assertEqual(self.t.awaiting_run_ids(), [run["run_id"]])
        r = self.c.post(
            f"/runs/{run['run_id']}/approval", json={"action": "approve", "reviewer": "t"}
        )
        self.assertEqual(r.status_code, 200)
        kinds = [
            (e["kind"], e["agent"]) for e in self.t.store.all() if e["run_id"] == run["run_id"]
        ]
        self.assertEqual(kinds[-1], ("approved", "Human"))
        self.assertEqual(self.t.status()["counts"]["awaiting_approval"], 0)
        for e in self.t.store.all():
            WatchEvent.model_validate(e)

    def test_a_rejection_is_recorded_as_a_human_info_event(self):
        run = self.rt.start(
            RunRequest(
                question="Why are our Valencia sites at risk?",
                event_id="EMSR773",
                replay_ts="2024-10-29T18:00:00Z",
            )
        )
        self.c.post(
            f"/runs/{run['run_id']}/approval",
            json={"action": "reject", "reviewer_note": "no", "reviewer": "t"},
        )
        last = [e for e in self.t.store.all() if e["run_id"] == run["run_id"]][-1]
        self.assertEqual((last["kind"], last["agent"]), ("info", "Human"))
        self.assertIn("rejected", last["text"])
        self.assertEqual(self.t.awaiting_run_ids(), [])

    def test_a_quick_answer_adds_nothing(self):
        before = len(self.t.store)
        self.rt.observers[0]("paused", "does-not-exist")  # unknown run: ignored
        self.assertEqual(len(self.t.store), before)


class ObserverTest(unittest.TestCase):
    def test_an_observer_that_raises_does_not_break_a_run(self):
        deps = Deps(zetaris=FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())
        rt = Runtime(graph=build_graph(deps, MemorySaver(), ff_judge=True), deps=deps)

        def boom(kind, run_id):
            raise RuntimeError("x")

        rt.observers.append(boom)
        run = rt.start(
            RunRequest(
                question="Why are our Valencia sites at risk?",
                event_id="EMSR773",
                replay_ts="2024-10-29T18:00:00Z",
            )
        )
        self.assertEqual(run["status"], "awaiting_approval")


if __name__ == "__main__":
    unittest.main()
