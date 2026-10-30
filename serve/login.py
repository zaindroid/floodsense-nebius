"""One login in front of the whole demo, the same one the Nebius VM uses.

Model calls spend Token Factory credit, so the demo is not open to anyone who
finds the address. The platform's own checks stay open.

Plain ASGI rather than BaseHTTPMiddleware, which buffers and mishandles the
event streams under /api/stream.
"""

from __future__ import annotations

import base64
import hmac
import os

OPEN_PATHS = {"/health", "/ready", "/version"}


class Login:
    def __init__(self, app) -> None:
        self.app = app
        self.user = os.environ.get("JUDGE_USER", "judge")
        self.password = os.environ.get("JUDGE_PASSWORD", "")

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or not self.password or scope.get("path") in OPEN_PATHS:
            await self.app(scope, receive, send)
            return
        if self._allowed(dict(scope.get("headers") or []).get(b"authorization", b"")):
            await self.app(scope, receive, send)
            return
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"www-authenticate", b'Basic realm="FloodSense EU demo", charset="UTF-8"'),
                    (b"content-type", b"text/plain; charset=utf-8"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": b"Log in with the judge account from the testing instructions.\n"})

    def _allowed(self, header: bytes) -> bool:
        scheme, _, value = header.partition(b" ")
        if scheme.lower() != b"basic":
            return False
        try:
            user, _, password = base64.b64decode(value).decode("utf-8").partition(":")
        except ValueError:
            return False
        # Bytes, not str: compare_digest refuses non-ASCII text, and a login
        # attempt must never be able to raise.
        ok_user = hmac.compare_digest(user.encode(), self.user.encode())
        ok_password = hmac.compare_digest(password.encode(), self.password.encode())
        return ok_user and ok_password
