"""Investigator and Playbook calls sized for the Nightshift gateway (~45 s). No network."""

from __future__ import annotations

import json
import re
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch as _patch


def mock_patch(obj, name, value):
    return _patch.object(obj, name, value)


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from floodsense_agents.models import Evidence  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes.investigator import make as make_investigator  # noqa: E402
from floodsense_agents.nodes.playbook import _prompt as playbook_prompt  # noqa: E402
from floodsense_agents.nodes.playbook import make as make_playbook  # noqa: E402
from floodsense_agents.prompts import compact_rows  # noqa: E402
from floodsense_agents.state import run_model_ids  # noqa: E402
from tests.test_lanes import _deps, _state  # noqa: E402


def _link(user: str) -> str:
    return re.search(r"LINK: (\S+) (\S+)", user).group(2)


def _first_qid(user: str) -> str:
    return re.search(r"query_id=(\S+)", user).group(1)


def per_link(fail: tuple[str, ...] = (), delay: dict[str, float] | None = None):
    """A model that words each link 'MODEL <link>'; links in `fail` raise (a 502)."""

    def handler(system: str, user: str) -> str:
        link = _link(user)
        time.sleep((delay or {}).get(link, 0))
        if link in fail:
            raise RuntimeError("502 Bad Gateway")
        return json.dumps(
            {
                "statement": f"MODEL {link}",
                "claims": [
                    {"text": f"MODEL {link} a", "kind": "fact", "query_ids": [_first_qid(user)]},
                    {"text": f"MODEL {link} b", "kind": "fact", "query_ids": ["not-this-link"]},
                ],
            }
        )

    return handler


class InvestigatorSplitTest(unittest.TestCase):
    def test_one_small_call_per_link_merged_in_link_order(self) -> None:
        # The first link answers last; the merge still follows the chain.
        llm = FakeNightshift({"investigator": per_link(delay={"rain->catchment": 0.2})})
        out = make_investigator(_deps(llm))(_state())
        calls = [u for _lane, task, u in llm.calls if task == "investigator"]
        self.assertEqual(
            sorted(_link(u) for u in calls), ["catchment->river", "rain->catchment", "river->site"]
        )
        for u in calls:
            self.assertLess(len(u), 4000, "a per-link prompt stays small")
        links = [h["link"] for h in out["hypotheses"]]
        self.assertEqual(links, ["rain->catchment", "catchment->river", "river->site"])
        self.assertEqual([h["statement"] for h in out["hypotheses"]], [f"MODEL {x}" for x in links])
        ids = [c["claim_id"] for c in out["claims"]]
        self.assertEqual(ids, [f"C{i}" for i in range(1, len(ids) + 1)])
        # "b" cites only an unknown id: dropped, with a trace note.
        self.assertEqual([c["text"] for c in out["claims"]], [f"MODEL {x} a" for x in links])
        self.assertIn("(unknown query ids)", out["trace"][-1]["summary"])
        by_id = {c["claim_id"]: c for c in out["claims"]}
        for h in out["hypotheses"]:
            self.assertTrue(all(by_id[i]["hypothesis_id"] == h["id"] for i in h["citations"]))
        self.assertEqual(out["trace"][-1]["model_id"], "fake-fast")
        self.assertIn("3/3 links", out["trace"][-1]["summary"])

    def test_a_failed_link_keeps_its_deterministic_claims(self) -> None:
        det = make_investigator(_deps(FakeNightshift()))(_state())
        llm = FakeNightshift({"investigator": per_link(fail=("catchment->river",))})
        out = make_investigator(_deps(llm))(_state())
        h2_det = next(h for h in det["hypotheses"] if h["link"] == "catchment->river")
        h2 = next(h for h in out["hypotheses"] if h["link"] == "catchment->river")
        self.assertEqual(h2["statement"], h2_det["statement"])
        det_text = {c["claim_id"]: c["text"] for c in det["claims"]}
        got = {c["claim_id"]: c for c in out["claims"]}
        self.assertEqual(
            [got[i]["text"] for i in h2["citations"]], [det_text[i] for i in h2_det["citations"]]
        )
        for i in h2["citations"]:  # citations re-issued under the new claim id
            self.assertTrue(all(x["claim_id"] == i for x in got[i]["citations"]))
            self.assertTrue(got[i]["citations"])
        self.assertEqual(out["trace"][-1]["lane"], "fast")
        self.assertIn("2/3 links", out["trace"][-1]["summary"])

    def test_unknown_aliases_only_keep_the_draft(self) -> None:
        det = make_investigator(_deps(FakeNightshift()))(_state())

        def unknown(system, user):
            return json.dumps({"statement": "X", "claims": [{"text": "Y", "query_ids": ["Q99"]}]})

        out = make_investigator(_deps(FakeNightshift({"investigator": unknown})))(_state())
        self.assertEqual([c["text"] for c in out["claims"]], [c["text"] for c in det["claims"]])
        self.assertIn("dropped model claim H1.1 (unknown query ids)", out["trace"][-1]["summary"])

    def test_an_unrelated_query_is_removed_from_a_link_claim(self) -> None:
        def mixed(system, user):
            link = _link(user)
            own = _first_qid(user)
            blocks = re.findall(r"query_id=(\S+) view=(\S+) rows=(\d+)", user)
            other = next(q for q, v, n in blocks if v == "exposure_join")
            ids = [own, other] if link == "rain->catchment" else [own]
            return json.dumps({"statement": "S", "claims": [{"text": "T", "query_ids": ids}]})

        out = make_investigator(_deps(FakeNightshift({"investigator": mixed})))(_state())
        c1 = out["claims"][0]
        views = {x["title"] for x in c1["citations"] if x["layer"] == "a"}
        self.assertNotIn("exposure_join", " ".join(views))
        self.assertTrue(views)
        self.assertIn(
            "removed unrelated citation(s) from model claim H1.1", out["trace"][-1]["summary"]
        )

    def test_every_link_failing_is_the_deterministic_chain(self) -> None:
        det = make_investigator(_deps(FakeNightshift()))(_state())
        fail = ("rain->catchment", "catchment->river", "river->site")
        out = make_investigator(_deps(FakeNightshift({"investigator": per_link(fail)})))(_state())

        def shape(run):  # query ids differ between two fake runs
            return [
                (c["claim_id"], c["text"], [x["citation_id"] for x in c["citations"]])
                for c in run["claims"]
            ]

        self.assertEqual(shape(out), shape(det))
        self.assertEqual(out["trace"][-1]["model_id"], "deterministic")


