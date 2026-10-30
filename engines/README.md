# engines: H-MEM and World Model sidecar

A small HTTP service next to the agents. It runs two Meterless engines and maps FloodSense onto them:

- **H-MEM** keeps what an analyst approved and recalls it on the next run. Every memory carries the Zetaris `query_id`s it came from, and the trust ledger explains why it is remembered.
- **World Model** holds the hypothesis board and the observations behind it as an append-only event log. Re-ingesting the same readings changes nothing, which is what makes the replay safe.

The engines are the Meterless reference implementations, copied unchanged into `vendor/` (Apache-2.0, see `NOTICE`). Both conformance suites pass: H-MEM 13/13, World Model 8/8.

## Run it

Needs **Node.js 22.18 or newer**. It runs the TypeScript directly, so there is nothing to install or build. The lint and UI CI job still uses Node 20, which cannot run this service. `python tasks.py engines-test` and the `engines` CI job use Node 22.18 or newer.

```
cd engines
npm start
```

That serves `http://127.0.0.1:8300` and keeps data in `engines/.data/` (git-ignored).

## Configuration

Defaults work as they are. `python tasks.py init-env` copies `.env.example` to `.env` in this folder along with the other env files, and `npm start` reads it when it exists. There are no secrets and no authentication, so keep the service on loopback or on the compose network.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENGINES_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only inside a container. |
| `ENGINES_PORT` | `8300` | Port. Anything that is not a port number stops the service at start. |
| `ENGINES_DATA_DIR` | `engines/.data` | Persistence directory. `memory` keeps nothing on disk. |

The agents find the service through **`ENGINES_URL`**:

| Agents run | `ENGINES_URL` |
| --- | --- |
| On the host | `http://127.0.0.1:8300` |
| In compose (the agents service) | `http://engines:8300` |

`compose.yaml` sets `ENGINES_URL=http://engines:8300` on the agents service. That value wins over `agents/.env`. The published host port is `127.0.0.1:${FLOODSENSE_ENGINES_PORT:-8300}`. Inside the container the process binds `0.0.0.0` (`ENGINES_HOST`), which compose sets so a laptop `engines/.env` of `127.0.0.1` cannot hide the port from the agents service. The host port stays on loopback.

