"""Which datasets a view reads.

`floodsense.provenance` names a dataset the way a reader needs it, "Open-Meteo
Flood API (GloFAS discharge)", and nothing in the warehouse says which view
reads it: `dataset_id` stays inside the migrations and the view never exposes
it. The agents write the SQL for every view, so this is the one place that
knows, and a layer (b) citation cannot name a licence or an attribution
without it.

Matching is exact. A dataset renamed in `ingestion/prep/provenance.csv` should
fail a test rather than quietly drop the citation that carries the licence.
"""

from __future__ import annotations

from typing import Any

# view name (without its container) -> the datasets it reads, in reading order
DATASETS: dict[str, tuple[str, ...]] = {
    "discharge_daily": ("Open-Meteo Flood API (GloFAS discharge)",),
    "hazard_timeline": (
        "Open-Meteo historical weather API (rain)",
        "Open-Meteo Flood API (GloFAS discharge)",
    ),
    "hazard_now": ("Open-Meteo forecast rain and rolling GloFAS discharge (hazard_now)",),
    "gauge_levels": ("PEGELONLINE Rhine water levels (Bonn, Koeln, Koblenz)",),
    "eu_watch": ("Open-Meteo Flood API (GloFAS discharge)",),
    "weather_forecast": ("Open-Meteo forecast API (DWD ICON precipitation)",),
    "exposure_join": (
        "Synthetic insurer portfolio",
        "EMSR773 flood extent (observed event layers)",
        "OSM sites in the Horta Sud / Valencia bbox",
    ),
}


def rows_for(view: str, provenance: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The provenance rows behind a view, in reading order. Unknown view: none.

    `provenance` is the view's own rows, so a dataset the warehouse has not
    cleared is absent here and is not cited.

    FakeZetaris files its rows under the view name instead of a dataset title,
    which is why `dataset == view.split(".")[-1]` passed every test while
    matching nothing in the warehouse. Both shapes resolve here until the fake
    is corrected, and the title path has a test of its own so it is not the
    untested branch this time.
    """
    short = view.split(".")[-1]
    have = {
        row.get("dataset"): row
        for row in provenance
        if isinstance(row, dict) and row.get("dataset")
    }
    titled = [have[name] for name in DATASETS.get(short, ()) if name in have]
    if titled:
        return titled
    return [row for row in provenance if isinstance(row, dict) and row.get("dataset") == short]
