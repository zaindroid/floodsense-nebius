"""Agents service. FastAPI on port 8100, unpublished; the API container proxies it.

Routes follow the contract in docs/GAMEPLAN.md. Every data response carries
served_from (live | cache | replay) and cached_at when it is not live.
Fake Zetaris, the seed schema, a replay clock, and a re-read are not live.
GET /health is liveness only and may say live. Other envelopes follow the
data plane. A run posted with replay_ts stays replay when it is read back.

The product UI is the Vite console in ``ui/`` (compose port 15173). This
service does not ship ``ui/app`` or ``ui/mock``. ``GET /`` and ``GET /console``
serve ``console.html``, a secondary operator page on this unpublished port.

GET  /  and  GET /console          secondary operator page (console.html)
GET  /desk/events                  every known event and the case standing on it
GET  /desk/events/{id}             one case; starts it if nobody has
GET  /runs/{id}/outbound           approved messages per exposed site (never sent from here)
GET  /runs/{id}/exposure.csv       exposed policies for the claims system
GET  /runs/{id}/verify             every agent step checked, plus which data path it used
GET  /runs/{id}/record             the decision record: answer, sources, scores, signature
POST /runs/{id}/dispatch           post the decision to DECISION_WEBHOOK, off unless set
GET  /views/{name}                  rows of one allowlisted contract view (bare JSON array)
GET  /watch/events                 control tower activity feed (?since=<id>&limit=N), oldest first
GET  /watch/stream                 SSE of new feed events (`watch` events; Last-Event-ID or ?since= resumes)
GET  /watch/status                 last scan, counts, loop and auto-assess switch with its caps
POST /watch/cycle                  one scan now (the console's "Scan now"), rate limited
POST /watch/auto-assess            {enabled: bool}: the auto-assess switch (default off; model calls)
GET  /health                       liveness: service, graph, version. Touches nothing.
GET  /ready                        readiness: Zetaris answers a trivial query (503 if not)
GET  /version                      build sha and timestamp
GET  /config                       flags, lanes, schema, checkpointer (no secrets)
GET  /readiness                    the eight foundations checked against the newest run
POST /runs                         RunRequest -> runs until the HITL interrupt; returns the run snapshot (status awaiting_approval)
POST /front-door                   200 ReplyResponse for small talk, else {kind: run}; no graph run
POST /runs?wait=false              202 {run_id, thread_id, status: running} at once; the graph runs in the background
GET  /runs/past                    runs started by this process, newest first (the checkpointer holds every run's state)
GET  /runs/{id}                    snapshot: contract state + claims, evidence, judge_summary, trace
GET  /runs/{id}/replay             the same run labelled as a replay (served_from replay, cached_at its start)
GET  /runs/{id}/approval           what the reviewer sees (409 unless awaiting approval)
POST /runs/{id}/approval           ApprovalDecision {action: approve|edit|reject, edits?, reviewer_note?, reviewer?} -> resumes the run
GET  /runs/{id}/citations          every citation record of the run plus the evidence and provenance they point at
GET  /runs/{id}/events             SSE: `started` per node as it begins (background runs), `trace` per finished step, then one `status` event

    python -m floodsense_agents            # host: http://127.0.0.1:8100
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import math
import os
import re
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from floodsense_agents import __version__
from floodsense_agents import desk, front_door, labelling, router, tower
from floodsense_agents.events import ALIASES, EVENTS, HAZARD_VIEWS, hazard_schema, spec
from floodsense_agents.models import ApprovalDecision, RunRequest
from floodsense_agents.nightshift import GLOBAL_USAGE, check_lanes
from floodsense_agents.readiness import report as readiness_report
from floodsense_agents.verify import report as verify_report
from floodsense_agents.runtime import NotAwaitingApproval, RunNotFound, Runtime, ThreadNotFound
from floodsense_agents.settings import settings
from floodsense_agents.zetaris import now_utc

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
app = FastAPI(title="FloodSense EU — agents", version=__version__)
CONSOLE = Path(__file__).resolve().parent / "console.html"
# The desk asks the graph the same thing every time; the operator picks the
# event, not the wording.
_DESK_QUESTION = desk.DESK_QUESTION
_rt: Runtime | None = None


def runtime() -> Runtime:
    global _rt
    if _rt is None:
        _rt = Runtime()
    return _rt


def set_runtime(rt: Runtime) -> None:
    global _rt
    _rt = rt


_tower: tower.ControlTower | None = None


def control_tower() -> tower.ControlTower:
    """The watch loop and its feed (tower.py). Built on first use, hooked into the run lifecycle."""
    global _tower
    if _tower is None:
        _tower = tower.ControlTower(lambda: runtime().deps.zetaris, runtime)
        runtime().observers.append(_tower.on_run)
    return _tower


def set_tower(t: tower.ControlTower | None) -> None:
    global _tower
    _tower = t
    if t is not None:
        rt = runtime()
        if t.on_run not in rt.observers:
            rt.observers.append(t.on_run)


@app.on_event("startup")
def _start_watch_loop() -> None:
    """FF_WATCH_LOOP (default on) starts the rule-based scan; FF_WATCH_LOOP=false leaves it off."""
    try:
        control_tower().start()
    except Exception:  # noqa: BLE001 - the service stays up without the loop
        logging.getLogger("floodsense.tower").exception("watch loop did not start")


def _envelope(body: dict) -> dict:
    """Label a response that is not itself a finished computation.

    Does not force live. FakeZetaris and the seed schema become replay.
    A caller that already set served_from keeps that value, so GET /health
    can stay a liveness check.
    """
    zetaris = None
    if _rt is not None and getattr(_rt, "deps", None) is not None:
        zetaris = _rt.deps.zetaris
    return labelling.labelled(body, zetaris=zetaris)


def _with_run_label(body: dict, run: dict) -> dict:
    """An envelope that holds a run uses that run's label, not a fresh live one."""
    body["served_from"] = run.get("served_from")
    body["cached_at"] = run.get("cached_at")
    body["run_id"] = run.get("run_id")
    return labelling.labelled(body)


