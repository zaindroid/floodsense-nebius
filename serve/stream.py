"""Start a run without racing the edge.

Cloudflare answers 524 when an origin sends nothing for 100 seconds. It is a
time-to-first-byte rule, not a budget for the whole response: once bytes are
flowing the request may take as long as it needs, which is why the team's own
SSE route works through the same edge.

A run that calls a model six or seven times now passes 100 seconds often
enough to matter, so this route sends a line straight away and a heartbeat
while it waits. The run itself is the team's `POST /runs`, unchanged and still
reachable on its own path; nothing here touches the graph, the cache or the
labels. The last line of the stream is exactly what that endpoint returned.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

INNER = os.environ.get("INNER_API_URL", "http://127.0.0.1:8080/api").rstrip("/")
HEARTBEAT_S = float(os.environ.get("STREAM_HEARTBEAT_S", "10"))
RUN_TIMEOUT_S = float(os.environ.get("STREAM_RUN_TIMEOUT_S", "900"))

app = FastAPI(title="FloodSense EU — streamed runs")


def _line(payload: dict) -> bytes:
    return (json.dumps(payload, separators=(",", ":")) + "\n").encode()


async def _drive(body: bytes) -> AsyncIterator[bytes]:
    started = time.monotonic()
    yield _line({"event": "accepted", "note": "the run has started"})

    async with httpx.AsyncClient(timeout=RUN_TIMEOUT_S) as client:
        task = asyncio.create_task(
            client.post(
                f"{INNER}/runs",
                content=body,
                headers={"content-type": "application/json"},
            )
        )
        while True:
            done, _ = await asyncio.wait({task}, timeout=HEARTBEAT_S)
            if done:
                break
            yield _line({"event": "running", "elapsed_s": round(time.monotonic() - started, 1)})

        try:
            reply = task.result()
        except httpx.HTTPError as e:
            yield _line({"event": "error", "detail": f"{type(e).__name__}: {str(e)[:200]}"})
            return

    elapsed = round(time.monotonic() - started, 1)
    try:
        run = reply.json()
    except ValueError:
        yield _line({"event": "error", "status": reply.status_code, "body": reply.text[:400]})
        return
    # The run as the team's endpoint returned it, with the wait recorded beside
    # it rather than inside: nothing of theirs is rewritten here.
    yield _line({"event": "done", "status": reply.status_code, "elapsed_s": elapsed, "run": run})


@app.post("/runs")
async def runs(request: Request) -> StreamingResponse:
    body = await request.body()
    return StreamingResponse(
        _drive(body),
        media_type="application/x-ndjson",
        # Buffering here would hand the edge nothing to see and bring the 524
        # straight back.
        headers={"cache-control": "no-store", "x-accel-buffering": "no"},
    )
