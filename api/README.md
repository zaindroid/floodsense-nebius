# API

Purpose: the FastAPI service the UI and the demo call. It owns the public contract (gameplan §5.5) and proxies the run lifecycle to the agents service at `AGENTS_URL`: `POST /runs` (an optional `thread_id` continues a conversation), `GET /runs/past` (`?thread_id=` for one conversation), `GET /runs/{id}`, `GET /runs/{id}/replay`, `GET /runs/{id}/events` (SSE), `GET|POST /runs/{id}/approval`, `GET /runs/{id}/citations`, `GET /config`, `GET /health`. Every response carries `served_from` and `cached_at`. The cache and labelled replay sit here, in front of the proxy (below); rate limits guard the write routes (below). CORS is open to the UI origins only (`UI_ORIGINS`, default `http://localhost:15173,http://127.0.0.1:15173`).

Owner: Zain (runs, SSE, approval) and Ayush (cache and past runs). Mihir (rate limits).

PowerShell, from this directory. `python -m uvicorn` avoids the `Scripts` vs `bin` difference. `curl` in PowerShell is not curl.

```powershell
py -m pip install -r requirements.txt
py -m uvicorn app.main:app --reload --port 8000
Invoke-RestMethod http://127.0.0.1:8000/health
```

bash:

```bash
python3 -m pip install -r requirements.txt
python3 -m uvicorn app.main:app --reload --port 8000
curl -s http://127.0.0.1:8000/health
```

Inside compose the process listens on port 8000 and is published on host port 18000. On the host, run `python -m floodsense_agents` from `agents/` first and set `AGENTS_URL=http://127.0.0.1:8100` (the default). From the repo root, `python tasks.py init-env` copies `.env.example` to `.env` before `up`.

The NVIDIA chat key is not a variable for this service. It lives only in Nightshift's Providers tab. Document embeddings use `NVIDIA_NIM_API_KEY` in a gitignored env file (ADR 0009). This service does not call them.

## Cache and labelled replay

GAMEPLAN "Caching and the honest demo", in `app/cache.py`. Both are off unless their flag is on in `api/.env`.

- **Cache (`FF_SEMANTIC_CACHE`).** A run is cached when a person approved or edited it and the Judge passed it. A repeat of that question is answered with the original run, `200` instead of `201`, `served_from: "cache"` and a `cache` block (`original_run_id`, `age_s`, `expires_in_s`). The banner is "Cached answer from HH:MM · not live · original run R", including when the stored run was a clocked replay: the hit is cache, not replay and not live, and `replay_ts` / `cached_at` stay that UTC instant. The key is the question with case, spacing and punctuation folded, plus the event, customer, replay clock, language, and the agents' flags, lanes and schema, so a change of flags is a miss. The replay clock is normalised to `YYYY-MM-DDTHH:MM:SSZ` on lookup and on remember, so a zone-less or short form hits. Live data expires after `CACHE_TTL_LIVE_S` (900), a historical replay after `CACHE_TTL_REPLAY_S` (86400). `{"fresh": true}` in the body skips the cache. A follow-up in a thread is never cached or served from the cache. "Similar" means equal after folding for now; embedding similarity needs Nightshift's embed lane.
- **Replay (`FF_CACHED_REPLAY`).** When the live run fails (the agents are unreachable, answer 5xx, or return a failed run), and the request is not a follow-up, the API serves the newest person-approved run for the same question, event, customer, replay clock and language. `valencia_2024` matches `EMSR773` (and `ahr_2021` matches `EMSR517`). A different question is not served. `served_from` is `"replay"`, the banner is "Replay of a recorded run from HH:MM · not live · original run R" plus the original question, and the `replay` block carries that question, the clock, the reason, and `failed_run_id` when a live run failed. Lookups use `CACHE_LOOKUP_TIMEOUT_S` (3s), not the 600s run timeout. The agents' checkpointer holds the recordings; the API also keeps the last `REPLAY_MAX_RECORDINGS` (8) itself, and an unreachable agents service is answered from that recording without scanning the past list. With no matching recording, the failure is passed through. `GET /runs/{id}/replay` carries the same contract projection as a run snapshot.
- **Never presented as live.** The trace keeps the original run's timestamps, and `GET /config` reports the cache under `api_cache`.

