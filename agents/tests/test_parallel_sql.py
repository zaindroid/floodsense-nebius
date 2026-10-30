"""Independent Zetaris queries fan out and come back in call order.

The parallel helper must match a sequential FakeZetaris read: same view,
SQL, row count, and sample. Watchers, Investigator, and Exposure keep that
order in the evidence record so claim text does not depend on which
query finished first.
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

import httpx  # noqa: E402

from floodsense_agents.events import EVENTS  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.nodes.exposure import make as make_exposure  # noqa: E402
from floodsense_agents.nodes.investigator import make as make_investigator  # noqa: E402
from floodsense_agents.nodes.watchers import make as make_watchers  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris, ZetarisClient, run_sql_parallel  # noqa: E402

_JOBS = [
    (
        "SELECT point_id, ts_utc, discharge_m3s FROM floodsense_seed.hazard_timeline "
        "WHERE ts_utc BETWEEN ? AND ? AND discharge_m3s IS NOT NULL ORDER BY ts_utc",
        ("2024-10-29T00:00:00Z", "2024-10-29T18:00:00Z"),
    ),
    (
        "SELECT dataset, publisher, licence FROM floodsense_seed.provenance ORDER BY dataset",
        None,
    ),
    (
        "SELECT COUNT(*) AS policies, SUM(sum_insured_eur) AS sum_insured_eur "
        "FROM floodsense_seed.exposure_join WHERE in_footprint = TRUE",
        None,
    ),
]


class _Slow(FakeZetaris):
    def __init__(self) -> None:
        super().__init__()
        self._gate = threading.Lock()
        self.inflight = 0
        self.max_inflight = 0

    def run_sql(self, sql: str, params=None):
        with self._gate:
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            time.sleep(0.2)
            return super().run_sql(sql, params)
        finally:
            with self._gate:
                self.inflight -= 1


def _deps(zetaris: FakeZetaris | None = None) -> Deps:
    return Deps(zetaris=zetaris or FakeZetaris(), llm=FakeNightshift(), memory=NoMemory())


def _event_state(event_id: str = "EMSR773") -> dict:
    return {
        "run_id": "parallel",
        "event_id": event_id,
        "event": EVENTS[event_id].as_dict(),
        "request": {"question": EVENTS[event_id].name, "lang": "en"},
        "provenance": [],
        "evidence": {},
        "anomalies": [],
        "trace": [],
        "hypotheses": [],
        "claims": [],
        "revise_rounds": 0,
        "model_ids": [],
    }


class ParallelSqlTest(unittest.TestCase):
    def test_parallel_rows_match_sequential_fake_zetaris(self) -> None:
        left = FakeZetaris()
        right = FakeZetaris()
        sequential = [left.run_sql(sql, params) for sql, params in _JOBS]
        parallel = run_sql_parallel(right, _JOBS)
        self.assertEqual(len(parallel), len(sequential))
        for seq, par in zip(sequential, parallel):
            self.assertEqual(par.view, seq.view)
            self.assertEqual(par.sql, seq.sql)
            self.assertEqual(par.row_count, seq.row_count)
            self.assertEqual(par.rows_sample, seq.rows_sample)
            self.assertIsNone(par.error)

    def test_parallel_rows_match_when_a_loop_is_already_running(self) -> None:
        left = FakeZetaris()
        sequential = [left.run_sql(sql, params) for sql, params in _JOBS]

        async def _inside():
            return run_sql_parallel(FakeZetaris(), _JOBS)

        parallel = asyncio.run(_inside())
        self.assertEqual(len(parallel), len(sequential))
        for seq, par in zip(sequential, parallel):
            self.assertEqual(par.view, seq.view)
            self.assertEqual(par.sql, seq.sql)
            self.assertEqual(par.row_count, seq.row_count)
            self.assertEqual(par.rows_sample, seq.rows_sample)
            self.assertIsNone(par.error)

    def test_independent_queries_overlap(self) -> None:
        slow = _Slow()
        run_sql_parallel(slow, _JOBS)
        self.assertGreater(slow.max_inflight, 1)

    def test_max_parallel_one_does_not_overlap(self) -> None:
        slow = _Slow()
        with patch.object(settings, "zetaris_max_parallel", 1):
            run_sql_parallel(slow, _JOBS)
        self.assertEqual(slow.max_inflight, 1)

    def test_later_queries_may_finish_first_and_order_stays(self) -> None:
        class _Staggered(FakeZetaris):
            def run_sql(self, sql: str, params=None):
                if "provenance" in sql:
                    time.sleep(0.25)
                elif "exposure_join" in sql:
                    time.sleep(0.01)
                else:
                    time.sleep(0.12)
                return super().run_sql(sql, params)

        out = run_sql_parallel(_Staggered(), _JOBS)
        self.assertTrue(out[0].view.endswith("hazard_timeline"))
        self.assertTrue(out[1].view.endswith("provenance"))
        self.assertTrue(out[2].view.endswith("exposure_join"))
        self.assertTrue(all(row.error is None and row.row_count > 0 for row in out))

    def test_a_raising_query_is_evidence_error_and_siblings_return(self) -> None:
        class _BoomProvenance(FakeZetaris):
            def run_sql(self, sql: str, params=None):
                if "provenance" in sql:
                    raise RuntimeError("provenance down")
                return super().run_sql(sql, params)

        out = run_sql_parallel(_BoomProvenance(), _JOBS)
        self.assertIsNone(out[0].error)
        self.assertGreater(out[0].row_count, 0)
        self.assertIn("provenance down", out[1].error or "")
        self.assertEqual(out[1].row_count, 0)
        self.assertIsNone(out[2].error)
        self.assertGreater(out[2].row_count, 0)

    def test_watchers_keep_hazard_then_provenance_order(self) -> None:
        valencia = make_watchers(_deps())(_event_state("EMSR773"))
        valencia_sql = [row["sql"] for row in valencia["evidence"].values()]
        self.assertEqual(len(valencia_sql), 5)
        self.assertIn("rain_mm", valencia_sql[0])
        self.assertIn("SUM(rain_mm)", valencia_sql[1])
        self.assertIn("discharge_m3s", valencia_sql[2])
        self.assertIn("warning_level", valencia_sql[3])
        self.assertIn("provenance", valencia_sql[4])
        self.assertFalse(any("gauge_levels" in sql for sql in valencia_sql))
        out = make_watchers(_deps())(_event_state("EMSR517"))
        sqls = [row["sql"] for row in out["evidence"].values()]
        self.assertEqual(len(sqls), 6)
        self.assertIn("rain_mm", sqls[0])
        self.assertIn("SUM(rain_mm)", sqls[1])
        self.assertIn("discharge_m3s", sqls[2])
        self.assertIn("warning_level", sqls[3])
        self.assertIn("gauge_levels", sqls[4])
        self.assertIn("provenance", sqls[5])
        kinds = [item["kind"] for item in out["anomalies"]]
        self.assertLess(kinds.index("rain"), kinds.index("discharge"))
        self.assertLess(kinds.index("discharge"), kinds.index("warning"))
        replay = FakeZetaris()
        for row in out["evidence"].values():
            again = replay.run_sql(row["sql"])
            self.assertEqual(again.rows_sample, row["rows_sample"])
            self.assertEqual(again.row_count, row["row_count"])
            self.assertEqual(again.view, row["view"])

    def test_investigator_keeps_claim_text_and_evidence_order(self) -> None:
        first = make_investigator(_deps())(_event_state())
        second = make_investigator(_deps())(_event_state())
        self.assertEqual(
            [c["text"] for c in first["claims"]],
            [c["text"] for c in second["claims"]],
        )
        self.assertEqual(
            [h["link"] for h in first["hypotheses"]],
            ["rain->catchment", "catchment->river", "river->site"],
        )
        views = [row["view"].split(".")[-1] for row in first["evidence"].values()]
        self.assertEqual(
            views,
            [
                "hazard_timeline",
                "hazard_timeline",
                "discharge_daily",
                "exposure_join",
                "hazard_timeline",
                "hazard_timeline",  # the peak row
            ],
        )

    def test_exposure_keeps_sample_segment_and_total_order(self) -> None:
        out = make_exposure(_deps())(_event_state())
        sqls = [row["sql"] for row in out["evidence"].values()]
        self.assertEqual(len(sqls), 3)
        self.assertIn("ORDER BY sum_insured_eur DESC", sqls[0])
        self.assertNotIn("GROUP BY", sqls[0])
        self.assertIn("GROUP BY segment", sqls[1])
        self.assertIn("COUNT(*)", sqls[2])
        self.assertNotIn("GROUP BY", sqls[2])
        self.assertEqual(out["exposure"]["policies"], 7)
        self.assertEqual(out["exposure"]["sum_insured_eur"], 21_600_000)
        self.assertEqual(
            [c["text"] for c in out["claims"]],
            [c["text"] for c in make_exposure(_deps())(_event_state())["claims"]],
        )


class TokenRefreshTest(unittest.TestCase):
    def test_two_concurrent_401s_login_once(self) -> None:
        barrier = threading.Barrier(2)
        logins: list[str] = []
        login_lock = threading.Lock()

        def fake_get(url, **kwargs):
            with login_lock:
                logins.append(url)
                n = len(logins)
            time.sleep(0.05)
            req = httpx.Request("GET", url)
            return httpx.Response(200, json={"idToken": f"fresh-{n}"}, request=req)

        def fake_post(url, **kwargs):
            token = kwargs["headers"]["Authorization"].removeprefix("Bearer ")
            req = httpx.Request("POST", url)
            if token == "stale":
                barrier.wait(timeout=3)
                return httpx.Response(401, text="expired", request=req)
            return httpx.Response(200, json={"data": [], "headers": []}, request=req)

        with (
            patch.object(settings, "zetaris_api_key", None),
            patch("floodsense_agents.zetaris.httpx.get", fake_get),
            patch("floodsense_agents.zetaris.httpx.post", fake_post),
        ):
            client = ZetarisClient()
            client.rest = "http://zetaris.test"
            client._token = "stale"
            errors: list[BaseException] = []
            results = []

            def run() -> None:
                try:
                    results.append(client.run_sql("SELECT 1"))
                except BaseException as exc:
                    errors.append(exc)

            threads = [threading.Thread(target=run), threading.Thread(target=run)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)

        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(logins, ["http://zetaris.test/auth/login"])
        self.assertEqual(len(results), 2)
        self.assertTrue(all(row.error is None for row in results))
        self.assertEqual(client._token, "fresh-1")


if __name__ == "__main__":
    unittest.main()
