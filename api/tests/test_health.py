"""Health endpoint for the API skeleton."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


class HealthTest(unittest.TestCase):
    def test_health_ok(self) -> None:
        response = TestClient(app).get("/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["service"], "floodsense-api")


if __name__ == "__main__":
    unittest.main()