def _stored(run_id: str) -> dict:
    """A snapshot of a run computed earlier. Serving it as live would be a lie.

    A clocked replay stays replay. Only a re-read with no replay clock is cache.

    The label comes from the in-memory index when this process has the row.
    After a restart that row is missing, so this records the snapshot it just
    read. It does not call past(), which lists every checkpoint.
    """
    rt = runtime()
    run = rt.snapshot(run_id)
    row = rt.index.get(run_id)
    if row is None:
        row = rt._remember(run_id, run)
    kind, at = labelling.reread_label(
        run.get("cached_at") or row.get("created_at"),
        replay_ts=run.get("replay_ts"),
    )
    run["served_from"] = kind
    run["cached_at"] = at
    return run


def _console() -> HTMLResponse:
    """Secondary operator page. The product UI is the Vite app, not this file."""
    if not CONSOLE.is_file():
        raise HTTPException(404, "operator console was not copied into the build")
    return HTMLResponse(
        CONSOLE.read_text(encoding="utf-8"),
        headers={"cache-control": "no-store, must-revalidate"},
    )


@app.get("/", include_in_schema=False)
def home():
    return _console()


@app.get("/console", include_in_schema=False)
def console():
    return _console()


@app.get("/desk/events", include_in_schema=False)
def desk_events():
    """What the desk opens on: every known event, and the case on it."""
    events = desk.events(runtime().past())
    body: dict = {"events": events}
    stamped = [e.get("updated_at") for e in events if e.get("run_id") and e.get("updated_at")]
    if stamped:
        # The list points at runs computed earlier. The catalog itself is not a live answer.
        body["served_from"] = labelling.CACHE
        body["cached_at"] = stamped[0]
    return _envelope(body)


@app.get("/desk/events/{event_id}", include_in_schema=False)
def desk_event(event_id: str):
    """The case for one event. Starts it if nobody has yet."""
    rt = runtime()
    row = next(
        (r for r in rt.past() if r.get("event_id") == event_id and desk.is_case(r)),
        None,
    )
    if row is not None:
        run = _stored(row["run_id"])
    else:
        try:
            run = rt.start(RunRequest(question=_DESK_QUESTION, event_id=event_id))
        except KeyError as e:
            raise HTTPException(400, str(e).strip('"')) from e
    run = labelling.labelled(run)
    return _with_run_label(
        {"run": run, "figures": desk.summarise(run), "released": desk.is_released(run)},
        run,
    )


