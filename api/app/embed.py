"""Question embeddings for the similar-question cache (FF_SEMANTIC_CACHE).

EMBEDDINGS_BACKEND=nim (default: exact-fold matching only, nothing changes) |
nebius. nebius: POST {NEBIUS_BASE_URL}/embeddings, Bearer NEBIUS_API_KEY, model
NEBIUS_EMBEDDING_MODEL (default Qwen/Qwen3-Embedding-8B). The key comes from
the environment only and is never logged. Retry and pacing mirror agents
nightshift.py: 429 backs off 2 s * 2^n (or Retry-After), at most 3 retries and
20 s of extra wait; calls start at least 60/NIGHTSHIFT_RPM s apart. The API
image does not ship the agents package, so this is a small copy.
Any failure returns None: the cache then falls back to exact matching.
"""

from __future__ import annotations

import logging
import math
import os
import random
import re
import threading
import time

import httpx

log = logging.getLogger("floodsense.api.embed")

NEBIUS_URL = "https://api.tokenfactory.nebius.com/v1"
NEBIUS_MODEL = "Qwen/Qwen3-Embedding-8B"
BACKOFF_BASE_S, BACKOFF_RETRIES, BACKOFF_MAX_WAIT_S = 2.0, 3, 20.0
# Live, Qwen3-Embedding-8B: 6 paraphrases scored 0.78 to 0.98 (five at 0.946+), but
# near-misses (negation, number, place, above/below) scored 0.72 to 0.98, so the
# guard_key check, not the threshold, keeps them apart. 0.90 hits 5 of 6.
DEFAULT_THRESHOLD = 0.90
FAST_TIMEOUT_S = 3.0

# Copy of agents/floodsense_agents/events.py POINT_NAMES, GERMAN_PLACES and the
# event names (the API image has no agents package). Change both together.
_PLACES = {
    "valencia", "paiporta", "catarroja", "sedavi", "sedaví", "alfafar", "benetusser", "benetússer",
    "algemesi", "algemesí", "chiva", "utiel", "ahr", "altenahr", "ahrweiler", "ahrtal", "schuld",
    "dernau", "neuenahr", "rhine", "rhein", "köln", "koeln", "cologne", "bonn", "koblenz", "mosel",
    "moselle", "germany", "deutschland", "nrw", "spain", "españa", "spanien", "eifel", "poyo",
}
_NEGATIONS = {
    "not", "no", "never", "without", "none", "nothing", "nobody", "neither", "nor", "cannot",
    "nicht", "kein", "keine", "keinen", "keiner", "keines", "ohne", "nie", "niemals", "nichts",
    "kaum", "weder", "niemand", "nunca", "sin", "ningun", "ninguna", "ninguno", "nada", "nadie",
    "ni", "jamais", "aucun", "aucune", "pas", "sans", "rien", "non", "nul", "ne",
    # antonyms embeddings barely separate (above/below scored 0.98 live)
    "above", "below", "over", "under", "more", "less", "fewer", "most", "least", "higher",
    "lower", "highest", "lowest", "rising", "falling", "before", "after", "increase", "decrease",
    "inside", "outside", "up", "down", "open", "closed", "safe", "unsafe", "dry", "wet",
    "max", "min", "maximum", "minimum", "within", "beyond", "mehr", "weniger", "über", "unter",
    "höher", "niedriger", "más", "menos", "plus", "moins",
}
_NEG_AFFIX = re.compile(r"^(?:non-?|un|in|nicht-?)\w{3,}", re.I)
_NUMBER_WORDS = {
    **{w: str(i) for i, w in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
        "fifteen sixteen seventeen eighteen nineteen twenty".split())},
    **{w: str(i) for i, w in enumerate(
        "null eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf".split())},
    **{w: str(i) for i, w in enumerate(
        "cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce".split())},
    **{w: str(i) for i, w in enumerate(
        "zéro un deux trois quatre cinq six sept huit neuf dix onze douze".split())},
    "ein": "1", "eine": "1", "une": "1", "thirty": "30", "forty": "40", "fifty": "50",
    "hundred": "100", "hundert": "100", "cent": "100", "cien": "100", "dreißig": "30",
    "zwanzig": "20", "dreissig": "30", "vierzig": "40", "fünfzig": "50", "veinte": "20",
    "treinta": "30", "vingt": "20", "trente": "30",
}
_UNITS = {"mi": "mile", "mile": "mile", "miles": "mile", "meter": "m", "meters": "m", "metre": "m",
          "metres": "m", "kilometer": "km", "kilometers": "km", "kilometre": "km",
          "kilometres": "km", "hour": "h", "hours": "h", "hr": "h", "hrs": "h", "stunden": "h",
          "stunde": "h", "horas": "h", "heures": "h", "day": "d", "days": "d", "tage": "d",
          "tag": "d", "dias": "d", "días": "d", "jours": "d", "percent": "%", "prozent": "%",
          "minutes": "min", "minute": "min", "minuten": "min", "feet": "ft", "foot": "ft"}
_NUMS = re.compile(
    r"(\d+(?:[.,]\d+)?)\s?(km|mm|cm|min|ha|ft|mi|m|h|d|%|[a-zà-ÿ]+)?", re.I | re.UNICODE)


