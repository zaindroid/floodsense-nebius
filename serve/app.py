"""The one app this container serves.

Mounts the team's API under /api, the Nebius VM controls under /nebius and
the role-based UI (main's ui-merged) at /app/. The four endpoints the platform asks for live here,
because they describe the container rather than any one service inside it.
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.main import app as api_app  # api/app/main.py, mirrored from main
from serve import nebius
from serve.login import Login
from serve.stream import app as stream_app

AGENTS_URL = os.environ.get("AGENTS_URL", "http://127.0.0.1:8100").rstrip("/")
MERGED = Path(os.environ.get("UI_MERGED", "/srv/ui-merged")).resolve()

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


@app.get("/", include_in_schema=False)
def entry() -> FileResponse:
    # The front door: the two ways to try the demo. The app itself is at /app/.
    return FileResponse(nebius.PAGE, headers={"cache-control": "no-store"})


@app.get("/nebius", include_in_schema=False)
def nebius_page() -> RedirectResponse:
    return RedirectResponse("/")


@app.get("/app", include_in_schema=False)
def app_slash() -> RedirectResponse:
    return RedirectResponse("/app/")


class NoStore(StaticFiles):
    """The role UI's files are not fingerprinted, and the CDN raises no-cache to hours."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["cache-control"] = "no-store"
        return response


if MERGED.is_dir():
    # Hash routing and relative paths, so the folder works as it is under /app/.
    app.mount("/app", NoStore(directory=MERGED, html=True), name="app")
