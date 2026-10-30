"""The one app this container serves.

Mounts the team's API under /api, the Nebius VM controls under /nebius and
the built UI at /. The four endpoints the platform asks for live here,
because they describe the container rather than any one service inside it.
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.main import app as api_app  # api/app/main.py, mirrored from main
from serve import nebius
from serve.login import Login
from serve.stream import app as stream_app

AGENTS_URL = os.environ.get("AGENTS_URL", "http://127.0.0.1:8100").rstrip("/")
DIST = Path(os.environ.get("UI_DIST", "/srv/ui")).resolve()

app = FastAPI(title="FloodSense EU — console", version=api_app.version)
app.add_middleware(Login)


@app.on_event("startup")
async def _begin() -> None:
    nebius.begin()


@app.on_event("shutdown")
async def _end() -> None:
    await nebius.end()


@app.get("/health")
def health() -> dict[str, str]:
    """Process liveness only. It must not wait on anything behind it:
    a slow dependency here marks the whole node unhealthy."""
    return {"status": "ok", "service": "floodsense-console"}


@app.get("/ready")
async def ready() -> JSONResponse:
    """Ready when the graph behind the API answers, and not before."""
    checks: dict[str, str] = {}
    async with httpx.AsyncClient(timeout=3.0) as client:
        for name, url in (("agents", f"{AGENTS_URL}/ready"),):
            try:
                r = await client.get(url)
                checks[name] = "ok" if r.status_code == 200 else f"http {r.status_code}"
            except httpx.HTTPError as e:
                checks[name] = type(e).__name__
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse({"ready": ok, "checks": checks}, status_code=200 if ok else 503)


@app.get("/version")
def version() -> dict[str, str]:
    return {
        "sha": os.environ.get("GIT_SHA", "dev"),
        "built": os.environ.get("BUILT_AT", "unknown"),
        "source": os.environ.get("SOURCE_REF", "main"),
    }


# Order matters: /api/stream is claimed before /api, and /api before the UI
# takes everything else. The view paths are not claimed here any more -- the
# team's API serves GET /views/{name} itself since v0.16, and a mount in front
# of it would hide their implementation behind a copy of it.
app.mount("/api/stream", stream_app)
app.mount("/api", api_app)
app.mount("/nebius", nebius.app)


@app.get("/nebius", include_in_schema=False)
def nebius_page() -> RedirectResponse:
    # The mount only matches /nebius/...; the bare address is what people type.
    return RedirectResponse("/nebius/")


if DIST.is_dir():
    # html=True serves index.html for a bare directory. The console routes on
    # the hash, so there is no history fallback to arrange.
    app.mount("/", StaticFiles(directory=DIST, html=True), name="ui")
