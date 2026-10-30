"""Chat front door: rules, the mocked fast-lane path, and POST /runs replies."""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from floodsense_agents import __main__ as service  # noqa: E402
from floodsense_agents import front_door as fd  # noqa: E402
from floodsense_agents.models import RunContext, RunRequest  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402


class _Raising:
    def complete(self, lane, system, user, *, json=True):
        raise RuntimeError("gateway 502")


class _Slow:
    def complete(self, lane, system, user, *, json=True):
        time.sleep(1.0)
        return '{"intent": "greeting"}', "slow"


class RulesTest(unittest.TestCase):
    def test_small_talk(self) -> None:
        for q, want in [
            ("hello", "greeting"),
            ("Hi there!", "greeting"),
            ("Guten Morgen", "greeting"),
            ("what can you do?", "help"),
            ("How does this work?", "help"),
            ("thanks!", "thanks"),
            ("Thank you so much", "thanks"),
            ("", "help"),
        ]:
            self.assertEqual(fd.rules(q), (want, True), q)

    def test_flood_words_always_run(self) -> None:
        for q in [
            "hello, is Valencia at risk?",
            "thanks, and what are the river levels on the Ahr?",
            "What happened in 2021?",
            "tell me a joke about floods",
        ]:
            self.assertEqual(fd.rules(q), ("flood_question", True), q)

    def test_unsure_is_not_decisive_and_defaults_to_run(self) -> None:
        self.assertEqual(fd.rules("what about tomorrow in Paterna"), ("flood_question", False))
        self.assertEqual(fd.rules("tell me a joke"), ("off_topic", False))


class FollowUpTest(unittest.TestCase):
    def test_flood_words_in_more_languages(self) -> None:
        greet = FakeNightshift({"front_door": lambda s, u: '{"intent": "greeting"}'})
        for q in [
            "can you help, my basement is wet",
            "¿Hay riesgo en Paiporta?",
            "hello, is Bonn ok?",
            "Überschwemmungen",
            "Pegel am Rhein?",
            "crecida del río",
        ]:
            self.assertEqual(fd.classify(q, greet)[0], "flood_question", q)
        self.assertEqual(greet.calls, [])  # none of these reached the model

    def test_model_label_only_for_short_placeless_messages(self) -> None:
        greet = FakeNightshift({"front_door": lambda s, u: '{"intent": "off_topic"}'})
        long = "who won the match between those two teams yesterday evening"
        self.assertEqual(fd.classify(long, greet), ("flood_question", "rules"))
        self.assertEqual(fd.classify("what about Paterna", greet), ("flood_question", "rules"))
        self.assertEqual(greet.calls, [])

    def test_timeout_follows_the_api_lookup_timeout(self) -> None:
        with mock.patch.dict("os.environ", {"CACHE_LOOKUP_TIMEOUT_S": ""}, clear=False):
            import os

            os.environ.pop("FRONT_DOOR_TIMEOUT_S", None)
            self.assertEqual(fd._timeout_s(), 2.5)
        with mock.patch.dict("os.environ", {"CACHE_LOOKUP_TIMEOUT_S": "5"}):
            self.assertEqual(fd._timeout_s(), 4.5)


class ModelPathTest(unittest.TestCase):
    def test_model_decides_an_ambiguous_message(self) -> None:
        llm = FakeNightshift({"front_door": lambda s, u: '{"intent": "off_topic"}'})
        self.assertEqual(
            fd.classify("who won the match yesterday", llm), ("off_topic", "fake-fast")
        )
        self.assertEqual(llm.calls[0][:2], ("fast", "front_door"))

    def test_model_not_asked_when_rules_decide(self) -> None:
        llm = FakeNightshift({"front_door": lambda s, u: '{"intent": "off_topic"}'})
        self.assertEqual(fd.classify("Is Valencia flooding?", llm), ("flood_question", "rules"))
        self.assertEqual(fd.classify("hello", llm), ("greeting", "rules"))
        self.assertEqual(llm.calls, [])

    def test_failure_bad_label_and_timeout_fall_back_to_rules(self) -> None:
        self.assertEqual(fd.classify("tell me a joke", _Raising()), ("off_topic", "rules"))
        bad = FakeNightshift({"front_door": lambda s, u: '{"intent": "weather_fact"}'})
        self.assertEqual(fd.classify("what about tomorrow", bad), ("flood_question", "rules"))
        with mock.patch.dict("os.environ", {"FRONT_DOOR_TIMEOUT_S": "0.05"}):
            self.assertEqual(
                fd.classify("what about tomorrow", _Slow()), ("flood_question", "rules")
            )