_TIMELINE: dict[str, dict] = {}


@app.get("/desk/events/{event_id}/timeline", include_in_schema=False)
def desk_timeline(event_id: str):
    """The same question asked at each declared moment of the event.

    What was knowable when: the chain fills in, the footprint appears only
    once Copernicus published it, and the gauge going out is visible as the
    reading that stops rather than as a gap nobody mentions.
    """
    if event_id in _TIMELINE:
        cached = dict(_TIMELINE[event_id])
        cached["served_from"] = labelling.CACHE
        return labelling.labelled(cached)
    try:
        ev = spec(event_id)
    except KeyError as e:
        raise HTTPException(400, str(e).strip('"')) from e
    rt = runtime()
    points = []
    for ts, label in ev.moments:
        try:
            run = rt.start(RunRequest(question=_DESK_QUESTION, event_id=event_id, replay_ts=ts))
            point = desk.moment(run)
        except Exception as e:  # noqa: BLE001 - one bad moment must not lose the rest
            point = {"replay_ts": ts, "error": f"{type(e).__name__}: {e}"[:160]}
        point["label"] = label
        points.append(point)
    body = {
        "event_id": event_id,
        "name": ev.name,
        "footprint_published_utc": ev.footprint_published_utc,
        "moments": points,
        # Each moment is a replay of the event. The first response is that
        # replay; a later read of this dict is cache (see the branch above).
        "served_from": labelling.REPLAY,
        "cached_at": now_utc(),
    }
    _TIMELINE[event_id] = body
    return labelling.labelled(dict(body))


@app.get("/desk/dispatch-target", include_in_schema=False)
def desk_dispatch_target():
    raw = desk.webhook_target()
    target = raw if raw and desk.is_https_url(raw) else None
    return _envelope({"configured": target is not None, "target": target})


def _released_run(run_id: str) -> dict:
    run = _stored(run_id)
    if not desk.is_released(run):
        raise HTTPException(409, "nothing is released until a reviewer approves or edits")
    return run


@app.get("/runs/{run_id}/outbound", include_in_schema=False)
def run_outbound(run_id: str):
    """The messages, rendered. This endpoint does not send them."""
    run = _released_run(run_id)
    return _with_run_label({"messages": desk.outbound(run)}, run)


@app.get("/runs/{run_id}/exposure.csv", include_in_schema=False)
def run_exposure_csv(run_id: str):
    return PlainTextResponse(
        desk.exposure_csv(_released_run(run_id)),
        media_type="text/csv",
        headers={"content-disposition": f'attachment; filename="exposure-{run_id}.csv"'},
    )


@app.get("/runs/{run_id}/verify", include_in_schema=False)
def run_verify(run_id: str):
    """Every agent step, checked against the run's own record."""
    return _envelope(verify_report(_stored(run_id)))


@app.get("/runs/{run_id}/record", include_in_schema=False)
def run_record(run_id: str):
    return _envelope(desk.record(_stored(run_id)))


@app.post("/runs/{run_id}/dispatch", include_in_schema=False)
def run_dispatch(run_id: str):
    """Post the decision to the nominated endpoint. Off unless one is set."""
    run = _released_run(run_id)
    return _with_run_label(desk.dispatch(run), run)


@app.get("/readiness", include_in_schema=False)
def readiness(run_id: str | None = None):
    """The eight foundations, checked against one run. Newest run by default."""
    rt = runtime()
    if run_id is None:
        past = rt.past(limit=1)
        run_id = past[0]["run_id"] if past else None
    run = _stored(run_id) if run_id else {}
    routes = {getattr(r, "path", "") for r in app.routes}
    return _envelope(readiness_report(run, rt.deps, routes))


def _dep_name(rt: Runtime, attr: str) -> str:
    return type(getattr(rt.deps, attr, None)).__name__ if rt.deps else "injected"


