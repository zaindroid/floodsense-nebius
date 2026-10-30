# Contracts

Owner: Mihir. Shared shapes for `agents/`, `api/`, and `ui/`. The choice is a proposal for the team to accept or change at stand-up. The record is [ADR 0007](../docs/adr/0007-json-schema-contracts.md).

## Source of truth

[`schemas/floodsense.schema.json`](schemas/floodsense.schema.json) (JSON Schema draft 2020-12).

Python ([`python/floodsense_contracts`](python/floodsense_contracts)) and TypeScript ([`typescript/index.ts`](typescript/index.ts)) are hand-checked mirrors. Contract tests load [`examples/`](examples/) through the schema and through Pydantic, and `python tasks.py lint` typechecks the TypeScript against those examples. No code generator. Adding a field means editing the schema, both mirrors, and an example in the same pull request, and saying so at the 14:00 check-in.

Wire format is snake_case, as in the gameplan's citation record. The mock on `spike/mock-ui` uses camelCase and different judge fields. That branch is not merged and this folder does not change it.

The API projects a graph run onto this schema in `api/app/project.py` (since #21). `POST /runs` and `GET /runs/{id}` carry that projection beside the graph payload. The UI re-exports the TypeScript mirror from `ui/src/types/contract.ts`. `agents/` keeps its own state and does not import this package.

## What is in scope

Only what v0.2.0–v0.8.0 need, plus the gameplan's Judge output and `served_from` / `cached_at` rules so the approval payload does not change shape later.

| Schema | Why it is here |
| --- | --- |
| `claim`, `citation`, `evidence` | v0.2.0 models. Citation columns are the gameplan's v1 record, including layer `c`. |
| `answer` | v0.5.0 run payload and the v0.7.0 screen. `served_from` is `live`, `cache`, or `replay`. `cached_at` is a timestamp when it is not live, and null or omitted when it is live. |
| `playbook_action` | v0.6.0. `citation_ids` has at least one id. |
| `approval` | v0.8.0. Status is `pending`, `approved`, `edited`, or `rejected`. |
| `judge` | Gameplan output: per-claim grounding, citation faithfulness, number match, score, rationale, `model_id`, plus `overall_score`. `model_id` is a routing name (`meterless/fast`, `meterless/deep`), a concrete Nightshift id the reply may carry, or `deterministic`. Optional on `answer` and `approval` until v0.10.0. |

`model_id` prefers those routing names. Which model answers one today is the table at the top of [docs/architecture/c4.md](../docs/architecture/c4.md). This folder does not keep a second map. A recorded id outside that enum, including a `MODEL_FAST` or `MODEL_DEEP` value the schema does not list, is not rewritten: the API omits the whole judge.

`rows_sample` is at most 20 objects. Column names are not fixed.

Examples are fixtures. They are not measurements, Judge scores, or a recorded run. The quote's `content_sha256` is the SHA-256 of that quote.

## Zetaris view columns

[`views.yaml`](views.yaml) is the column list for each Zetaris view name. `floodsense.<name>` and `floodsense_seed.<name>` share it. Migration headers (`-- view:`, `-- columns:`, `-- min_rows:`) are checked against that file by `scripts/tests/test_migration_contract.py`. It is not part of `floodsense.schema.json`, and it does not change the wire contract for `agents/`, `api/`, or `ui/`.

## What is not here

Left out on purpose, until the owner proposes fields:

- Gauge, station, region, portfolio, and exposure columns (Urvashi, Saleeta, Ayush, Zain).
- Skeptic challenge records and the World Model board (Zain, Ayush). v0.4.0 names the loop and not the fields.
- Retrieval traces and the chunk table (in `v0.14.0`, behind `FF_RAG_DOCS`). The citation record names the layer `c` locator rule and optional `chunk_id`. The chunk store is not a wire object. `v0.11.0` is the retired name and is not a tag.
- Notifications, sessions, and the mock's risk enum. The gameplan does not define those scales.
- The mock's `served_from` pair `live` \| `cache` and its `DataProvenance` of `live` \| `sample` \| `reconstructed`. The wire value includes `replay`.

## Checks

From the repo root, with API deps, this file, and the dev requirements installed (see the README for the Windows lines):

```text
python tasks.py test
python tasks.py lint
```

`test` discovers `contracts/tests`. `lint` typechecks `contracts/tsconfig.json` with the TypeScript package from `ui/node_modules` after `npm ci` in `ui/`.

## Open questions

- Layer `c` required fields are settled: `quote`, `query_id`, and `locator.page`, `locator.paragraph`, and `locator.lines`. `page` is never null on layer `c`. A source with no PDF pagination still sets a page-like id (`1` for the whole document, or one id per section). `section` stays optional and does not replace `page`. `chunk_id` stays optional. Layers `a` and `b` still leave locator and quote optional. The gameplan still marks the shared column names as a proposal until Urvashi and Saleeta see the real source columns.
- Whether `edited` is the right status word for the gameplan's "edit", or whether Zain wants a separate amended body. Today the human note is `note`.
- Empty `evidence` is allowed because not every claim is a number. A finished numeric claim should still carry evidence. The schema does not enforce that link beyond `query_id`.
- The mock Judge used `verdict`, `groundedness`, `citationCoverage`, and `skepticResolution`, and a claim support of `contradicted`. This schema follows the gameplan table instead (`supported`, `partial`, `unsupported`).
