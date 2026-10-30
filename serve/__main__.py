"""Serve the demo: the entry page at /, the role UI at /app/, the API under /api."""

from __future__ import annotations

import os

import uvicorn

from serve.app import app

if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.environ.get("SERVE_HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
    )