The cache lives in this process (`CACHE_MAX_ENTRIES`, 256), with optional Redis behind it. Set `REDIS_URL` (`redis://redis:6379/0` under Compose with the `cache` profile; `redis://127.0.0.1:16379/0` from the host) and cache entries and recordings are also written to Redis as JSON with native TTLs (`SET EX`), under `floodsense:cache:v1:<sha256>` and `floodsense:replay:v1:<sha256>`. Entries expire with their cache TTL; recordings after `REPLAY_RECORDING_TTL_S` (30 days), so the replay fallback outlives a day. Lookups read Redis first and fall through to the in-process store on a miss, so the cache survives a restart and is shared between API processes. The in-process LRU bounds only this process; its evictions do not delete in Redis. When `REDIS_URL` is unset, or a Redis call fails or takes longer than `CACHE_LOOKUP_TIMEOUT_S`, the in-process store answers: one warning is logged, Redis is retried after 30s, and no request fails. Redis calls run off the event loop (`asyncio.to_thread`) with 0.5s socket timeouts. `GET /config` reports `api_cache.backend` (`redis` or `memory`, from a ping) and this process's entry and recording counts. Labels (`served_from`, `cached_at`, `label`) are the same on both backends. Tests: `pip install -r requirements-dev.txt` adds fakeredis.

## Rate limits

