"""NVIDIA NIM embeddings for layer (c). The API key is never logged."""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

MODEL = "nvidia/nemotron-3.5-embed-1b"
DIMENSIONS = 2048
DEFAULT_URL = "https://integrate.api.nvidia.com/v1/embeddings"
_INPUT_TYPES = ("passage", "query")

Opener = Callable[[str, dict, bytes], dict]


class EmbedError(Exception):
    """A NIM call failed. The message does not contain the key or the body."""


def cache_path(root: Path, input_type: str, text: str) -> Path:
    _check_input_type(input_type)
    digest = hashlib.sha256(text.encode()).hexdigest()
    return root / "corpus" / ".embed-cache" / MODEL / "2048" / input_type / f"{digest}.json"


def embed_texts(
    texts: list[str],
    input_type: str,
    *,
    root: Path,
    api_key: str,
    url: str = DEFAULT_URL,
    opener: Opener | None = None,
) -> list[list[float]]:
    """Embed texts. Cache hits skip NIM. One request covers the misses."""
    _check_input_type(input_type)
    if opener is None:
        opener = _default_opener
    vectors: list[list[float] | None] = []
    missing_at: list[int] = []
    missing: list[str] = []
    for index, text in enumerate(texts):
        cached = _read_cache(cache_path(root, input_type, text))
        if cached is None:
            vectors.append(None)
            missing_at.append(index)
            missing.append(text)
        else:
            vectors.append(cached)
    if not missing:
        return [vector for vector in vectors if vector is not None]
    body = json.dumps(
        {
            "model": MODEL,
            "input": missing,
            "input_type": input_type,
            "dimensions": DIMENSIONS,
        }
    ).encode()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        payload = opener(url, headers, body)
    except EmbedError:
        raise
    except Exception:
        raise EmbedError("NIM embeddings HTTP error") from None
    found = _vectors_by_index(payload)
    for offset, text in enumerate(missing):
        vector = found.get(offset)
        if not _is_vector(vector):
            raise EmbedError("NIM embeddings response is not 2048 numbers")
        _write_cache(cache_path(root, input_type, text), vector)
        vectors[missing_at[offset]] = vector
    return [vector for vector in vectors if vector is not None]


def _check_input_type(input_type: str) -> None:
    if input_type not in _INPUT_TYPES:
        raise EmbedError("input_type must be passage or query")


def _is_vector(value: object) -> bool:
    if not isinstance(value, list) or len(value) != DIMENSIONS:
        return False
    return all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value)


def _read_cache(path: Path) -> list[float] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    vector = payload.get("embedding")
    if not _is_vector(vector):
        return None
    return vector


def _write_cache(path: Path, vector: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"embedding": vector}), encoding="utf-8")


def _vectors_by_index(payload: object) -> dict[int, list[float]]:
    if not isinstance(payload, dict):
        raise EmbedError("NIM embeddings response is not 2048 numbers")
    data = payload.get("data")
    if not isinstance(data, list):
        raise EmbedError("NIM embeddings response is not 2048 numbers")
    found: dict[int, list[float]] = {}
    for item in data:
        if not isinstance(item, dict) or "index" not in item:
            raise EmbedError("NIM embeddings response is not 2048 numbers")
        found[int(item["index"])] = item.get("embedding")
    return found


def _default_opener(url: str, headers: dict, body: bytes) -> dict:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise EmbedError(f"NIM embeddings HTTP {exc.code}") from None
    except urllib.error.URLError:
        raise EmbedError("NIM embeddings HTTP error") from None
    try:
        payload = json.loads(raw.decode())
    except json.JSONDecodeError:
        raise EmbedError("NIM embeddings HTTP error") from None
    if not isinstance(payload, dict):
        raise EmbedError("NIM embeddings response is not 2048 numbers")
    return payload