@app.get("/health")
def health():
    # Liveness only. A slow probe here marks every app on the node unhealthy.
    # served_from live here is the process, not a Zetaris answer. Data-plane
    # routes leave it unset so FakeZetaris cannot inherit this label.
    return labelling.labelled(
        {
            "status": "ok",
            "service": "floodsense-agents",
            "graph": "compiled",
            "version": __version__,
            "served_from": labelling.LIVE,
            "cached_at": None,
        }
    )


@app.get("/ready")
def ready():
    rt = runtime()
    try:
        probe = rt.deps.zetaris.run_sql("SELECT 1")
    except Exception as e:
        raise HTTPException(503, f"zetaris unreachable: {type(e).__name__}")
    # run_sql reports a failed read on Evidence.error. It does not raise.
    if probe is None or getattr(probe, "error", None):
        detail = getattr(probe, "error", None) or "no result"
        raise HTTPException(503, f"zetaris unreachable: {detail}")
    return _envelope(
        {
            "status": "ready",
            "llm": _dep_name(rt, "llm"),
            "llm_backend": settings.llm_backend,
            # Not under flags (flags are in the API cache key). Only the switch, never the key.
            "tavily": settings.ff_tavily,
            "data_backend": "zetaris",  # the only data path; no local backend on main
            "zetaris": _dep_name(rt, "zetaris"),
            "memory": _dep_name(rt, "memory"),
            "world_model": _dep_name(rt, "world"),
        }
    )


@app.get("/version")
def version():
    return _envelope({"sha": settings.git_sha, "built": settings.built_at, "version": __version__})


_last_llm_check: dict | None = None


@app.post("/llm/check")
def llm_check():
    """Live lane check: one tiny call per lane (costs a few tokens). Cached into GET /config."""
    global _last_llm_check
    _last_llm_check = check_lanes(runtime().deps.llm)
    return _envelope(_last_llm_check)


@app.get("/config")
def config():
    return _envelope(
        {
            "flags": {
                "FF_LIVE_DATA": settings.live_data,
                "FF_SKEPTIC": settings.ff_skeptic,
                "FF_JUDGE": settings.ff_judge,
                "FF_HITL": settings.ff_hitl,
                "FF_HMEM": settings.ff_hmem,
                "FF_RAG_DOCS": settings.ff_rag_docs,
                # Router quick lane: part of the API cache fingerprint (app/cache.py).
                "FF_QUICK_LANE": router.enabled(),
                # Router forecast lane (nodes/forecast.py): also part of the fingerprint.
                "FF_FORECAST_LANE": router.forecast_enabled(),
            },
            "llm_backend": settings.llm_backend,
            "lanes": {"fast": settings.lane("fast"), "deep": settings.lane("deep")},
            "llm_check": _last_llm_check,
            "llm_usage": GLOBAL_USAGE.as_dict(),
            "engines_url": settings.engines_url,
            "schema": settings.schema,
            "checkpointer": settings.checkpointer,
            "skeptic_max_rounds": settings.skeptic_max_rounds,
            "judge_repair_rounds": settings.judge_repair_rounds,
            "judge_min_score": settings.judge_min_score,
            "events": ["EMSR773", "EMSR517"],
            # Control tower: the rule-based watch loop and the auto-assess switch with its caps.
            # Not under flags: the switch moves at runtime and flags are in the API cache key.
            "watch": _watch_config(),
        }
    )


def _watch_config() -> dict:
    t = control_tower()
    a = t.auto_status()
    return {
        "FF_WATCH_LOOP": t.loop_enabled,
        "interval_s": t.interval_s,
        "FF_AUTO_ASSESS": a["enabled"],
        "auto_assess_per_hour": a["per_hour"],
        "auto_assess_per_day": a["per_day"],
    }


def _front_door_reply(req: RunRequest) -> dict | None:
    rt = runtime()
    llm = getattr(rt.deps, "llm", None) if getattr(rt, "deps", None) is not None else None
    return front_door.front_door(req, llm)


