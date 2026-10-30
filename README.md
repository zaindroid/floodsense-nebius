# FloodSense EU — Nebius hackathon deployment

The deploy mirror of [FloodSenseEU-Hackathon-Monorepo](https://github.com/GenAI-Open-Agent-Hackathon/FloodSenseEU-Hackathon-Monorepo)
for the Nebius entry, served at **https://floodsense-nebius.zaindroid.me**.

Everything except `serve/` comes from the monorepo's `main` (currently with PR #132, which records the model
provider on the trace, and PR #131, which fixes Tavily's status and sources). Every model call goes to **NVIDIA Nemotron on Nebius Token
Factory**; the data comes from Zetaris.

## Two copies of the same app

| Where | What it is |
|---|---|
| `https://floodsense-nebius.zaindroid.me` | Always on, on the team's own server. Model calls go to Nebius Token Factory. |
| A Nebius AI Cloud VM | The same app on Nebius compute. It sleeps to save credit; start it from `/nebius`. |

## What `serve/` adds

- `login.py` — one judge login in front of the whole app, so the Token Factory credit cannot be
  spent by anyone who finds the address. `/health`, `/ready` and `/version` stay open.
- `nebius.py`, `nebius.html` — the `/nebius` page and `/nebius/api/{status,start,stop,extend}`.
  They hold a service account key with only the `compute.instance-power-operator` role, so they can
  start, stop and read that one VM. The VM goes back to sleep after `NEBIUS_AUTO_STOP_MIN` (120).

## Settings

Set on the platform, never committed: `LLM_BACKEND=nebius`, `NEBIUS_API_KEY`, `ZETARIS_REST_URL`,
`ZETARIS_API_KEY`, `FF_LIVE_DATA`, `JUDGE_PASSWORD`, and for `/nebius`: `NEBIUS_INSTANCE_ID`,
`NEBIUS_DEMO_URL`, plus either `NEBIUS_SA_CREDENTIALS` (the credentials JSON) or `NEBIUS_SA_ID`,
`NEBIUS_SA_PUBLIC_KEY_ID` and `NEBIUS_SA_PRIVATE_KEY`.

Tests for `serve/`: `python -m unittest serve.test_nebius_front` (needs `fastapi`, `httpx`, `nebius`).