class CompactRowsTest(unittest.TestCase):
    def test_rows_with_the_claimed_numbers_survive_the_cut(self) -> None:
        rows = [{"ts_utc": f"t{i:02d}", "discharge_m3s": float(i)} for i in range(30)]
        rows[27]["discharge_m3s"] = 21600000.0
        ev = Evidence(
            query_id="q1",
            view="v",
            sql="SELECT 1",
            rows_sample=rows,
            row_count=30,
            executed_at_utc="2026-10-27T00:00:00Z",
        )
        text = compact_rows(ev, numbers=[21600000], max_rows=8)
        self.assertIn("t27 | 21600000", text)
        self.assertNotIn("e+", text)
        self.assertEqual(len(text.splitlines()), 1 + 1 + 8)


class PlaybookFitTest(unittest.TestCase):
    def _state(self) -> dict:
        s = _state()
        s["hypotheses"] = [
            {"id": "H1", "link": "rain->catchment", "statement": "Rain.", "status": "supported"}
        ]
        s["claims"] = [{"claim_id": "C1", "text": "Rain fell."}]
        s["exposure"] = {
            "policies": 400,
            "sum_insured_eur": 1.5e8,
            "assets": [
                {"policy_id": f"P{i}", "site_id": f"S{i}", "sum_insured_eur": float(i)}
                for i in range(400)
            ],
        }
        return s

    def test_prompt_shows_totals_and_the_largest_sites_only(self) -> None:
        text = playbook_prompt(self._state())
        self.assertIn("400 policies", text)
        self.assertIn("P399", text)
        self.assertNotIn("'P10'", text)
        self.assertLess(len(text), 2000)

    def test_at_most_four_actions(self) -> None:
        acts = [
            {"action_id": f"A{i}", "horizon_h": 24, "text": "x", "claim_ids": ["C1"]}
            for i in range(7)
        ]
        llm = FakeNightshift({"playbook": lambda s, u: json.dumps({"actions": acts})})
        out = make_playbook(_deps(llm))(self._state())
        self.assertEqual(len(out["playbook"]), 4)