@app.post("/front-door")
def front_door_check(req: RunRequest):
    """The front door alone: 200 ReplyResponse, or 200 {"kind": "run"} for the full run.

    The API calls this before it spends a concurrency slot or a cache lookup.
    """
    reply = _front_door_reply(req)
    return reply if reply is not None else {"kind": "run"}


@app.post("/runs", status_code=201)
def start_run(req: RunRequest, wait: bool = True, front_door: bool = True):
    """wait=true (default): run to the HITL pause and return the snapshot (201).

    wait=false: 202 {run_id, thread_id, status: running} at once; the graph runs
    in the background. Follow it on GET /runs/{id}/events or poll GET /runs/{id}.

    Either way a greeting, help, thanks or off-topic message gets a 200
    ReplyResponse ({"kind": "reply", ...}, no run_id) without a graph run.
    front_door=false skips that check (the API has already made it).
    """
    if front_door:
        reply = _front_door_reply(req)
        if reply is not None:
            return JSONResponse(reply, status_code=200)
    try:
        if not wait:
            accepted = runtime().start_async(req)
            return JSONResponse(_envelope(accepted), status_code=202)
        return _envelope(runtime().start(req))
    except ThreadNotFound as e:
        raise HTTPException(404, f"thread {e.args[0]} not found; omit thread_id to start one")
    except KeyError as e:
        raise HTTPException(422, str(e))


@app.get("/runs/past")
def past_runs(limit: int = 50, thread_id: str | None = None):
    return _envelope({"runs": runtime().past(limit, thread_id=thread_id)})


@app.get("/runs/{run_id}")
def get_run(run_id: str):
    try:
        return _envelope(_stored(run_id))
    except RunNotFound:
        raise HTTPException(404, f"run {run_id} not found")


@app.get("/runs/{run_id}/replay")
def replay_run(run_id: str):
    """A recorded run, labelled as a replay.

    cached_at is the run's start. The row comes from the in-memory index, or
    from the snapshot just read after a restart. This does not call past(),
    which lists every checkpoint and deadlocks the shared SqliteSaver.
    """
    rt = runtime()
    try:
        run = rt.snapshot(run_id)
    except RunNotFound:
        raise HTTPException(404, f"run {run_id} not found")
    row = rt.index.get(run_id)
    if row is None:
        row = rt._remember(run_id, run)
    run["served_from"] = labelling.REPLAY
    run["cached_at"] = row.get("created_at")
    return _envelope(run)


@app.get("/runs/{run_id}/approval")
def get_approval(run_id: str):
    try:
        return _envelope(runtime().approval(run_id))
    except RunNotFound:
        raise HTTPException(404, f"run {run_id} not found")
    except NotAwaitingApproval as e:
        raise HTTPException(409, str(e))


def _check_edit(run: dict, decision: ApprovalDecision) -> None:
    """422 unless an edit changes something, and only outbound drafts of this run."""
    drafts = decision.draft_messages or {}
    outbound = {a.get("action_id"): a for a in run.get("playbook") or [] if a.get("outbound")}
    for aid, text in drafts.items():
        if not (text or "").strip():
            raise HTTPException(422, f"draft_messages[{aid}] is empty")
        if aid not in outbound:
            raise HTTPException(422, f"{aid} is not an outbound action of this run")
    summary = (decision.edits or "").strip()
    changes_summary = bool(summary) and summary != (run.get("summary") or "").strip()
    changes_draft = any(
        text.strip() != (outbound[aid].get("draft_message") or "").strip()
        for aid, text in drafts.items()
    )
    if not (changes_summary or changes_draft):
        raise HTTPException(422, "action=edit must change the summary or a draft_message")


@app.post("/runs/{run_id}/approval")
def post_approval(run_id: str, decision: ApprovalDecision):
    if decision.action != "edit" and decision.draft_messages:
        raise HTTPException(422, "draft_messages go with action=edit only")
    if decision.action == "edit":
        try:
            run = runtime().snapshot(run_id)
        except RunNotFound:
            raise HTTPException(404, f"run {run_id} not found")
        if run["status"] == "awaiting_approval":  # otherwise resume answers 409
            _check_edit(run, decision)
    try:
        return _envelope(runtime().resume(run_id, decision))
    except RunNotFound:
        raise HTTPException(404, f"run {run_id} not found")
    except NotAwaitingApproval as e:
        raise HTTPException(409, str(e))


