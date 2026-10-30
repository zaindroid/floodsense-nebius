"""NIM embeddings client. No network. The key never appears in an error."""

from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import floodsense_agents.nim_embed as nim_embed  # noqa: E402


class NimEmbedTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_cache_hit_does_not_call_nim(self) -> None:
        root = Path(self.tmp.name)
        text = "Paiporta recorded rain."
        path = nim_embed.cache_path(root, "passage", text)
        path.parent.mkdir(parents=True)
        vector = [0.0] * 2047 + [1.0]
        path.write_text(json.dumps({"embedding": vector}), encoding="utf-8")

        def opener(url, headers, body):
            raise AssertionError(body)

        got = nim_embed.embed_texts([text], "passage", root=root, api_key="test-key", opener=opener)
        self.assertEqual(got, [vector])
        self.assertEqual(
            path.relative_to(root).as_posix(),
            "corpus/.embed-cache/nvidia/nemotron-3.5-embed-1b/2048/passage/"
            + hashlib.sha256(text.encode()).hexdigest()
            + ".json",
        )

    def test_request_body_and_key_stay_out_of_errors(self) -> None:
        root = Path(self.tmp.name)

        def opener(url, headers, body):
            self.assertEqual(url, nim_embed.DEFAULT_URL)
            self.assertEqual(headers["Authorization"], "Bearer test-key")
            payload = json.loads(body)
            self.assertEqual(payload["model"], "nvidia/nemotron-3.5-embed-1b")
            self.assertEqual(payload["input_type"], "query")
            self.assertEqual(payload["dimensions"], 2048)
            self.assertEqual(payload["input"], ["where was the rain"])
            raise nim_embed.EmbedError("NIM embeddings HTTP 401")

        with self.assertRaises(nim_embed.EmbedError) as caught:
            nim_embed.embed_texts(
                ["where was the rain"], "query", root=root, api_key="test-key", opener=opener
            )
        self.assertNotIn("test-key", str(caught.exception))

    def test_miss_reorders_by_index_and_writes_the_cache(self) -> None:
        root = Path(self.tmp.name)
        cached = "cached passage"
        path = nim_embed.cache_path(root, "passage", cached)
        path.parent.mkdir(parents=True)
        cached_vector = [0.0] * 2047 + [2.0]
        path.write_text(json.dumps({"embedding": cached_vector}), encoding="utf-8")
        fresh = "fresh passage"
        fresh_vector = [0.0] * 2047 + [3.0]

        def opener(url, headers, body):
            payload = json.loads(body)
            self.assertEqual(payload["input"], [fresh])
            self.assertNotIn("test-key", body.decode())
            return {"data": [{"index": 0, "embedding": fresh_vector}]}

        got = nim_embed.embed_texts(
            [fresh, cached], "passage", root=root, api_key="test-key", opener=opener
        )
        self.assertEqual(got, [fresh_vector, cached_vector])
        written = json.loads(
            nim_embed.cache_path(root, "passage", fresh).read_text(encoding="utf-8")
        )
        self.assertEqual(written["embedding"], fresh_vector)

    def test_default_opener_names_the_status_and_hides_the_key(self) -> None:
        root = Path(self.tmp.name)

        def fake_urlopen(request, timeout=0):
            raise urllib.error.HTTPError(
                request.full_url,
                401,
                "unauthorized",
                hdrs=None,
                fp=io.BytesIO(b"test-key"),
            )

        with patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(nim_embed.EmbedError) as caught:
                nim_embed.embed_texts(["rain"], "query", root=root, api_key="test-key")
        self.assertEqual(str(caught.exception), "NIM embeddings HTTP 401")
        self.assertNotIn("test-key", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
