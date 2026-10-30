"""`python -m floodsense_agents.llmcheck`: live lane check. Exit 1 if a lane fails or answers off-Nemotron."""

from __future__ import annotations

import json
import sys

from floodsense_agents import tavily
from floodsense_agents.nightshift import check_lanes
from floodsense_agents.settings import settings


def main() -> int:
    try:
        res = check_lanes()
    except Exception as e:  # noqa: BLE001 - e.g. NEBIUS_API_KEY unset
        print(f"check-llm: {e}", file=sys.stderr)
        return 1
    if settings.ff_tavily:  # reported, not gating: web context is optional
        res["tavily"] = tavily.live_check()
    print(json.dumps(res, indent=2))
    return 0 if res["ok"] and all(v["nemotron"] for v in res["lanes"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