@app.get("/runs/{run_id}/citations")
def get_citations(run_id: str):
    try:
        return _envelope(runtime().citations(run_id))
    except RunNotFound:
        raise HTTPException(404, f"run {run_id} not found")


@app.get("/runs/{run_id}/events")
async def events(run_id: str):
    rt = runtime()
    try:
        rt.snapshot(run_id)
    except RunNotFound:
        raise HTTPException(404, f"run {run_id} not found")

    async def gen():
        sent, begun, t0 = 0, 0, time.time()
        while time.time() - t0 < 900:
            try:
                s = await asyncio.to_thread(rt.snapshot, run_id)
            except RunNotFound:
                # A background run that died before its first checkpoint.
                gone = {
                    "run_id": run_id,
                    "status": "not_found",
                    "served_from": None,
                    "cached_at": None,
                }
                yield f"event: status\ndata: {json.dumps(gone)}\n\n"
                return
            # Background runs only: a node has begun but not yet written its entry.
            starts = rt.started(run_id)
            for ev in starts[begun:]:
                yield f"event: started\ndata: {json.dumps(ev)}\n\n"
            begun = len(starts)
            for ev in s["trace"][sent:]:
                yield f"event: trace\ndata: {json.dumps(ev)}\n\n"
            sent = len(s["trace"])
            if s["status"] != "running":
                done = {
                    "run_id": run_id,
                    "status": s["status"],
                    "served_from": s["served_from"],
                    "cached_at": s["cached_at"],
                }
                yield f"event: status\ndata: {json.dumps(done)}\n\n"
                return
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream")


STREAM_MAX_S = 900.0  # one SSE connection lives this long; the client reconnects with Last-Event-ID
STREAM_POLL_S = 1.0
STREAM_MAX_CONNECTIONS = 20  # open /watch/stream connections; more get 429
_streams = 0


class AutoAssess(BaseModel):
    enabled: bool


def _watch_envelope(body: dict) -> dict:
    return _envelope(body)


@app.get("/watch/events")
def watch_events(since: str | None = None, limit: int = 100):
    """The activity feed, oldest first. ``since`` is an event id; without it, the newest ``limit``."""
    t = control_tower()
    return _watch_envelope(
        {"events": t.store.since(since, limit), "latest_id": t.store.latest_id()}
    )


@app.get("/watch/status")
def watch_status():
    return _watch_envelope(control_tower().status())


@app.post("/watch/cycle")
def watch_cycle():
    """One scan now. Answers 202 at once with the status; the scan runs on a thread and its events
    arrive in the feed. 429 when one was requested a moment ago; a scan already running is reported."""
    t = control_tower()
    out = t.force()
    if not out.get("ran") and out.get("retry_after_s"):
        return JSONResponse(
            _watch_envelope({"detail": out["reason"], "cycle": out, "status": t.status()}),
            status_code=429,
            headers={"Retry-After": str(out["retry_after_s"])},
        )
    return JSONResponse(
        _watch_envelope({"cycle": out, "status": t.status()}),
        status_code=202 if out.get("started") else 200,
    )


def _admin_ok(token: str | None) -> bool:
    """WATCH_ADMIN_TOKEN, when set, is required (header x-watch-admin-token) to change the switch."""
    want = os.environ.get("WATCH_ADMIN_TOKEN") or ""
    return not want or hmac.compare_digest(want.encode(), (token or "").encode())


@app.post("/watch/auto-assess")
def watch_auto_assess(body: AutoAssess, x_watch_admin_token: str | None = Header(default=None)):
    """The auto-assess switch (model calls, capped). Resets to FF_AUTO_ASSESS when the service restarts.

    401 without the admin token when WATCH_ADMIN_TOKEN is set; 409 when switching on would be unsafe
    (nothing is saved between restarts, so the caps could not hold).
    """
    if not _admin_ok(x_watch_admin_token):
        raise HTTPException(401, "this switch needs the admin token (x-watch-admin-token)")
    t = control_tower()
    if body.enabled and t.persisted_reason is not None:
        raise HTTPException(409, f"auto-assess stays off: {t.persisted_reason}")
    t.set_auto_assess(body.enabled)
    return _watch_envelope(t.status())


