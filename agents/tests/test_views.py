"""GET /views/{name}: allowlist, schema from FF_LIVE_DATA, typed rows."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from fastapi.testclient import TestClient  # noqa: E402
from langgraph.checkpoint.memory import MemorySaver  # noqa: E402

from floodsense_agents import __main__ as service  # noqa: E402
from floodsense_agents.graph import build_graph  # noqa: E402
from floodsense_agents.models import Evidence  # noqa: E402
from floodsense_agents.nightshift import FakeNightshift  # noqa: E402
from floodsense_agents.runtime import Runtime  # noqa: E402
from floodsense_agents.settings import settings  # noqa: E402
from floodsense_agents.state import Deps, NoMemory  # noqa: E402
from floodsense_agents.zetaris import FakeZetaris  # noqa: E402


class StringZetaris:
    """Answers like the REST API: every value a string."""

    def __init__(self) -> None:
        self.sql: list[str] = []

    def run_sql(self, sql, params=None, sample=20):
        self.sql.append(sql)
        self.sample = sample
        rows = [
            {
                "policy_id": "P-1",
                "site_id": "S-1",
                "lat": "39.4",
                "lon": "-0.4",
                "in_footprint": "true",
                "sum_insured_eur": "1000000",
                "segment": "retail",
                "synthetic": "yes",
            },
            {
                "policy_id": "P-2",
                "site_id": "S-2",
                "lat": "39.5",
                "lon": "-0.3",
                "in_footprint": "false",
                "sum_insured_eur": "",
                "segment": "office",
                "synthetic": "yes",
            },
        ]
        return Evidence(
            query_id="q-1",
            view="x",
            sql=sql,
            rows_sample=rows[:sample],
            row_count=2,
            executed_at_utc="2026-10-26T00:00:00Z",
        )


class RowsZetaris:
    """Returns the given rows, honouring sample like the real clients."""

    def __init__(self, rows) -> None:
        self.rows = rows

    def run_sql(self, sql, params=None, sample=20):
        return Evidence(
            query_id="q-2",
            view="x",
            sql=sql,
            rows_sample=self.rows[:sample],
            row_count=len(self.rows),
            executed_at_utc="2026-10-26T00:00:00Z",
        )


def _without_hazard_now() -> FakeZetaris:
    z = FakeZetaris()
    z._conn.execute(f"DROP TABLE {settings.schema}.hazard_now")
    return z


class ViewsTest(unittest.TestCase):
    def _client(self, zetaris) -> TestClient:
        deps = Deps(zetaris=zetaris, llm=FakeNightshift(), memory=NoMemory())
        service.set_runtime(
            Runtime(graph=build_graph(deps, MemorySaver(), ff_judge=True), deps=deps)
        )
        return TestClient(service.app)

    def test_unknown_view_is_404_and_never_queried(self) -> None:
        z = StringZetaris()
        c = self._client(z)
        for name in ("policies", "exposure_join;drop", "floodsense.provenance", "pg_tables"):
            self.assertEqual(c.get(f"/views/{name}").status_code, 404, name)
        self.assertEqual(z.sql, [])

    def test_weather_forecast_is_exposed_with_numbers(self) -> None:
        c = self._client(FakeZetaris())
        r = c.get("/views/weather_forecast")
        self.assertEqual(r.status_code, 200)
        # The fake runs the seed schema: 45 position-only rows, no forecast, all dropped.
        self.assertEqual(r.json(), [])
        self.assertEqual(r.headers["x-dropped-rows"], "45")

    def test_discharge_daily_is_a_bare_array_past_the_sample_cap(self) -> None:
        c = self._client(FakeZetaris())
        r = c.get("/views/discharge_daily")
        self.assertEqual(r.status_code, 200)
        rows = r.json()
        self.assertIsInstance(rows, list)
        fake = service.runtime().deps.zetaris
        everything = fake.run_sql(f"SELECT * FROM {settings.schema}.discharge_daily", sample=10_000)
        self.assertEqual(len(rows), everything.row_count)
        self.assertIsInstance(rows[0]["discharge_m3s"], float)
        self.assertEqual(r.headers["x-schema"], settings.schema)
        self.assertTrue(r.headers["x-query-id"])

    def test_strings_become_numbers_and_booleans(self) -> None:
        z = StringZetaris()
        r = self._client(z).get("/views/exposure_join")
        rows = r.json()
        self.assertEqual(rows[0]["lat"], 39.4)
        self.assertIs(rows[0]["in_footprint"], True)
        self.assertEqual(rows[0]["segment"], "retail")
        # P-2 has an empty sum_insured_eur, which the UI validator rejects.
        self.assertEqual([x["policy_id"] for x in rows], ["P-1"])
        self.assertEqual(r.headers["x-dropped-rows"], "1")
        self.assertNotIn("x-truncated", r.headers)
        self.assertIn("LIMIT 5001", z.sql[0])
        self.assertEqual(z.sample, 5001)  # Evidence keeps every row, not the 20-row sample

    def test_bad_cells_drop_the_row_not_the_view(self) -> None:
        good = {
            "policy_id": "P-1",
            "site_id": "S-1",
            "lat": "1",
            "lon": "2",
            "in_footprint": "false",
            "sum_insured_eur": "5",
            "segment": "retail",
        }
        z = RowsZetaris(
            [
                good,
                {**good, "policy_id": "P-2", "in_footprint": "maybe"},
                {**good, "policy_id": "P-3", "lat": "abc"},
            ]
        )
        r = self._client(z).get("/views/exposure_join")
        self.assertEqual([x["policy_id"] for x in r.json()], ["P-1"])
        self.assertIs(r.json()[0]["in_footprint"], False)
        self.assertEqual(r.headers["x-dropped-rows"], "2")

    def test_provenance_needs_an_http_source_url(self) -> None:
        row = {
            "dataset": "d",
            "source_url": "https://x.eu",
            "publisher": "p",
            "licence": "l",
            "attribution": "a",
            "fetched_at": "2026-10-22",
        }
        z = RowsZetaris([row, {**row, "source_url": None}, {**row, "source_url": "javascript:x"}])
        r = self._client(z).get("/views/provenance")
        self.assertEqual(len(r.json()), 1)
        self.assertEqual(r.headers["x-dropped-rows"], "2")

    def test_capped_view_is_marked_truncated(self) -> None:
        rows = [{"point_id": "p", "date": "2024-10-29", "discharge_m3s": "1", "source": "s"}] * 5001
        r = self._client(RowsZetaris(rows)).get("/views/discharge_daily")
        self.assertEqual(len(r.json()), 5000)
        self.assertEqual(r.headers["x-truncated"], "true")
        r = self._client(RowsZetaris(rows[:5000])).get("/views/discharge_daily")
        self.assertEqual(len(r.json()), 5000)
        self.assertNotIn("x-truncated", r.headers)

    def test_502_hides_the_zetaris_error(self) -> None:
        r = self._client(_without_hazard_now()).get("/views/hazard_now")
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json()["detail"], "could not read view hazard_now")

    def test_schema_follows_ff_live_data(self) -> None:
        z = StringZetaris()
        c = self._client(z)
        with mock.patch.object(settings, "live_data", True):
            c.get("/views/exposure_join")
        with mock.patch.object(settings, "live_data", False):
            c.get("/views/exposure_join")
        self.assertIn("FROM floodsense.exposure_join", z.sql[0])
        self.assertIn("FROM floodsense_seed.exposure_join", z.sql[1])

    def test_event_id_is_ignored_on_views_without_the_column(self) -> None:
        z = StringZetaris()
        self._client(z).get("/views/exposure_join", params={"event_id": "x' OR 1=1"})
        self.assertNotIn("WHERE", z.sql[0])

    def test_replay_source_reads_floodsense_seed_for_the_event_points(self) -> None:
        z = FakeZetaris()
        z._conn.execute("DELETE FROM floodsense.hazard_timeline WHERE point_id LIKE 'AHR%'")
        z._conn.commit()
        c = self._client(z)
        with mock.patch.object(settings, "live_data", True):
            live = c.get("/views/hazard_timeline", params={"event_id": "EMSR517"})
            r = c.get("/views/hazard_timeline", params={"event_id": "EMSR517", "source": "replay"})
            d = c.get("/views/discharge_daily", params={"event_id": "ahr_2021", "source": "replay"})
        self.assertEqual(live.headers["x-schema"], "floodsense")
        self.assertFalse(any(row["point_id"].startswith("AHR") for row in live.json()))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-schema"], "floodsense_seed")
        self.assertEqual(r.headers["x-source"], "replay")
        ids = {row["point_id"] for row in r.json()}
        self.assertTrue(ids)
        self.assertTrue(all(i.startswith("AHR") for i in ids), ids)
        self.assertEqual(d.status_code, 200)
        self.assertTrue(all(row["point_id"].startswith("AHR") for row in d.json()))

    def test_replay_source_is_allowlisted(self) -> None:
        z = StringZetaris()
        c = self._client(z)
        bad = [
            ("exposure_join", {"event_id": "EMSR517", "source": "replay"}),
            ("hazard_timeline", {"source": "replay"}),
            ("hazard_timeline", {"event_id": "x' OR 1=1", "source": "replay"}),
            ("hazard_timeline", {"event_id": "EMSR517", "source": "floodsense_seed"}),
        ]
        for name, params in bad:
            self.assertEqual(c.get(f"/views/{name}", params=params).status_code, 422, params)
        self.assertEqual(z.sql, [])

    def test_a_failed_read_is_502(self) -> None:
        # hazard_now is dropped from this fake, so the read errors.
        self.assertEqual(
            self._client(_without_hazard_now()).get("/views/hazard_now").status_code, 502
        )


if __name__ == "__main__":
    unittest.main()