class ReplyTest(unittest.TestCase):
    def test_role_aware_replies(self) -> None:
        cit = fd.front_door(RunRequest(question="hello"), None)
        self.assertEqual(cit["kind"], "reply")
        self.assertIn("river levels", cit["answer"])
        self.assertIn("Valencia 2024", cit["answer"])
        self.assertTrue(2 <= len(cit["suggestions"]) <= 3)
        ins = fd.front_door(
            RunRequest(question="what can you do?", context=RunContext(role="insurer")), None
        )
        self.assertEqual(ins["intent"], "help")
        self.assertIn("approves", ins["answer"])
        self.assertIn("evidence", ins["answer"])

    def test_operator_reply(self) -> None:
        op = fd.front_door(
            RunRequest(question="what can you do?", context=RunContext(role="operator")), None
        )
        self.assertEqual(op["intent"], "help")
        self.assertIn("45 watched places", op["answer"])
        self.assertIn("script for callers", op["answer"])
        self.assertNotIn("insured", op["answer"])
        self.assertEqual(
            op["suggestions"],
            [
                "Which gauges on the Elbe are above normal?",
                "Brief me on the Rhine at Köln",
                "What does the 48 h outlook show along the Danube?",
            ],
        )
        # Every operator suggestion is a flood question, so a click goes to a run, never a reply.
        for q in op["suggestions"]:
            self.assertEqual(fd.rules(q), ("flood_question", True), q)
        # The other roles keep their own text.
        self.assertNotEqual(op["answer"], fd.reply_text("help", "citizen")[0])
        self.assertNotEqual(op["answer"], fd.reply_text("help", "insurer")[0])

    def test_explicit_requests_always_run(self) -> None:
        self.assertIsNone(fd.front_door(RunRequest(question="hello", event_id="EMSR773"), None))
        self.assertIsNone(fd.front_door(RunRequest(question="hello", doc_query="EFAS"), None))
        # The UI mirrors the question into doc_query; that mirror is not explicit.
        self.assertIsNotNone(fd.front_door(RunRequest(question="hello", doc_query="hello"), None))

    def test_flag_off(self) -> None:
        with mock.patch.dict("os.environ", {"FF_FRONT_DOOR": "false"}):
            self.assertIsNone(fd.front_door(RunRequest(question="hello"), None))


class ServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = mock.Mock()
        self.rt.deps = mock.Mock(llm=FakeNightshift())
        self.rt.start.return_value = {"run_id": "r1", "status": "awaiting_approval"}
        self.rt.start_async.return_value = {"run_id": "r1", "status": "running"}
        prev = service._rt
        service.set_runtime(self.rt)
        self.addCleanup(service.set_runtime, prev)
        self.c = TestClient(service.app)

    def test_reply_on_sync_and_async(self) -> None:
        for url in ("/runs", "/runs?wait=false"):
            r = self.c.post(url, json={"question": "hello"})
            self.assertEqual(r.status_code, 200, url)
            body = r.json()
            self.assertEqual(body["kind"], "reply")
            self.assertNotIn("run_id", body)
            self.assertEqual(
                set(body),
                {"kind", "lane", "intent", "answer", "suggestions", "model_id", "latency_ms"},
            )
            self.assertEqual(body["lane"], "reply")
        self.rt.start.assert_not_called()
        self.rt.start_async.assert_not_called()

    def test_front_door_false_and_flood_questions_run(self) -> None:
        r = self.c.post("/runs?front_door=false", json={"question": "hello"})
        self.assertEqual(r.status_code, 201)
        r = self.c.post("/runs", json={"question": "Is Valencia at risk?"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(self.rt.start.call_count, 2)

    def test_front_door_endpoint(self) -> None:
        self.assertEqual(
            self.c.post("/front-door", json={"question": "thanks"}).json()["intent"], "thanks"
        )
        self.assertEqual(
            self.c.post("/front-door", json={"question": "Ahr levels?"}).json(), {"kind": "run"}
        )


if __name__ == "__main__":
    unittest.main()
