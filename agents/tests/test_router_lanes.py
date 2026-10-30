"""Router agent: rules, the mocked fast lane, the quick lane and its escalation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from floodsense_agents import router  # noqa: E402
from floodsense_agents.models import Evidence, RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes import quick  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris, now_utc  # noqa: E402

KOELN = "How high is the Rhine at Köln?"


def _zetaris(gauges=(("KÖLN", "RHEIN", 412.0),), eu=()) -> FakeZetaris:
    z = FakeZetaris()
    with z._lock:
        for station, water, level in gauges:
            z._conn.execute(
                "INSERT INTO floodsense.gauge_levels VALUES (?,?,?,?,?)",
                (station, water, now_utc(), level, "pegelonline"),
            )
        for pid, q, fmax, med, band in eu:
            z._conn.execute(
                "UPDATE floodsense.eu_watch SET discharge_m3s=?, forecast_max_m3s=?, "
                "past30_median_m3s=?, band=? WHERE point_id=?",
                (q, fmax, med, band, pid),
            )
        z._conn.commit()
    return z


class _Raising:
    def complete(self, lane, system, user, *, json=True):
        raise RuntimeError("gateway 502")


@mock.patch.object(settings, "live_data", True)
class RouterRulesTest(unittest.TestCase):
    def test_live_questions_with_a_place_go_quick(self) -> None:
        for q, place in [
            (KOELN, "KÖLN"),
            ("Is any Valencia point at risk right now?", "VALENCIA"),
            ("Is the Danube at Budapest rising?", "BUDAPEST"),
            ("Is the Elbe in Dresden rising now?", "DRESDEN"),
        ]:
            lane, why = router.rules(q)
            self.assertEqual(lane, "quick", q)
            self.assertIn(place, why)

    def test_watch_places_come_from_watch_py(self) -> None:
        for w in ("budapest", "szeged", "vltava", "dresden", "porta"):
            self.assertIn(w, router.PLACES)
        self.assertNotIn("main", router.PLACES)

    def test_deep_words_go_full(self) -> None:
        for q in [
            "Why is the Rhine at Köln rising?",
            "Which insured sites are exposed in Valencia right now?",
            "Replay the Ahr flood",
            "What happened in Valencia on 29 October 2024?",
            "Draft alerts for the policyholders in Valencia now",
            "What does the EFAS bulletin say about the Danube today?",
        ]:
            self.assertEqual(router.rules(q)[0], "full", q)

    def test_ambiguous_is_none(self) -> None:
        self.assertIsNone(router.rules("Is it rising now?")[0])
        self.assertIsNone(router.rules("Tell me about Valencia")[0])

    def test_route_records_a_reason(self) -> None:
        got = router.route(RunRequest(question=KOELN))
        self.assertEqual((got["lane"], got["model_id"]), ("quick", "rules"))
        self.assertEqual(got["reason"], "chose quick: live level question about KÖLN")

    def test_explicit_requests_stay_full_for_the_evals(self) -> None:
        for req in (
            RunRequest(question=KOELN, event_id="EMSR517"),
            RunRequest(question=KOELN, replay_ts="2021-07-14T18:00:00Z"),
            RunRequest(question=KOELN, doc_query="EFAS bulletin"),
            RunRequest(question=KOELN, mode="event"),
        ):
            self.assertEqual(router.route(req)["lane"], "full")

    def test_flag_off(self) -> None:
        with mock.patch.dict("os.environ", {"FF_QUICK_LANE": "false"}):
            self.assertEqual(router.route(RunRequest(question=KOELN))["lane"], "full")


class LiveDataOffTest(unittest.TestCase):
    @mock.patch.object(settings, "live_data", False)
    def test_no_quick_answer_for_now_without_live_data(self) -> None:
        got = router.route(RunRequest(question=KOELN))
        self.assertEqual(got["lane"], "full")
        self.assertIn("FF_LIVE_DATA", got["reason"])


@mock.patch.object(settings, "live_data", True)
class RouterModelTest(unittest.TestCase):
    def test_model_decides_only_ambiguous(self) -> None:
        llm = FakeNightshift({"router": lambda s, u: '{"lane": "quick"}'})
        got = router.route(RunRequest(question="Is it rising now?"), llm)
        self.assertEqual((got["lane"], got["model_id"]), ("quick", "fake-fast"))
        self.assertEqual(llm.calls[0][:2], ("fast", "router"))
        router.route(RunRequest(question=KOELN), llm)
        self.assertEqual(len(llm.calls), 1)

    def test_failure_or_bad_label_means_full(self) -> None:
        q = RunRequest(question="Is it rising now?")
        self.assertEqual(router.route(q, _Raising())["lane"], "full")
        bad = FakeNightshift({"router": lambda s, u: '{"lane": "sideways"}'})
        self.assertEqual(router.route(q, bad)["lane"], "full")

    def test_router_has_its_own_pool(self) -> None:
        from floodsense_agents import front_door

        self.assertIsNot(router._POOL, front_door._POOL)


class DeclineTest(unittest.TestCase):
    def test_scope_decline_is_never_overridden(self) -> None:
        declined = {"scope": {"in_scope": False, "elsewhere": None}, "lane": "quick"}
        self.assertEqual(quick.route_after_scope(declined), "declined")
        self.assertEqual(quick.route_after_escalate(declined), "declined")
        self.assertEqual(quick.route_after_escalate({"scope": {"in_scope": True}}), "watchers")


class TemplateTest(unittest.TestCase):
    def test_gauge_band_trend_time_and_stale(self) -> None:
        row = {
            "station": "KÖLN",
            "water": "RHEIN",
            "level_cm": 640.0,
            "mhw_cm": 620.0,
            "ts_utc": "2020-01-01T12:45:00Z",
            "prev_cm": 600.0,
            "prev_utc": "2020-01-01T09:45:00Z",
        }
        text, nums, lead, sev = quick.gauge_claim(row)
        self.assertIn("measured at 12:45 UTC", text)
        self.assertIn("stale", text)
        self.assertEqual(nums, [640.0, 620.0, 600.0])
        self.assertEqual(lead, "KÖLN: above mean high water and rising (gauge, 12:45 UTC, stale)")
        near = quick.gauge_claim({**row, "level_cm": 550.0, "prev_cm": None})[0]
        self.assertIn("FloodSense's own cut, not an official threshold", near)

    def test_summary_lead_is_worst_band_first(self) -> None:
        state = {
            "live_findings": {
                "quick_places": [
                    {"kind": "gauge", "id": "BONN", "query_id": "b"},
                    {"kind": "gauge", "id": "KÖLN", "query_id": "k"},
                ]
            },
            "evidence": {
                q: {
                    "query_id": q,
                    "view": "floodsense.gauge_levels",
                    "sql": "",
                    "executed_at_utc": now_utc(),
                    "row_count": 1,
                    "rows_sample": [
                        {
                            "station": st,
                            "water": "RHEIN",
                            "level_cm": lv,
                            "mhw_cm": 600.0,
                            "ts_utc": now_utc(),
                        }
                    ],
                }
                for q, st, lv in (("b", "BONN", 300.0), ("k", "KÖLN", 650.0))
            },
        }
        claims, lead = quick.build_claims(state)
        self.assertEqual(len(claims), 2)
        self.assertTrue(lead.startswith("KÖLN: above mean high water"), lead)
        self.assertIn("BONN: below mean high water", lead)


@mock.patch.object(settings, "live_data", True)
class QuickLaneTest(unittest.TestCase):
    def _run(self, question=KOELN, z=None, llm=None):
        deps = Deps(zetaris=z or _zetaris(), llm=llm or FakeNightshift(), memory=NoMemory())
        return Runtime(deps=deps).start(RunRequest(question=question))

    def test_quick_answer_is_deterministic_and_passes_the_judge(self) -> None:
        llm = FakeNightshift()
        snap = self._run(llm=llm)
        self.assertEqual(
            (snap["lane"], snap["status"]), ("quick", "answered"), snap["router_reason"]
        )
        self.assertTrue(snap["judge_summary"]["passes"])
        self.assertEqual(snap["approval"]["status"], "not_reached")
        self.assertEqual(snap["playbook"], [])
        self.assertEqual(
            [e["node"] for e in snap["trace"]],
            ["router", "scope", "live_watch", "quick_answer", "judge"],
        )
        self.assertEqual(len(snap["claims"]), 1)
        claim = snap["claims"][0]
        self.assertIn("412 cm", claim["text"])
        self.assertEqual(claim["numbers"], [412.0])
        self.assertTrue(snap["summary"].startswith("KÖLN: latest level (gauge, "), snap["summary"])
        self.assertEqual(llm.calls, [])  # the quick lane makes no model call
        sql = snap["evidence"][claim["citations"][0]["query_id"]]["sql"]
        self.assertIn("g.station IN ('KÖLN')", sql)

    def test_one_places_figure_never_appears_for_another(self) -> None:
        z = _zetaris(
            gauges=(
                ("REGENSBURG EISERNE BRÜCKE", "DONAU", 301.0),
                ("PASSAU DONAU", "DONAU", 577.0),
            ),
            eu=(
                ("EU07", 1810.0, 2400.0, 1700.0, "below"),
                ("EU08", 2210.0, 2600.0, 2000.0, "below"),
            ),
        )
        snap = self._run("Is the Danube rising now?", z=z)
        self.assertEqual(
            (snap["lane"], snap["status"]), ("quick", "answered"), snap["router_reason"]
        )
        self.assertEqual(len(snap["claims"]), 4)
        all_values = {301.0, 577.0, 1810.0, 2400.0, 1700.0, 2210.0, 2600.0, 2000.0}
        for claim in snap["claims"]:
            ids = {c["query_id"] for c in claim["citations"] if c.get("query_id")}
            self.assertEqual(len(ids), 1)
            rows = snap["evidence"][ids.pop()]["rows_sample"]
            self.assertEqual(len(rows), 1)
            own = {
                float(v)
                for v in rows[0].values()
                if isinstance(v, (int, float)) and not isinstance(v, bool)
            }
            for n in claim["numbers"]:
                self.assertIn(n, own)
            for other in all_values - own:
                self.assertNotIn(f"{other:g}", claim["text"])

    def test_a_crossed_figure_is_flagged_and_escalates(self) -> None:
        z = _zetaris(gauges=(("KÖLN", "RHEIN", 412.0), ("BONN", "RHEIN", 380.0)))

        def crossed(row):
            # BONN's figure on every gauge
            return f"{row['station']} level 380 cm.", [380.0], str(row["station"]), 0

        with mock.patch.dict(quick._TEMPLATES, {"gauge": crossed}):
            snap = self._run("How high is the Rhine at Köln and Bonn now?", z=z)
        self.assertEqual(snap["lane"], "full")
        self.assertIn("escalated: judge flagged Q1", snap["router_reason"])
        self.assertEqual(
            len(
                [e for e in snap["trace"] if e["node"] == "router" and "escalated" in e["summary"]]
            ),
            1,
        )
        self.assertIn("watchers", [e["node"] for e in snap["trace"]])

    def test_missing_data_escalates(self) -> None:
        snap = self._run(z=_zetaris(gauges=()))
        self.assertEqual(snap["lane"], "full")
        self.assertIn("escalated: no live rows", snap["router_reason"])

    def test_valencia_forecast_from_hazard_now(self) -> None:
        snap = self._run("Is Paiporta at risk right now?")
        self.assertEqual(
            (snap["lane"], snap["status"]), ("quick", "answered"), snap["router_reason"]
        )
        self.assertEqual(len(snap["claims"]), 1)
        self.assertIn("Paiporta (VAL01)", snap["claims"][0]["text"])
        self.assertIn(180.0, snap["claims"][0]["numbers"])

    def test_budapest_from_eu_watch_only_its_row(self) -> None:
        z = _zetaris(gauges=(), eu=(("EU08", 2210.0, 2600.0, 2000.0, "below"),))
        snap = self._run("Is the Danube at Budapest rising?", z=z)
        self.assertEqual(
            (snap["lane"], snap["status"]), ("quick", "answered"), snap["router_reason"]
        )
        self.assertIn("model", snap["claims"][0]["text"])
        ev = list(snap["evidence"].values())
        self.assertEqual([e["rows_sample"][0]["point_id"] for e in ev], ["EU08"])

    def test_own_row_matches_name_river_and_id_only(self) -> None:
        ev = Evidence(
            query_id="x",
            view="floodsense.eu_watch",
            sql="",
            executed_at_utc=now_utc(),
            rows_sample=[{"point_id": "EU08", "name": "Vienna", "river": "Danube"}],
        )
        self.assertIsNone(quick._own_row("eu", "EU08", ev))


class PointClaimLeadTest(unittest.TestCase):
    def test_rain_only_point_says_no_discharge_forecast(self):
        _text, nums, lead, severity = quick.point_claim(
            {"point_id": "VAL01", "forecast_max_discharge_m3s": None, "forecast_max_rain_mm": 4.2}
        )
        self.assertIn("no discharge forecast", lead)
        self.assertNotIn("stays under", lead)
        self.assertEqual(nums, [4.2])
        self.assertEqual(severity, 0)

    def test_discharge_point_keeps_the_anomaly_line(self):
        _text, _nums, lead, _sev = quick.point_claim(
            {"point_id": "VAL01", "forecast_max_discharge_m3s": 12.0, "forecast_max_rain_mm": None}
        )
        self.assertIn("stays under the anomaly line", lead)


if __name__ == "__main__":
    unittest.main()