class _FakeStream:
    def __init__(self, lines, status=200):
        self.lines, self.status_code, self.content, self.headers = lines, status, b"", {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b""

    def iter_lines(self):
        return iter(self.lines)


class StreamPostTest(unittest.TestCase):
    def _post(self, lines):
        from unittest.mock import patch

        from floodsense_agents import nightshift

        with patch.object(nightshift.httpx, "stream", lambda *a, **k: _FakeStream(lines)):
            return nightshift.stream_post(
                "http://x/chat/completions", json={}, headers={}, timeout=1
            )

    def test_chunks_assemble_into_one_reply(self) -> None:
        chunk = 'data: {"model": "nvidia/n", "choices": [{"delta": {"content": "%s"}}]}'
        r = self._post(
            [
                'data: {"choices": [{"delta": {"role": "assistant"}}]}',
                chunk % '{\\"a\\"',
                chunk % ": 1}",
                'data: {"choices": [{"delta": {}, "finish_reason": "stop"}]}',
                'data: {"choices": [], "usage": {"completion_tokens": 9}}',
                "data: [DONE]",
            ]
        )
        js = r.json()
        self.assertEqual(js["choices"][0]["message"]["content"], '{"a": 1}')
        self.assertEqual(js["choices"][0]["finish_reason"], "stop")
        self.assertEqual(js["model"], "nvidia/n")

    def test_a_stream_without_an_answer_is_an_error(self) -> None:
        with self.assertRaises(ValueError) as cm:
            self._post(
                [
                    'data: {"choices": [{"delta": {"role": "assistant"}}]}',
                    'data: {"error": {"code": "provider_error"}}',
                ]
            )
        self.assertIn("provider_error", str(cm.exception))

    def test_an_error_after_content_is_not_a_success(self) -> None:
        with self.assertRaises(ValueError) as cm:
            self._post(
                [
                    'data: {"choices": [{"delta": {"content": "{\\"a\\""}}]}',
                    'data: {"error": {"code": "provider_error", "message": "deadline"}}',
                ]
            )
        self.assertIn("provider_error", str(cm.exception))

    def test_the_whole_stream_has_one_deadline(self) -> None:
        import httpx

        from floodsense_agents import nightshift

        clock = iter([0.0, 0.5, 2.0, 99.0, 99.0])
        lines = ['data: {"choices": [{"delta": {"role": "assistant"}}]}', ": ping", ": ping"]
        with (
            mock_patch(nightshift.httpx, "stream", lambda *a, **k: _FakeStream(lines)),
            mock_patch(nightshift.time, "monotonic", lambda: next(clock)),
        ):
            with self.assertRaises(httpx.TimeoutException):
                nightshift.stream_post("http://x", json={}, headers={}, timeout=10)


class ModelIdsTest(unittest.TestCase):
    def test_every_answering_node_counts_once_in_node_order(self) -> None:
        trace = [
            {"node": "investigator", "model_id": "deterministic"},
            {"node": "skeptic", "model_id": "nvidia/lightning"},
            {"node": "exposure", "model_id": None},
            {"node": "playbook", "model_id": "nvidia/lightning"},
            {"node": "judge", "model_id": "nvidia/super,nvidia/lightning"},
            {"node": "playbook", "model_id": "nvidia/super"},
        ]
        self.assertEqual(
            run_model_ids(trace, ["deterministic", "nvidia/lightning"]),
            ["nvidia/lightning", "nvidia/super"],
        )

    def test_no_model_answer_keeps_the_recorded_list(self) -> None:
        self.assertEqual(
            run_model_ids([{"model_id": "deterministic"}], ["deterministic", "deterministic"]),
            ["deterministic"],
        )
        self.assertEqual(run_model_ids([], []), [])


if __name__ == "__main__":
    unittest.main()