@app.get("/watch/stream")
async def watch_stream(request: Request, since: str | None = None):
    """SSE: every new feed event as `event: watch` with its id, plus a comment heartbeat.

    Resumes after ``?since=`` or the Last-Event-ID header; a fresh client starts at "now".
    """
    global _streams
    t = control_tower()
    if _streams >= STREAM_MAX_CONNECTIONS:
        return JSONResponse(
            {"detail": "too many open feed streams"}, status_code=429, headers={"Retry-After": "30"}
        )
    cursor = since or request.headers.get("last-event-id") or t.store.latest_id()
    _streams += 1

    async def gen():
        global _streams
        try:
            async for chunk in _stream_body():
                yield chunk
        finally:
            _streams -= 1

    async def _stream_body():
        nonlocal cursor
        t0, last_beat = time.time(), time.time()
        yield "retry: 3000\n\n"
        while time.time() - t0 < STREAM_MAX_S:
            if await request.is_disconnected():
                return
            fresh = t.store.since(cursor or "w0", 100)
            for ev in fresh:
                cursor = ev["id"]
                yield f"id: {ev['id']}\nevent: watch\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
                last_beat = time.time()
            if time.time() - last_beat > 15:
                yield ": keep-alive\n\n"
                last_beat = time.time()
            await asyncio.sleep(STREAM_POLL_S)

    return StreamingResponse(
        gen(), media_type="text/event-stream", headers={"cache-control": "no-store"}
    )


# GET /views/{name}. Column types from contracts/views.yaml. Only these names
# reach SQL, and only as identifiers from this dict, never from the request.
_NUM, _BOOL = "double", "boolean"
VIEW_COLUMNS: dict[str, dict[str, str]] = {
    "discharge_daily": {"discharge_m3s": _NUM},
    "hazard_timeline": {"rain_mm": _NUM, "discharge_m3s": _NUM},
    "hazard_now": {"rain_mm": _NUM, "discharge_m3s": _NUM},
    "gauge_levels": {
        k: _NUM
        for k in (
            "level_cm",
            "river_km",
            "lat",
            "lon",
            "trend_cm_h",
            "mnw_cm",
            "mw_cm",
            "mhw_cm",
            "hhw_cm",
            "hsw_cm",
        )
    }
    | {"is_stale": _BOOL},
    "exposure_join": {"lat": _NUM, "lon": _NUM, "sum_insured_eur": _NUM, "in_footprint": _BOOL},
    "eu_watch": {
        k: _NUM for k in ("lat", "lon", "discharge_m3s", "forecast_max_m3s", "past30_median_m3s")
    },
    "weather_forecast": {k: _NUM for k in ("lat", "lon", "lead_h", "precip_mm")},
    "provenance": {},
}
# No contract view has an event_id column today; the filter applies only if one does.
_EVENT_VIEWS: frozenset[str] = frozenset()
VIEW_ROW_LIMIT = 5000
_EVENT_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def _coerce(value, kind: str):
    """Zetaris REST returns strings. Numbers and booleans go back to their types."""
    if value is None or value == "":
        return None
    if kind == _NUM:
        try:
            out = float(value)
        except (TypeError, ValueError):
            return None
        return out if math.isfinite(out) else None
    if kind == _BOOL:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        text = str(value).strip().lower()
        if text in ("true", "t", "1", "yes"):
            return True
        if text in ("false", "f", "0", "no"):
            return False
        return None  # unknown: the row is dropped, never guessed False
    return value