The Python client that reads `ENGINES_URL` is `agents/floodsense_agents/engines.py`, called from `nodes/memory.py` and `nodes/world_model.py` (and by the forecast lane's history step for H-MEM recall).

## Check it

```
npm test            # 18 unit and HTTP tests (node:test)
npm run conformance # both Meterless conformance suites
```

`npm run typecheck` needs the two dev dependencies, TypeScript and `@types/node`: run `npm install` once, then `npm run typecheck`. Nothing else needs an install; `npm start`, `npm test` and `npm run conformance` run on Node alone.

## Vocabulary

Wire names are snake_case and come from the agents' models (`agents/floodsense_agents/models.py`, PR #4) and `contracts/schemas/floodsense.schema.json`, so the agents can post their pydantic objects as they are (`model_dump()`). Fields the engines do not use are ignored.

| Engines field | Comes from | Notes |
| --- | --- | --- |
| `claims[]`: `claim_id`, `text`, `citations[].query_id` | contracts `claim`, `citation` | The agents' `Claim` extras (`kind`, `numbers`, `hypothesis_id`) are accepted. |
| `approval`: `status`, `reviewer`, `reviewer_note` | agents `Approval` (the run-level approval) | Only `approved` and `edited` are remembered. `rejected`, `not_reached`, `awaiting` and `auto` write nothing: memory keeps a human yes. The per-action `approval` in contracts releases playbook actions and is not an engines concern. |
| `question`, `run_id`, `event_id` | agents `RunRequest` and state | |
| `hypotheses[]`: `id`, `link`, `statement`, `status`, `evidence`, `citations`, `rounds`, `rationale` | agents `Hypothesis` | `status` is `proposed`, `supported` or `not_supported`. contracts has no hypothesis yet. |
| `anomalies[]`: `id`, `kind`, `point_id`, `ts_utc`, `value`, `unit`, `why`, `query_id` | agents `Anomaly` | Keyed by what was measured (`kind`, `point_id`, `ts_utc`), so the same reading from another run is the same observation. |
| `confidence`, `entities` on a claim; `confidence`, `concerns` on a hypothesis | engines extras | Optional. Confidence is 0 to 1. |

## HTTP contract

JSON in, JSON out. Bad input is a 400 with `{ "error": ... }`, and a write is checked in full before anything is stored, so a 400 has written nothing. A body over 1 MB is a 413, and the server closes the connection instead of reading the rest.

| Method and path | Body or query | Returns |
| --- | --- | --- |
| `GET /health` | | `{ ok, hmem: { memories, ledger_entries }, world_model: { events, hypotheses } }` |
| `POST /hmem/store` | `{ run_id, question, event_id?, approval: { status, reviewer? }, claims: [...] }` | `{ stored, already_stored, skipped, reason? }`; each stored item is `{ claim_id, memory_id }` |
| `POST /hmem/recall` | `{ query, top_n?, threshold? }`: `top_n` 1 to 50 (default 5), `threshold` 0 to 1 (default 0.35) | `{ memories: [{ memory_id, content, relevance, confidence, run_id, claim_id, query_ids, provenance }], trace }` |
| `POST /hmem/feedback` | `{ memory_id, kind }` with `kind` = `helpful`, `not_helpful` or `wrong` | `{ memory_id, confidence }` |
| `GET /hmem/ledger?memory_id=` | | `{ entries }`, oldest first, each with `action`, `actor` and `at` |
| `GET /hmem/memories?limit=` | `limit` 1 to 50 (default 5) | `{ total, memories: [{ memory_id, content, confidence, run_id, claim_id, event_id, tags, provenance }] }`, newest first; read-only, no recall and no ledger entry (the API's `GET /system`) |
| `POST /wm/observations` | `{ anomalies?: [...], observations?: [{ external_id, title, at, source: { kind }, type?, text?, entities? }] }` | Ingest report; `changed` is `false` on a replay |
| `POST /wm/hypotheses` | `{ run_id, at, by?, hypotheses: [...] }` | `{ board }` |
| `GET /wm/board?run_id=` | | `{ board }` for one run, or all runs |
| `GET /wm/timeline?limit=` | `limit` 1 to 1000 (default 100) | Latest World Model events |

`at` is the scenario clock (the replay time), not the wall clock, so a replayed run produces the same events.

### Retries are safe

- A memory is keyed by `(run_id, claim_id)`. Sending a run again stores only the claims that are not remembered yet and lists the rest in `already_stored`, so a run that failed half way is finished by a retry, and nothing is stored twice.
- A hypothesis is keyed by `(run_id, id)`. An unchanged hypothesis, an unchanged status and an existing concern write nothing, so the same call twice appends no events.

## How the agents use it

- **Watchers** post `state["anomalies"]` to `/wm/observations`.
- **Investigator** calls `/hmem/recall` with the question before it builds the chain, and posts its hypotheses to `/wm/hypotheses`.
- **Skeptic** posts the same hypothesis ids with their new `status`, `rounds` and `rationale`.
- **Learn** (after the human decision) posts `run_id`, the question, `state["approval"]` and the claims to `/hmem/store`. This is the `Memory.store` side of the `Memory` protocol in `agents/`; `Memory.recall` maps to `/hmem/recall`.

## Not done yet

- The reference embedder is a deterministic hash, not semantic. Swapping in real embeddings is part of the semantic cache work.
- The lint and UI CI job stays on Node 20. Engines tests are a separate job (`python tasks.py engines-test` on Node 22.18 or newer). Node 20 still cannot run `npm start`, `npm test`, or `npm run conformance`.
