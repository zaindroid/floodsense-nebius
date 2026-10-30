"""Which datasets back a view, against the shape the warehouse actually serves.

FakeZetaris files provenance under view names, so a test that only used the
fake would pass whatever the resolver did. These rows are copied from
floodsense.provenance.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CHECKPOINTER", "memory")
os.environ.setdefault("ZETARIS_MODE", "fake")
os.environ.setdefault("LLM_MODE", "fake")

from floodsense_agents.provenance import DATASETS, rows_for  # noqa: E402

WAREHOUSE = [
    {
        "dataset": "EMSR773 flood extent (observed event layers)",
        "source_url": "https://mapping.emergency.copernicus.eu/activations/EMSR773",
    },
    {
        "dataset": "OSM sites in the Horta Sud / Valencia bbox",
        "source_url": "https://www.openstreetmap.org/copyright",
    },
    {"dataset": "Synthetic insurer portfolio", "source_url": None},
    {
        "dataset": "Open-Meteo Flood API (GloFAS discharge)",
        "source_url": "https://open-meteo.com/en/docs/flood-api",
    },
    {
        "dataset": "Open-Meteo historical weather API (rain)",
        "source_url": "https://open-meteo.com/en/docs/historical-weather-api",
    },
    {"dataset": "AEMET observations (Valencia)", "source_url": "https://opendata.aemet.es/"},
    {
        "dataset": "PEGELONLINE Rhine water levels (Bonn, Koeln, Koblenz)",
        "source_url": "https://www.pegelonline.wsv.de/",
    },
    {
        "dataset": "Open-Meteo forecast rain and rolling GloFAS discharge (hazard_now)",
        "source_url": "https://open-meteo.com/en/docs",
    },
    {
        # migration 073: inline row of floodsense.provenance
        "dataset": "Open-Meteo forecast API (DWD ICON precipitation)",
        "source_url": "https://open-meteo.com/en/docs/dwd-api",
    },
]


class ProvenanceTest(unittest.TestCase):
    def test_a_warehouse_view_resolves_to_its_datasets(self) -> None:
        """The case that used to resolve to nothing: a dataset title never
        equals a view name, so every layer (b) citation was dropped."""
        rows = rows_for("floodsense.discharge_daily", WAREHOUSE)
        self.assertEqual([r["dataset"] for r in rows], ["Open-Meteo Flood API (GloFAS discharge)"])
        self.assertTrue(rows[0]["source_url"].startswith("https://"))

    def test_a_view_that_reads_several_datasets_keeps_reading_order(self) -> None:
        rows = rows_for("floodsense_seed.exposure_join", WAREHOUSE)
        self.assertEqual(
            [r["dataset"] for r in rows],
            [
                "Synthetic insurer portfolio",
                "EMSR773 flood extent (observed event layers)",
                "OSM sites in the Horta Sud / Valencia bbox",
            ],
        )

    def test_every_mapped_dataset_exists_in_the_warehouse_register(self) -> None:
        """A dataset renamed in ingestion/prep/provenance.csv fails here rather
        than quietly dropping the citation that carries its licence."""
        known = {row["dataset"] for row in WAREHOUSE}
        for view, datasets in DATASETS.items():
            for name in datasets:
                self.assertIn(name, known, f"{view} names a dataset the register does not have")

    def test_an_unmapped_view_cites_nothing_rather_than_guessing(self) -> None:
        self.assertEqual(rows_for("floodsense.provenance", WAREHOUSE), [])

    def test_the_fake_shape_still_resolves(self) -> None:
        """FakeZetaris files a row under the view name. Until that is corrected
        both shapes have to work, or every graph test loses its citations."""
        fake = [{"dataset": "discharge_daily", "source_url": "https://open-meteo.com"}]
        self.assertEqual(
            [r["dataset"] for r in rows_for("floodsense.discharge_daily", fake)],
            ["discharge_daily"],
        )


if __name__ == "__main__":
    unittest.main()