# Fields the UI row validators (ui/src/lib/validate.ts) require. parseRows
# rejects the whole array when one row fails, so such rows are dropped here.
_REQUIRED: dict[str, tuple[str, ...]] = {
    "discharge_daily": ("point_id", "date", "discharge_m3s", "source"),
    "hazard_timeline": ("point_id", "ts_utc", "rain_mm"),
    "hazard_now": ("point_id", "ts_utc", "rain_mm"),
    "gauge_levels": ("station", "ts_utc"),
    "exposure_join": (
        "policy_id",
        "site_id",
        "lat",
        "lon",
        "in_footprint",
        "sum_insured_eur",
        "segment",
    ),
    "eu_watch": ("point_id", "name", "river", "lat", "lon", "band"),
    "weather_forecast": ("point_id", "name", "lat", "lon", "lead_h", "ts_utc", "precip_mm"),
    "provenance": ("dataset", "source_url", "publisher", "licence", "attribution", "fetched_at"),
}


def _usable(name: str, row: dict) -> bool:
    for key in _REQUIRED[name]:
        value = row.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            return False
    if name == "provenance":
        url = str(row["source_url"]).strip().lower()
        return url.startswith(("https://", "http://"))
    return True


# ?source=replay: the views an event replay reads (events.hazard_schema), whatever
# FF_LIVE_DATA says. The live floodsense hazard views hold Valencia only; the Ahr
# 2021 extract (migrations 051/052) is in floodsense_seed.


def _replay_from(name: str, event_id: str | None) -> tuple[str, str]:
    """(schema, WHERE clause) for a replay read of one hazard view, or HTTP 4xx."""
    if name not in HAZARD_VIEWS:
        raise HTTPException(422, f"source=replay serves {', '.join(HAZARD_VIEWS)} only")
    key = ALIASES.get(event_id or "", event_id or "")
    if key not in EVENTS or not EVENTS[key].point_ids:
        raise HTTPException(422, f"source=replay needs event_id, one of {', '.join(EVENTS)}")
    schema = hazard_schema(EVENTS[key].as_dict(), "floodsense_seed")
    ids = ", ".join(f"'{p}'" for p in EVENTS[key].point_ids)
    return schema, f" WHERE point_id IN ({ids})"


@app.get("/views/{name}")
def get_view(name: str, event_id: str | None = None, source: str | None = None):
    """Rows of one contract view, from the schema the graph reads (FF_LIVE_DATA).

    source=replay reads the event's replay schema (floodsense_seed for the Ahr)
    for hazard_timeline / discharge_daily, filtered to that event's point ids.
    """
    types = VIEW_COLUMNS.get(name)
    if types is None:
        raise HTTPException(404, f"unknown view {name!r}")
    if source not in (None, "", "replay"):
        raise HTTPException(422, "source must be 'replay' or absent")
    schema, where = settings.schema, ""
    if source == "replay":
        schema, where = _replay_from(name, event_id)
    sql = f"SELECT * FROM {schema}.{name}{where}"
    if event_id is not None and name in _EVENT_VIEWS and not where:
        if not _EVENT_ID.fullmatch(event_id):
            raise HTTPException(422, "event_id must be letters, digits, _ or -")
        sql += f" WHERE event_id = '{event_id}'"
    # One extra row tells a full view from a capped one.
    sql += f" LIMIT {VIEW_ROW_LIMIT + 1}"
    ev = runtime().deps.zetaris.run_sql(sql, sample=VIEW_ROW_LIMIT + 1)
    if getattr(ev, "error", None):
        logging.getLogger("floodsense.views").warning(
            "view %s read failed (query %s): %s", name, ev.query_id, ev.error
        )
        raise HTTPException(502, f"could not read view {name}")
    fetched = ev.rows_sample
    truncated = len(fetched) > VIEW_ROW_LIMIT
    coerced = [
        {k: (_coerce(v, types[k]) if k in types else v) for k, v in row.items()}
        for row in fetched[:VIEW_ROW_LIMIT]
    ]
    rows = [r for r in coerced if _usable(name, r)]
    headers = {
        "x-query-id": ev.query_id,
        "x-schema": schema,
        "x-source": "replay" if source == "replay" else "configured",
        "x-executed-at": ev.executed_at_utc,
        "x-dropped-rows": str(len(coerced) - len(rows)),
        "cache-control": "no-store",
    }
    if truncated:
        headers["x-truncated"] = "true"
    return JSONResponse(rows, headers=headers)


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