`app/ratelimit.py`, in this process, no extra dependency. `POST /runs` has a token bucket per client IP: `RATE_LIMIT_RUNS_PER_MIN` (10) per minute, with a burst of the same size (at least 1). `POST /runs/{id}/approval` is not limited, so a reviewer can always approve a run. Live `POST /runs` calls in flight to the agents are capped at `RATE_LIMIT_MAX_CONCURRENT_RUNS` (2); a cache hit does not take a slot, and with `FF_CACHED_REPLAY` on a full cap is answered with the labelled replay when one exists. Either refusal is `429` with a `Retry-After` header (the bucket's wait, or `RATE_LIMIT_CONCURRENCY_RETRY_AFTER_S`, 30, when the cap is full). `0` turns a guard off. `POST /runs?wait=false` (202, the graph runs in the background on the agents) passes the same bucket and takes a slot like a sync run; the API holds that slot, polling `GET /runs/{id}`, until the run leaves `running`, so async runs cannot get round the cap (the slot is also freed after 30 s of the agents being unreachable). A background run that fails after the 202 reads `failed` on `GET /runs/{id}` and on the SSE `status` event; it does not fall back to a labelled replay, which only the synchronous path does. A cache hit or a replay fallback still answers 200 with the run body. GET routes (health, config, past runs, replay, SSE events) are not limited. Limits are per process and per client IP; behind a reverse proxy run uvicorn with `--forwarded-allow-ips` so the client IP is the real one.

A `POST /runs` body that is not valid UTF-8 or not valid JSON is `400 {"detail": "request body must be UTF-8 JSON"}` (it used to be a 500).

Chat front door: after the bucket and before the cache or a slot, `POST /runs` asks the agents' `POST /front-door` (short lookup timeout). Small talk (greeting, help, thanks, off-topic) comes back as `200 {"kind": "reply", ...}` with no `run_id`, on sync and `?wait=false` alike. A reply takes a bucket token but no concurrency slot, and is never cached or replayed as a run. Anything else, or a front door that is unreachable or slow, goes on to the run as before; the API then forwards `POST /runs?front_door=false` so the agents do not classify twice.

The quick and forecast lanes also carry `plain` (the calm answer: headline, one_line, horizon, context, next_step, disclaimer, details; `agents/floodsense_agents/plain.py`, no model call). The snapshot has it, and the schema projection (`contract.answer.plain`) passes it through unchanged for those two lanes only.

Router lanes: a reply carries `lane: "reply"`; a run snapshot carries `lane` (`quick` or `full`) and `router_reason`, and the schema projection (`contract.answer`) copies both. Repeated identical small talk spends one bucket token each (a burst ends in 429). A quick-lane answer ends `status: "answered"` with no approval; when its Judge passed and `FF_SEMANTIC_CACHE` is on, the API caches it with `CACHE_TTL_LIVE_S` (sync: on the response; `?wait=false`: when the slot holder sees the run leave `running`). A repeat is `200` with `served_from: "cache"`, `cached_at` = the time it was stored, `label.text` "Cached answer · not live · original run …" and `cache.expires_in_s`. Full-lane runs are still cached only after a person approves them.

## Control tower (`/watch/*`)

Passed through to the agents' watch loop (`agents/README.md` "Control tower"): `GET /watch/events?since=&limit=`, `GET /watch/status`, `GET /watch/stream` (SSE proxied as-is; `Last-Event-ID` is forwarded), `POST /watch/cycle` ("Scan now") and `POST /watch/auto-assess {enabled}`. `POST /watch/cycle` is `202` (the scan runs on the agents). `POST /watch/auto-assess` needs the header `x-watch-admin-token` when `WATCH_ADMIN_TOKEN` is set on the API (it is passed on to the agents); set it on any machine that is not a dev box. The two POSTs share a small bucket of their own, `WATCH_CYCLES_PER_MIN` (6) per client, so a scan or a switch never spends a run token; empty is `429` with `Retry-After`. The GETs are not limited. An unreachable agents service is `503`.

## Platform strip (`GET /platform/status`)

Small read-only body (`app/platform_status.py`, `Cache-Control: no-store`, no keys or URLs) for the UI Platform strip: `llm_backend` (`nightshift|nebius`, from the agents `/config`), `lanes` (model id per lane), `data_backend` and `tavily` (both from the agents `/config`, the source of truth: `data_backend` is always `zetaris` today; `tavily` is the agents' `FF_TAVILY` switch, never the key; false when the agents are down), `latency` (`{lane: {n, p50_ms, p95_ms}}` API-side, of the last 200 synchronous `POST /runs` this process forwarded (async runs are not timed), by the run's `lane`, else `full`), `cache` (`backend, hits, misses, hit_rate`), `rate_limit` (`in_flight, max_concurrent, runs_per_min, rejected_429_recent, rejected_429_total`), `live_sources` (agents `/watch/status` counts.sources) and `counters_since_utc`. Counters reset on restart. TypeScript: `ui/src/api/platform.ts`.

## System status (`GET /system`)

## Views cache (`GET /views/{name}`)

`app/views_cache.py`. The live views (`eu_watch`, `hazard_now`, `weather_forecast`, `discharge_daily`, `rain_hourly`, `hazard_timeline`) are Zetaris REST tables that call Open-Meteo at query time, so every page load, reviewer browser, tower scan and run repeated those calls and Open-Meteo answered 429. The API now keeps a copy per view name and query string: TTL 600 s for those views, 120 s for `gauge_levels` (the poller writes every 10 minutes), 1 h for `source=replay`; other views pass through. Concurrent requests for one key share one upstream call (single flight). If the upstream fails (5xx, 429, timeout) and a copy up to 24 h old exists, it is served with `x-views-cache: stale` and `x-views-age-s: N`, with the copy's own `x-query-id` and `x-executed-at`; it is never labelled fresh. A fresh read is `x-views-cache: miss` or `hit`. With no copy the upstream error goes through unchanged (502, or 503 when the agents are unreachable). Errors are never cached. Copies persist in Redis when `REDIS_URL` works (key prefix `floodsense:views:v1:`, same client as the answer cache) and always sit in memory; a restart with Redis keeps the last good copies. At startup a background thread reads each live view once, 5 s apart, skipping fresh copies (`VIEWS_CACHE_WARM=0` turns it off); `/health` never waits for it. `GET /system` carries `views_cache`: backend, hits, misses, stale serves and the last upstream error per view.

`app/system.py`. Read-only, safe to poll (the UI System page polls every 5 s), `Cache-Control: no-store`. It returns no URL, key, token or `.env` value, and every dependency degrades on its own (`ok: false` plus an `error` line), so the route answers 200 while the agents or engines are down.

| Field | What it says | Source |
|---|---|---|
| `cache` | `backend` (`redis` or `memory`), `keys` per prefix (`cache` = `floodsense:cache:v1:`, `replay` = `floodsense:replay:v1:`, `demo` = `floodsense:demo:v1:`; Redis SCAN, capped at 10 000; null when Redis does not answer), `hits`, `misses`, `replays_served`, `seeded_runs` (runs warmed by demo-seed) | this process |
| `rate_limit` | `runs_per_min_per_client` (10), `max_concurrent_runs` (2), `in_flight`, `rejected_429_recent` (last 5 min), `rejected_429_total` | this process |
| `engines` | `configured`, `ok`, H-MEM and World Model counts from the engines' `GET /health` | `ENGINES_URL` (Compose sets `http://engines:8300`) |
| `memory` | `count`, the newest 5 (`id`, `run_id`, `event_id`, `approved_at`, `text` cut to 160 chars, `label`, `seeded`) | engines `GET /hmem/memories` (read-only: no H-MEM query, so polling changes no access counts) |
| `world_model` | the newest run's board: `run_id`, `hypotheses`, `by_status`, the first 8 links | engines `GET /wm/board` |
| `models` | `lanes`, `flags`, `latest_model_ids` | agents `GET /config` and the newest run |
| `watch` | `ok`, `loop_enabled`, `interval_s`, `last_cycle_at`, `sources`, `elevated`, `events`, `awaiting_approval`, `auto_assess` (`enabled`, caps, used), `model_calls` | agents `GET /watch/status` |
| `rag` | `enabled` (`FF_RAG_DOCS`); `documents` and `passages` are null: no cheap count query is exposed yet | agents `GET /config` |

Counters (`counters_since_utc`) are in process (`app/metrics.py`) and reset when the API restarts. A memory is `seeded` when its provenance says `approved by demo-seed` or its run id starts with `demo-seed-`.

## Demo seed

In real use the system starts empty. For a recorded demo, `python tasks.py demo-seed` runs `python -m app.demo_seed seed` inside the api container (rebuild first: `python tasks.py up-all`):

- **Memory.** Three labelled runs (Valencia / Paiporta / Barranc del Poyo, Valencia exposure, Ahr / Altenahr) with five claims go to the engines' `POST /hmem/store`, the same endpoint write-on-approval uses. Reviewer `demo-seed`, `reviewer_note` "seeded for demo", run ids `demo-seed-*`, entity `demo-seed`. Texts and citations come from the recorded run `ui/src/fixtures/run_f16733274f1c.json` and, for the Ahr, from the floodsense_seed rows in `ui/src/fixtures/ahr_2021.json`. Re-running stores nothing twice. Inside a run, a recalled seeded memory stays labelled: `memory_used[].seeded` and `reviewer` (contracts `memory_used`), the memory trace note ("N demo seed, not analyst-approved"), and a `[demo seed]` prefix in the Investigator prompt. The seed questions are not eval questions, and `evals/run_evals.py` runs with H-MEM off, so seeded memories never reach an eval.
- **Cache.** The two newest runs in the agents that a person approved and the Judge passed (one per event first) get a cache entry (`AnswerCache.remember`) and a 30-day recording (`AnswerCache.record`) in Redis, plus the marker `floodsense:demo:v1:seeded`. Warmed entries get the recording TTL (`REPLAY_RECORDING_TTL_S`, 30 days) instead of the 15 min / 1 day cache TTL, so they do not expire before the recording; `/system` lists a warmed run only while its key is still in Redis. **The warm hit needs `FF_SEMANTIC_CACHE=true` in `api/.env`** (and the api container recreated); demo-seed reads the API's env and prints a warning when it is off. With it on, asking one of those questions again answers "Cached answer from HH:MM · not live · original run R". Nothing is invented: with no such run, or no Redis, seed says so and warms nothing.

`python tasks.py demo-reset` deletes the warmed keys and the marker. H-MEM has no delete route; to start memory empty, `python tasks.py down` and `docker volume rm floodsense-app_engines`.

`python tasks.py demo-ratelimit` sends 12 quick `POST /runs` with the body `[]` from the host to `127.0.0.1:${FLOODSENSE_API_PORT:-18000}` and prints each status and `Retry-After`. The bucket is taken before the body is read; a list is not a run request, so no run starts (the agents answer 422). The browser on the same machine shares that client bucket for up to a minute afterwards.
