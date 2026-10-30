"""POST /runs with a body that is not UTF-8 JSON is a 400, not a 500."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


class BadBodyTest(unittest.TestCase):
    def _post(self, raw: bytes):
        return TestClient(app, raise_server_exceptions=False).post(
            "/runs", content=raw, headers={"content-type": "application/json"}
        )

    def test_invalid_utf8_is_400(self) -> None:
        r = self._post(b'{"question": "\xff\xfe"}')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"detail": "request body must be UTF-8 JSON"})

    def test_invalid_json_is_400(self) -> None:
        r = self._post(b"{not json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json(), {"detail": "request body must be UTF-8 JSON"})


if __name__ == "__main__":
    unittest.main()
