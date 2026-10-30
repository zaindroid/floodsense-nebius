"""Start and stop the Nebius AI Cloud copy of the demo on request.

The VM costs credit by the hour, so it sleeps until someone asks for it and
goes back to sleep after NEBIUS_AUTO_STOP_MIN. This module holds only the
instance-power-operator key: it can start, stop and read that one VM and
nothing else.

Unconfigured (no NEBIUS_INSTANCE_ID), every route answers and says so rather
than failing, so the page can ship before the key exists.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, RedirectResponse

log = logging.getLogger("serve.nebius")

INSTANCE_ID = os.environ.get("NEBIUS_INSTANCE_ID", "").strip()
DEMO_URL = os.environ.get("NEBIUS_DEMO_URL", "").strip().rstrip("/")
AUTO_STOP_MIN = int(os.environ.get("NEBIUS_AUTO_STOP_MIN", "120") or 0)
EXTEND_MIN = 60
PAGE = Path(__file__).with_name("nebius.html")

app = FastAPI(title="FloodSense EU — Nebius VM", docs_url=None, redoc_url=None, openapi_url=None)

_sdk = None
_service = None
_lock = asyncio.Lock()
# When the VM goes back to sleep. Held in memory: after a restart of this
# server a running VM gets a fresh deadline, so it can never be left on.
_stop_at: float | None = None


def configured() -> bool:
    return bool(INSTANCE_ID and _credentials())


def _credentials() -> dict[str, str] | None:
    """The service account key, as a credentials file or as three values."""
    whole = os.environ.get("NEBIUS_SA_CREDENTIALS", "").strip()
    if whole:
        return {"credentials_file_name": _secret_file("credentials.json", whole)}
    sa = os.environ.get("NEBIUS_SA_ID", "").strip()
    key_id = os.environ.get("NEBIUS_SA_PUBLIC_KEY_ID", "").strip()
    # Base64 survives the platform's env store, which escapes backslashes and
    # so turned a "\n"-joined PEM into one that no longer parses.
    b64 = os.environ.get("NEBIUS_SA_PRIVATE_KEY_B64", "").strip()
    pem = base64.b64decode(b64).decode() if b64 else os.environ.get("NEBIUS_SA_PRIVATE_KEY", "").strip()
    if sa and key_id and pem:
        return {
            "service_account_id": sa,
            "service_account_public_key_id": key_id,
            "service_account_private_key_file_name": _secret_file("private.pem", pem.replace("\\n", "\n") + "\n"),
        }
    return None


def _secret_file(name: str, content: str) -> str:
    """The SDK reads keys from files; keep the copy readable by this process only."""
    path = Path(tempfile.gettempdir()) / f"nebius-{name}"
    path.touch(mode=0o600)
    path.write_text(content)  # always the current value, never a stale one
    return str(path)


async def _instances():
    global _sdk, _service
    async with _lock:
        if _service is None:
            from nebius.api.nebius.compute.v1 import InstanceServiceClient
            from nebius.sdk import SDK

            _sdk = SDK(user_agent_prefix="floodsense-nebius/1.0", **_credentials())
            _service = InstanceServiceClient(_sdk)
    return _service


async def _instance():
    from nebius.api.nebius.compute.v1 import GetInstanceRequest

    return await (await _instances()).get(GetInstanceRequest(id=INSTANCE_ID))


def _state(instance) -> str:
    return instance.status.state.name if instance.status else "UNSPECIFIED"


def _public_ip(instance) -> str | None:
    for nic in instance.status.network_interfaces if instance.status else []:
        addr = getattr(nic.public_ip_address, "address", "") if nic.public_ip_address else ""
        if addr:
            return addr.split("/")[0]
    return None


async def _demo_answers() -> bool:
    """The VM can be RUNNING a minute before its containers answer."""
    if not DEMO_URL:
        return False
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            return (await client.get(f"{DEMO_URL}/healthz")).status_code == 200
    except httpx.HTTPError:
        return False


def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if ts else None


@app.get("/")
def page() -> FileResponse:
    return FileResponse(PAGE, headers={"cache-control": "no-store"})


@app.get("/api/status")
async def status() -> dict:
    if not configured():
        return {"configured": False, "state": "NOT_CONFIGURED", "demo_url": DEMO_URL or None}
    try:
        inst = await _instance()
    except Exception as e:  # noqa: BLE001 - the page shows it rather than a 500
        log.warning("nebius status failed: %s", e)
        return {"configured": True, "state": "UNKNOWN", "error": type(e).__name__, "demo_url": DEMO_URL}
    state = _state(inst)
    ip = _public_ip(inst)
    ready = state == "RUNNING" and await _demo_answers()
    return {
        "configured": True,
        "state": state,
        "ready": ready,
        "demo_url": DEMO_URL,
        "public_ip": ip,
        # A dynamic IP changes on restart, and the demo address and its certificate name the old one.
        "ip_matches_url": bool(ip and DEMO_URL and ip.replace(".", "-") in DEMO_URL),
        "stops_at": _iso(_stop_at) if state in ("RUNNING", "STARTING") else None,
        "auto_stop_min": AUTO_STOP_MIN,
    }


def _require():
    if not configured():
        raise HTTPException(503, "The Nebius VM controls are not configured yet.")


@app.post("/api/start")
async def start() -> dict:
    global _stop_at
    _require()
    from nebius.api.nebius.compute.v1 import StartInstanceRequest

    state = _state(await _instance())
    if state in ("STOPPED", "ERROR"):
        await (await _instances()).start(StartInstanceRequest(id=INSTANCE_ID))
        log.info("nebius: start requested")
    if AUTO_STOP_MIN > 0:
        _stop_at = time.time() + AUTO_STOP_MIN * 60
    return {"requested": state in ("STOPPED", "ERROR"), "was": state, "stops_at": _iso(_stop_at)}


@app.get("/start")
async def start_and_return() -> RedirectResponse:
    """The entry page links here: the browser asks for the login, then comes back
    to a page that opens the Nebius demo by itself once the VM is ready."""
    await start()
    return RedirectResponse("/?go=nebius", status_code=303)


@app.post("/api/stop")
async def stop() -> dict:
    global _stop_at
    _require()
    _stop_at = None
    return await _stop_now("asked")


@app.post("/api/extend")
async def extend() -> dict:
    global _stop_at
    _require()
    base = max(_stop_at or 0, time.time())
    _stop_at = base + EXTEND_MIN * 60
    return {"stops_at": _iso(_stop_at)}


async def _stop_now(why: str) -> dict:
    from nebius.api.nebius.compute.v1 import StopInstanceRequest

    state = _state(await _instance())
    if state in ("RUNNING", "STARTING"):
        await (await _instances()).stop(StopInstanceRequest(id=INSTANCE_ID))
        log.info("nebius: stop requested (%s)", why)
    return {"requested": state in ("RUNNING", "STARTING"), "was": state}


async def _watch() -> None:
    """Put the VM back to sleep at its deadline, and give a deadline to one that has none."""
    global _stop_at
    while True:
        await asyncio.sleep(60)
        if not configured() or AUTO_STOP_MIN <= 0:
            continue
        try:
            state = _state(await _instance())
            if state == "RUNNING" and _stop_at is None:
                _stop_at = time.time() + AUTO_STOP_MIN * 60
            elif state == "RUNNING" and time.time() >= (_stop_at or 0):
                await _stop_now("auto-stop")
                _stop_at = None
        except Exception as e:  # noqa: BLE001 - the watcher must outlive a bad minute
            log.warning("nebius watcher: %s", e)


# A mounted app's own startup events never fire, so the server that mounts
# this one starts the watcher and closes the SDK.
def begin() -> None:
    asyncio.get_running_loop().create_task(_watch())


async def end() -> None:
    if _sdk is not None:
        await _sdk.close()