def _num(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


def guard_key(question: str) -> tuple:
    """Heuristic. What an embedding is weak on: numbers (digits or spelled out) with
    their unit, negation and antonym words, and place names. Two questions must agree
    on all three; a false miss is the safe side. Known gaps: unlisted antonyms,
    languages beyond en/de/es/fr, places missing from _PLACES that are lowercase."""
    text = question.replace("’", "'")
    low = text.lower()
    words = re.findall(r"[\w'-]+", low, re.UNICODE)
    nums = set()
    for m in _NUMS.finditer(low):
        unit = (m.group(2) or "").lower()
        unit = _UNITS.get(unit, unit)
        nums.add(m.group(1).replace(",", ".") + (unit if unit in _UNIT_SET else ""))
    for i, w in enumerate(words):
        if w in _NUMBER_WORDS:
            nxt = _UNITS.get(words[i + 1], words[i + 1]) if i + 1 < len(words) else ""
            nums.add(_NUMBER_WORDS[w] + (nxt if nxt in _UNIT_SET else ""))
    neg = {w for w in words if w in _NEGATIONS or w.endswith("n't")
           or (_NEG_AFFIX.match(w) and w not in _AFFIX_OK)}
    caps = {w.strip(".,'-").lower() for w in re.findall(r"[\w'-]+", text, re.UNICODE)
            if w[:1].isupper() and w.lower() not in _STOP_CAPS}
    names = caps | {w for w in words if w in _PLACES}
    return frozenset(nums), frozenset(neg), frozenset(names)


_UNIT_SET = {"km", "mm", "cm", "min", "ha", "ft", "mile", "m", "h", "d", "%"}
# Capitalised function/question words (any sentence start) that are not names.
_STOP_CAPS = {"which", "what", "how", "is", "are", "was", "were", "do", "does", "did", "the",
              "a", "an", "show", "list", "give", "tell", "who", "where", "when", "why", "can",
              "will", "has", "have", "wie", "was", "welche", "welcher", "welches", "wo", "wann",
              "ist", "sind", "gibt", "zeige", "qué", "cuántos", "cuáles", "cómo", "dónde", "es",
              "son", "quels", "quelles", "comment", "où", "combien", "est", "sont", "i", "in",
              "of", "and", "der", "die", "das", "el", "la", "le", "les", "los", "las", "for"}
# Words that look like a negation prefix (in-, un-) but are not.
_AFFIX_OK = {"inside", "into", "under", "until", "unit", "units", "insured", "insurer",
             "insurance", "inundated", "inundation", "information", "increase", "index",
             "indicator", "industrial", "input", "international", "investigate", "inland",
             "intensity", "interval", "unknown_", "uncertain_", "union", "unter", "uns", "non",
             "innen", "inner", "indem", "increasing", "included", "including", "inland"}
class Embedder:
    def __init__(
        self,
        backend: str | None = None,
        client: httpx.Client | None = None,
        sleep=time.sleep,
    ) -> None:
        self.backend = (backend or os.environ.get("EMBEDDINGS_BACKEND") or "nim").strip().lower()
        self._client = client
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next = 0.0
        rpm = _num("NIGHTSHIFT_RPM", 0.0)
        self._spacing = 60.0 / rpm if rpm > 0 else 0.0
        t = _num("EMBED_CACHE_THRESHOLD", DEFAULT_THRESHOLD)
        self.threshold = t if 0 < t <= 1 else DEFAULT_THRESHOLD

    @property
    def enabled(self) -> bool:
        return self.backend == "nebius"

    def _pace(self) -> None:
        if not self._spacing:
            return
        with self._lock:
            now = time.monotonic()
            start = max(now, self._next)
            self._next = start + self._spacing
        if start > now:
            self._sleep(start - now)

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def embed(self, text: str, *, fast: bool = False) -> list[float] | None:
        """fast: one attempt, FAST_TIMEOUT_S, no backoff sleep (the lookup path)."""
        key = os.environ.get("NEBIUS_API_KEY", "")
        if not self.enabled or not key or not text.strip():
            return None
        base = (os.environ.get("NEBIUS_BASE_URL") or NEBIUS_URL).rstrip("/")
        body = {"model": os.environ.get("NEBIUS_EMBEDDING_MODEL") or NEBIUS_MODEL, "input": [text]}
        if self._client is None:
            self._client = httpx.Client()
        client = self._client
        waited = 0.0
        for n in range(1 if fast else BACKOFF_RETRIES + 1):
            if not fast:
                self._pace()
            try:
                r = client.post(
                    f"{base}/embeddings",
                    json=body,
                    timeout=FAST_TIMEOUT_S if fast else 10.0,
                    headers={"Authorization": f"Bearer {key}"},
                )
                if r.status_code == 429 and not fast and n < BACKOFF_RETRIES:
                    try:
                        delay = float(r.headers.get("retry-after"))
                    except (TypeError, ValueError):
                        b = BACKOFF_BASE_S * 2**n
                        delay = b + random.uniform(0, b / 4)
                    if waited + delay > BACKOFF_MAX_WAIT_S:
                        return None
                    waited += delay
                    self._sleep(delay)
                    continue
                r.raise_for_status()
                vec = r.json()["data"][0]["embedding"]
                if not vec or not all(isinstance(x, (int, float)) for x in vec):
                    return None
                return [float(x) for x in vec]
            except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as e:
                log.warning("embeddings call failed: %s", type(e).__name__)  # never body or key
                return None
        return None


def cosine(a: list[float], b: list[float]) -> float:
    """0.0 when the dimensions differ, so vectors from another model never match."""
    if len(a) != len(b) or not a:
        return 0.0
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(x * x for x in b))
    return sum(x * y for x, y in zip(a, b)) / (na * nb) if na and nb else 0.0
