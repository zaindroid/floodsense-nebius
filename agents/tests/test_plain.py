"""The plain (calm) answer of the quick and forecast lanes: fixed rules, no model.

Pure rules on hand-built checks, then the lanes end to end on the fake Zetaris:
the calm-only-when-all-normal rule, honesty about missing data, 48h vs 7d in
EN/DE/ES, sentence-boundary cuts, memory_used matching the claims, and numbers
only from cited claims.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from floodsense_agents import plain  # noqa: E402
from floodsense_agents.models import RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.plain import Check, Signal, build_plain  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from test_forecast_lane import BUDAPEST, KOELN, FakeMemory, _zetaris  # noqa: E402


def _claims(*texts: str) -> list[dict]:
    return [{"claim_id": f"C{i}", "text": t} for i, t in enumerate(texts, start=1)]


def _river_check(status: str = plain.NORMAL, rain: str | None = plain.NORMAL, **kw) -> Check:
    c = Check(
        name="Budapest",
        river="Danube",
        country="HU",
        kind="model",
        needs=("river",),
        covers_week=True,
        **kw,
    )
    c.signals.append(Signal("river", status))
    if rain is not None:
        c.signals.append(Signal("rain", rain))
    return c


def _gauge(status: str, above: bool = False, **kw) -> Check:
    c = Check(name="Köln", river="Rhine", country="DE", kind="gauge", needs=("level",), **kw)
    c.signals.append(Signal("level", status, above_mhw=above, level_text="412"))
    return c


CLAIMS = _claims("Budapest (Danube, HU): model discharge 2210 m3/s", "Köln gauge: level 412 cm")


class HorizonTest(unittest.TestCase):
    def test_week_questions_are_7d_in_en_de_es(self) -> None:
        for q in (
            "Will the Danube at Budapest rise this week?",
            "What about the next days at Köln?",
            "Is the rest of the week safe at Köln?",
            "Wie wird der Rhein in Bonn nächste Woche?",
            "Steigt die Elbe diese Woche?",
            "Wie sieht es in den nächsten Tagen aus?",
            "¿Subirá el Danubio esta semana?",
            "¿Y los próximos días en Valencia?",
            "Will it rise over the next 5 days at Prague?",
        ):
            self.assertEqual(plain.horizon_of(q), "7d", q)

    def test_short_questions_stay_48h(self) -> None:
        for q in (
            "Do the next 48 hours look safe at Köln?",
            "Is Köln safe tomorrow?",
            "¿Lloverá en Valencia mañana?",
            "Steigt die Elbe in Dresden in den nächsten 48 Stunden?",
            "How high is the Rhine at Köln right now?",
            "Rain over the weekend at Bonn?",
        ):
            self.assertEqual(plain.horizon_of(q), "48h", q)


class SentenceCutTest(unittest.TestCase):
    LONG = (
        "Danube at Budapest, 21 September 2024: the river reached its highest level in around a "
        "decade, with water at the steps of the Parliament building. The crest passed two days "
        "later and the city kept the lower quays closed until the water fell back to its usual "
        "range, which took more than a week in several districts along the river."
    )

    def test_cut_ends_on_a_sentence(self) -> None:
        out = plain.sentence_cut(self.LONG, 200)
        self.assertTrue(out.endswith("Parliament building."), out)
        self.assertLessEqual(len(out), 200)

    def test_never_cuts_mid_word(self) -> None:
        text = "A long unbroken statement without any full stop " * 12
        out = plain.sentence_cut(text, 100)
        self.assertTrue(out.endswith("…"))
        body = out[:-1]
        self.assertTrue(text.startswith(body))
        self.assertIn(text[len(body)], " ")  # the next character is a space: a whole word was kept

    def test_doc_marker_is_removed_even_when_cut_off(self) -> None:
        whole = "Elbe at Dresden reached 9.4 m in August 2002. [doc wiki-2002-european-floods, section 3, paragraph 8, https://x.example/y]"
        self.assertEqual(plain.sentence_cut(whole), "Elbe at Dresden reached 9.4 m in August 2002.")
        cut = "Elbe at Dresden reached 9.4 m in August 2002. [doc wiki-2002-european-floods, section 2, pa"
        self.assertEqual(plain.sentence_cut(cut), "Elbe at Dresden reached 9.4 m in August 2002.")

    def test_abbreviation_and_decimal_are_not_sentence_ends(self) -> None:
        text = "St. Mary Magdalene's flood reached 9.4 m at the old town gauge. " + "More detail follows here. " * 12
        out = plain.sentence_cut(text, 80)
        self.assertTrue(out.endswith("gauge."), out)

    def test_short_text_is_whole(self) -> None:
        self.assertEqual(plain.sentence_cut("Paiporta flooded in 2024."), "Paiporta flooded in 2024.")


class RulesTest(unittest.TestCase):
    def test_calm_only_when_every_status_is_normal_and_data_is_complete(self) -> None:
        out = build_plain([_river_check()], asked="7d", claims=CLAIMS)
        self.assertEqual(out["headline"], "Nothing alarming expected at Budapest.")
        self.assertEqual((out["status"], out["horizon"]), ("normal", "7d"))
        self.assertIn("this week", out["one_line"])
        self.assertIn("within its normal range", out["one_line"])
        for s in (plain.WATCH, plain.ELEVATED):
            self.assertNotIn("Nothing alarming", build_plain([_river_check(s)], asked="7d", claims=CLAIMS)["headline"])
            self.assertNotIn("Nothing alarming", build_plain([_river_check(rain=s)], asked="7d", claims=CLAIMS)["headline"])
        for sig in (plain.WATCH, plain.ELEVATED):
            mixed = build_plain([_river_check(), _gauge(sig)], asked="48h", claims=CLAIMS)
            self.assertNotIn("Nothing alarming", mixed["headline"])

    def test_watch_names_the_one_reason(self) -> None:
        out = build_plain([_river_check(plain.WATCH)], asked="48h", claims=CLAIMS)
        self.assertEqual(
            out["headline"], "Keep an eye on Budapest: the river is forecast to run higher than usual."
        )
        self.assertEqual(out["status"], "watch")
        rain = build_plain([_river_check(rain=plain.ELEVATED)], asked="48h", claims=CLAIMS)
        self.assertEqual(rain["headline"], "Keep an eye on Budapest: very heavy rain is forecast.")

    def test_model_band_is_never_phrased_as_water_is_high(self) -> None:
        out = build_plain([_river_check(plain.ELEVATED)], asked="48h", claims=CLAIMS)
        self.assertTrue(out["headline"].startswith("Keep an eye on"))
        self.assertIn("model estimate", out["one_line"])

    def test_above_mean_high_water_on_a_gauge(self) -> None:
        out = build_plain([_gauge(plain.ELEVATED, above=True)], asked="48h", claims=CLAIMS)
        self.assertEqual(out["headline"], "Water is high at Köln. Follow official warnings.")
        self.assertEqual((out["status"], out["basis"]), ("elevated", "gauge"))

    def test_close_to_mean_high_water_is_keep_an_eye(self) -> None:
        out = build_plain([_gauge(plain.WATCH)], asked="48h", claims=CLAIMS)
        self.assertEqual(
            out["headline"], "Keep an eye on Köln: the water level is close to its usual high-water mark."
        )

    def test_missing_data_is_never_reassuring(self) -> None:
        no_rain = Check("Köln", "Rhine", "DE", "gauge", needs=("rain", "level"))
        no_rain.signals.append(Signal("level", plain.NORMAL))
        out = build_plain([no_rain], asked="48h", claims=CLAIMS)
        self.assertEqual(out["headline"], "We can't fully check Köln right now.")
        self.assertEqual(out["status"], "unknown")
        self.assertIn("could not read all the data", out["one_line"])
        empty = Check("Köln", "Rhine", "DE", "gauge", needs=("level",))
        self.assertEqual(
            build_plain([empty], asked="48h", claims=CLAIMS)["headline"],
            "We can't fully check Köln right now.",
        )
        self.assertEqual(
            build_plain([], asked="48h", claims=CLAIMS)["headline"],
            "We can't fully check this place right now.",
        )

    def test_one_missing_place_blocks_the_calm_for_all(self) -> None:
        gap = Check("Bonn", "Rhine", "DE", "gauge", needs=("level",))
        out = build_plain([_gauge(plain.NORMAL), gap], asked="48h", claims=CLAIMS)
        self.assertEqual(out["headline"], "We can't fully check Köln and Bonn right now.")

    def test_stale_or_unknown_data_is_not_calm(self) -> None:
        stale = Check("Köln", "Rhine", "DE", "gauge", needs=("level",), stale=True)
        out = build_plain([stale], asked="48h", claims=CLAIMS)
        self.assertEqual(out["headline"], "We can't fully check Köln right now.")
        self.assertIn("out of date", out["one_line"])
        unknown = _river_check(plain.UNKNOWN)
        self.assertEqual(
            build_plain([unknown], asked="48h", claims=CLAIMS)["headline"],
            "We can't fully check Budapest right now.",
        )

    def test_unreadable_timestamp_counts_as_stale(self) -> None:
        from floodsense_agents.nodes import forecast, quick

        for ts in (None, "", "garbage"):
            row = {"station": "KÖLN", "water": "RHEIN", "level_cm": 144.0, "ts_utc": ts, "mhw_cm": 725.0}
            c = quick._gauge_check("KÖLN", row)
            self.assertTrue(c.stale, ts)
            self.assertEqual(c.signals, [])
            fc = Check("Köln", "Rhine", "DE", "gauge", needs=("level",))
            forecast._level_signal(fc, row, "Normal")
            self.assertTrue(fc.stale, ts)
            self.assertEqual(fc.signals, [])
            out = build_plain([c], asked="48h", claims=CLAIMS)
            self.assertEqual(out["headline"], "We can't fully check Köln right now.")

    def test_a_worrying_status_still_wins_over_a_gap(self) -> None:
        gap = Check("Bonn", "Rhine", "DE", "gauge", needs=("level",))
        out = build_plain([_gauge(plain.ELEVATED, above=True), gap], asked="48h", claims=CLAIMS)
        self.assertTrue(out["headline"].startswith("Water is high at Köln"))

    def test_trend_and_rain_read_as_one_sentence(self) -> None:
        c = _gauge(plain.NORMAL)
        c.signals[0].trend = "falling"
        c.signals.append(Signal("rain", plain.NORMAL))
        out = build_plain([c], asked="48h", claims=CLAIMS)
        self.assertEqual(
            out["one_line"],
            "The Rhine at Köln is at 412 cm, below its usual high-water mark and falling, and no "
            "significant rain is forecast over the next two days.",
        )

    def test_gauge_reading_alone_is_present_tense_not_forward(self) -> None:
        out = build_plain([_gauge(plain.NORMAL)], asked="48h", claims=CLAIMS)
        self.assertEqual(out["headline"], "Köln is at a normal level right now.")
        self.assertIn("This is today's reading, not a forecast.", out["one_line"])
        self.assertEqual(out["status"], "normal")
        # with a rain signal checked, the forward-looking headline is allowed
        c = _gauge(plain.NORMAL)
        c.signals.append(Signal("rain", plain.NORMAL))
        self.assertEqual(
            build_plain([c], asked="48h", claims=CLAIMS)["headline"], "Nothing alarming expected at Köln."
        )

    def test_mixed_pair_does_not_reassure_for_the_gauge_only_place(self) -> None:
        out = build_plain([_gauge(plain.NORMAL), _river_check()], asked="48h", claims=CLAIMS)
        self.assertEqual(
            out["headline"],
            "Köln is at a normal level right now (today's reading). Nothing alarming expected at Budapest.",
        )
        self.assertNotIn("Nothing alarming expected at Köln", out["headline"])
        self.assertIn("For Köln this is today's reading, not a forecast.", out["one_line"])
        self.assertEqual(out["status"], "normal")

    def test_rain_never_says_this_week(self) -> None:
        c = Check("Köln", "Rhine", "DE", "gauge", needs=("rain",), covers_week=True)
        c.signals.append(Signal("rain", plain.NORMAL))
        out = build_plain([c], asked="7d", claims=CLAIMS)
        self.assertIn("over the next two days", out["one_line"])
        self.assertNotIn("this week", out["one_line"])
        eu = build_plain([_river_check()], asked="7d", claims=CLAIMS)["one_line"]
        self.assertIn("within its normal range this week", eu)
        self.assertIn("rain is forecast over the next two days", eu)

    def test_high_gauge_still_names_a_model_elevated_place(self) -> None:
        out = build_plain(
            [_gauge(plain.ELEVATED, above=True), _river_check(plain.ELEVATED)], asked="48h", claims=CLAIMS
        )
        self.assertEqual(
            out["headline"],
            "Water is high at Köln. Follow official warnings. Keep an eye on Budapest: "
            "the river is forecast to run much higher than usual.",
        )
        self.assertEqual(out["countries"], ["DE", "HU"])

    def test_week_question_without_week_data_says_so(self) -> None:
        out = build_plain([_gauge(plain.NORMAL)], asked="7d", claims=CLAIMS)
        self.assertEqual(out["horizon"], "48h")
        self.assertEqual(out["headline"], "We can't fully check Köln right now.")
        self.assertIn("not a full week", out["one_line"].replace("a forecast for the week", "a full week"))

    def test_week_covered_by_the_river_forecast_is_7d(self) -> None:
        self.assertEqual(build_plain([_river_check()], asked="7d", claims=CLAIMS)["horizon"], "7d")
        self.assertEqual(build_plain([_river_check()], asked="48h", claims=CLAIMS)["horizon"], "48h")

    def test_disclaimer_service_and_next_step(self) -> None:
        out = build_plain([_river_check()], asked="48h", claims=CLAIMS)
        self.assertEqual(out["next_step"], "Ask me about another place or open the official warnings.")
        self.assertEqual(
            out["disclaimer"],
            "Model-based check, not an official warning. Follow HungaroMet and the water directorate (OVF, vizugy.hu).",
        )
        self.assertEqual(out["country"], "HU")
        self.assertEqual(out["details"], ["C1", "C2"])
        none = build_plain([Check("X", None, None, "model")], asked="48h", claims=CLAIMS)
        self.assertIn("your national weather and flood service", none["disclaimer"])


class NumbersTest(unittest.TestCase):
    def test_level_appears_only_when_a_claim_states_it(self) -> None:
        with_claim = build_plain([_gauge(plain.NORMAL)], asked="48h", claims=CLAIMS)
        self.assertIn("412 cm", with_claim["one_line"])
        self.assertEqual(plain.numbers_outside_claims(with_claim, CLAIMS), [])
        without = build_plain([_gauge(plain.NORMAL)], asked="48h", claims=_claims("Köln gauge: level 399 cm"))
        self.assertNotIn("412", without["one_line"])
        self.assertEqual(plain.numbers_outside_claims(without, _claims("Köln gauge: level 399 cm")), [])

    def test_no_digits_in_the_calm_sentences(self) -> None:
        out = build_plain([_river_check()], asked="7d", claims=CLAIMS)
        self.assertNotRegex(out["headline"] + out["one_line"], r"\d")
        out = build_plain([_river_check(rain=plain.WATCH)], asked="48h", claims=CLAIMS)
        self.assertNotRegex(out["headline"] + out["one_line"], r"\d")


class ContextTest(unittest.TestCase):
    MEM = {
        "content": (
            "Danube at Budapest, 21 September 2024: the river reached its highest level in around a "
            "decade, with water at the steps of the Parliament building. "
            "[doc wiki-2024-central-european-floods, section 2, paragraph 21, https://example.org/x]"
        )
    }

    def test_history_is_framed_as_history_with_source_and_seed_label(self) -> None:
        text = plain.memory_context(self.MEM, seeded=True)
        self.assertTrue(text.startswith("For context, from the past: Danube at Budapest, 21 September 2024"))
        self.assertIn("Parliament building.", text)
        self.assertIn("demo seed", text)
        self.assertIn("Wikipedia: 2024 Central European Floods", text)
        self.assertIn("not today's conditions", text)
        self.assertNotIn("[doc", text)
        self.assertNotIn("demo seed", plain.memory_context(self.MEM, seeded=False))

    def test_memory_without_a_doc_marker_names_the_earlier_run(self) -> None:
        text = plain.memory_context({"content": "KÖLN stayed below mean high water."}, seeded=False)
        self.assertIn("an earlier approved run", text)

    def test_passage_context_cuts_the_quote_at_a_sentence(self) -> None:
        quote = "On 14 July 2021 heavy rain led to an extreme flood on the Ahr. " + "Further detail about the flood. " * 20
        text = plain.passage_context({"quote": quote, "title": "July 2021 flood, Part 1"})
        self.assertIn("extreme flood on the Ahr.", text)
        self.assertIn("July 2021 flood, Part 1", text)
        self.assertNotRegex(text, r"\w…")


@mock.patch.object(settings, "live_data", True)
class LaneTest(unittest.TestCase):
    def _run(self, question, z=None, memory=None):
        deps = Deps(zetaris=z or _zetaris(), llm=FakeNightshift(), memory=memory or NoMemory())
        return Runtime(deps=deps).start(RunRequest(question=question))

    def _mhw(self, z, mhw: float) -> None:
        with z._lock:
            z._conn.execute("ALTER TABLE floodsense.gauge_levels ADD COLUMN mhw_cm REAL")
            z._conn.execute("UPDATE floodsense.gauge_levels SET mhw_cm = ?", (mhw,))
            z._conn.commit()

    def test_budapest_this_week_is_7d_and_calm(self) -> None:
        snap = self._run(BUDAPEST)
        p = snap["plain"]
        self.assertEqual(snap["lane"], "forecast")
        self.assertEqual(p["horizon"], "7d")
        self.assertEqual(p["headline"], "Nothing alarming expected at Budapest.")
        self.assertIn("this week", p["one_line"])
        self.assertEqual(plain.numbers_outside_claims(p, snap["claims"]), [])
        self.assertEqual(p["details"], [c["claim_id"] for c in snap["claims"]])
        self.assertIn("HungaroMet", p["disclaimer"])
        # the analyst answer is untouched
        self.assertIn("forecast maximum 2600 m3/s", snap["summary"])
        self.assertTrue(snap["summary"].startswith(snap["forecast"]["lead"]))

    def test_budapest_missing_river_row_is_not_calm(self) -> None:
        z = _zetaris()
        with z._lock:
            z._conn.execute(
                "UPDATE floodsense.eu_watch SET discharge_m3s=NULL, forecast_max_m3s=NULL WHERE point_id='EU08'"
            )
            z._conn.commit()
        snap = self._run(BUDAPEST, z=z)
        if snap["lane"] == "forecast":
            self.assertNotIn("Nothing alarming", snap["plain"]["headline"])

    def test_week_question_at_a_gauge_says_the_week_is_not_covered(self) -> None:
        snap = self._run("What about Köln over the next days?")
        self.assertEqual(snap["lane"], "forecast", snap["router_reason"])
        p = snap["plain"]
        self.assertEqual(p["horizon"], "48h")
        self.assertEqual(p["headline"], "We can't fully check Köln right now.")
        self.assertIn("two-day outlook", p["one_line"])

    def test_koeln_without_a_high_water_mark_is_not_calm(self) -> None:
        p = self._run(KOELN)["plain"]
        self.assertEqual(p["headline"], "We can't fully check Köln right now.")

    def test_koeln_below_mhw_is_calm_and_above_is_high(self) -> None:
        z = _zetaris(412.0)
        self._mhw(z, 900.0)
        calm = self._run(KOELN, z=z)["plain"]
        self.assertEqual(calm["headline"], "Nothing alarming expected at Köln.")
        self.assertEqual(calm["horizon"], "48h")
        z = _zetaris(412.0)
        self._mhw(z, 400.0)
        high = self._run(KOELN, z=z)["plain"]
        self.assertEqual(high["headline"], "Water is high at Köln. Follow official warnings.")
        self.assertEqual(high["status"], "elevated")

    def test_chiva_heavy_rain_is_keep_an_eye(self) -> None:
        p = self._run("Will Chiva flood in the next 48 hours?")["plain"]
        self.assertTrue(p["headline"].startswith("Keep an eye on Chiva:"), p["headline"])
        self.assertIn("AEMET", p["disclaimer"])
        self.assertEqual(p["country"], "ES")

    def test_quick_lane_levels_and_numbers(self) -> None:
        z = _zetaris(412.0)
        self._mhw(z, 900.0)
        snap = self._run("How high is the Rhine at Köln right now?", z=z)
        self.assertEqual(snap["lane"], "quick")
        p = snap["plain"]
        self.assertEqual(p["headline"], "Köln is at a normal level right now.")
        self.assertIn("412 cm", p["one_line"])
        self.assertTrue(p["one_line"].endswith("This is today's reading, not a forecast."))
        self.assertEqual(plain.numbers_outside_claims(p, snap["claims"]), [])
        z = _zetaris(412.0)
        self._mhw(z, 400.0)
        self.assertEqual(
            self._run("How high is the Rhine at Köln right now?", z=z)["plain"]["headline"],
            "Water is high at Köln. Follow official warnings.",
        )

    def test_quick_gauge_at_399_rising_is_never_calm(self) -> None:
        from datetime import datetime, timedelta, timezone

        def rows(mhw: float, level: float):
            z = _zetaris(level)
            earlier = (datetime.now(timezone.utc) - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
            with z._lock:
                z._conn.execute(
                    "INSERT INTO floodsense.gauge_levels VALUES (?,?,?,?,?)",
                    ("KÖLN", "RHEIN", earlier, 380.0, "pegelonline"),
                )
                z._conn.commit()
            self._mhw(z, mhw)
            return z

        q = "How high is the Rhine at Köln right now?"
        near = self._run(q, z=rows(400.0, 399.0))["plain"]
        self.assertEqual(near["status"], "watch")
        self.assertEqual(
            near["headline"],
            "Keep an eye on Köln: the water level is close to its usual high-water mark.",
        )
        self.assertIn("399 cm", near["one_line"])
        self.assertIn("rising", near["one_line"])
        self.assertNotIn("normal level", near["headline"])
        far = self._run(q, z=rows(900.0, 399.0))["plain"]
        self.assertEqual(far["headline"], "Köln is at a normal level right now.")
        self.assertIn("below its usual high-water mark and rising", far["one_line"])
        self.assertNotIn("Nothing alarming", far["headline"] + far["one_line"])

    def test_quick_lane_eu_model_band_is_a_model_estimate(self) -> None:
        z = _zetaris()
        with z._lock:
            z._conn.execute(
                "UPDATE floodsense.eu_watch SET forecast_max_m3s=5000, past30_median_m3s=2000, band='above' "
                "WHERE point_id='EU08'"
            )
            z._conn.commit()
        snap = self._run("Is the Danube at Budapest rising?", z=z)
        self.assertEqual(snap["lane"], "quick", snap["router_reason"])
        p = snap["plain"]
        self.assertTrue(p["headline"].startswith("Keep an eye on Budapest:"), p["headline"])
        self.assertEqual(p["basis"], "model")

    def test_memory_used_lists_the_memory_the_claims_cite(self) -> None:
        snap = self._run(KOELN, memory=FakeMemory())
        cited = [c for c in snap["claims"] if c["text"].startswith("Approved memory")]
        self.assertEqual(len(cited), 1)
        self.assertEqual([m["memory_id"] for m in snap["memory_used"]], ["m1"])
        self.assertTrue(snap["memory_used"][0]["seeded"])
        self.assertIn("demo seed", cited[0]["text"])
        # a bare earlier reading is the last choice for the context card: the Ahr pattern outranks it
        ctx = snap["plain"]["context"]
        self.assertTrue(ctx.startswith("For context, from the past: before the July 2021 Ahr flood"))
        self.assertIn("not today's conditions", ctx)

    def test_a_memory_that_quotes_a_document_is_the_context(self) -> None:
        class DocMemory(FakeMemory):
            def recall(self, request):
                return [
                    {
                        "memory_id": "m7",
                        "run_id": "demo-seed-7",
                        "content": (
                            "Rhine near Bonn, 4 June 2016: tributaries of the Rhine flooded around Bonn "
                            "during the late-May and early-June heavy rain. KÖLN is downstream. "
                            "[doc wiki-2016-european-floods, section 2, paragraph 5, https://example.org/x]"
                        ),
                        "provenance": {"label": "run demo-seed-7 approved by demo-seed", "learned_at": "2026-10-26"},
                        "tags": ["entity:demo-seed"],
                    }
                ]

        snap = self._run(KOELN, memory=DocMemory())
        ctx = snap["plain"]["context"]
        self.assertIn("Rhine near Bonn, 4 June 2016", ctx)
        self.assertIn("Wikipedia: 2016 European Floods", ctx)
        self.assertIn("demo seed", ctx)
        self.assertNotIn("[doc", ctx)
        self.assertEqual([m["memory_id"] for m in snap["memory_used"]], ["m7"])

    def test_memory_used_is_empty_when_no_claim_cites_one(self) -> None:
        snap = self._run(KOELN, memory=NoMemory())
        self.assertFalse([c for c in snap["claims"] if c["text"].startswith("Approved memory")])
        self.assertEqual(snap["memory_used"], [])
        self.assertTrue(snap["plain"]["context"] is None or "Altenahr" in snap["plain"]["context"])

    def test_old_memory_text_is_cut_at_a_sentence(self) -> None:
        long = "Elbe at Dresden reached 9.4 m in August 2002. " + "Further background on that flood. " * 12
        mem = mock.Mock()
        mem.recall.return_value = [
            {
                "memory_id": "m9",
                "run_id": "r9",
                "content": "KÖLN " + long,
                "provenance": {"label": "run r9 approved by ana"},
            }
        ]
        snap = self._run(KOELN, memory=mem)
        text = snap["memory_used"][0]["text"]
        self.assertTrue(text.endswith("."), text)
        self.assertLessEqual(len(text), 200)

    def test_the_full_lane_has_no_plain_object(self) -> None:
        snap = self._run("Why did the Ahr flood in July 2021?")
        self.assertEqual(snap["lane"], "full")
        self.assertFalse(snap.get("plain"))

    def test_every_calm_headline_is_backed_by_all_normal_statuses(self) -> None:
        # Property over the lanes' own outputs: "Nothing alarming" never comes with a non-normal status.
        z = _zetaris(412.0)
        self._mhw(z, 900.0)
        for q in (KOELN, BUDAPEST, "How high is the Rhine at Köln right now?"):
            p = self._run(q, z=z)["plain"]
            if p["headline"].startswith("Nothing alarming"):
                self.assertEqual(p["status"], "normal", q)
                self.assertNotRegex(p["one_line"], r"higher than usual|heavy rain|close to|above its")
        self.assertTrue(re.match(r"^[A-Z]", p["headline"]))


if __name__ == "__main__":
    unittest.main()
