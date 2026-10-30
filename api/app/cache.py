"""Semantic cache and labelled replay, in front of the proxy.

GAMEPLAN "Caching and the honest demo". Both are off unless their flag is on.

Cache (FF_SEMANTIC_CACHE). A run is cached when it finished well: the analyst
approved or edited it and the Judge passed it. The key is the question
(case, spacing and punctuation folded) plus the event, the customer, the
replay clock, the language and the agents' flags, lanes and schema, so a
change of flags is a miss. The replay clock is normalised to
YYYY-MM-DDTHH:MM:SSZ on lookup and on remember, the same rule as the agents'
RunRequest, so a zone-less or short form of that instant hits. A repeat of
that question is answered with the original run, labelled as cache ("Cached
answer from HH:MM · not live · original run R"), including when the stored
run was a clocked replay. The historical clock stays: replay_ts and cached_at
are that UTC instant, never "now", and the answer is not called live. Live
data expires sooner than a historical replay. A follow-up in a thread is
never cached or served from the cache, because it depends on its conversation.
"Similar" means the same after folding for now; embedding similarity needs
the embed lane.

Replay (FF_CACHED_REPLAY). When a live run fails (the agents answer 5xx, are
unreachable, or return a failed run), the API serves the newest recorded run
for the same question, event, customer, replay clock and language that a
person approved or edited. An event alias (valencia_2024) matches the
canonical id (EMSR773). A different question is not served. The replay block
names the original question and clock, so a console cannot show one question's
answer as another's. Follow-ups (a request that carries thread_id) are not
replayed. Lookups use CACHE_LOOKUP_TIMEOUT_S, not the long run timeout, and
an unreachable agents service is answered from the recording kept here.

Storage. With REDIS_URL set and reachable, cache entries and recordings are
also written to Redis (JSON values, SET EX; keys floodsense:cache:v1:<sha256>
and floodsense:replay:v1:<sha256>). Entries expire with their TTL, recordings
after REPLAY_RECORDING_TTL_S (30 days), so the replay fallback outlives a day.
Lookups read Redis first and fall through to the in-process store on a miss,
so entries made while Redis was down still answer. The in-process store is a
bounded LRU (CACHE_MAX_ENTRIES, REPLAY_MAX_RECORDINGS); its evictions do not
touch Redis. When REDIS_URL is unset, or a Redis call fails or takes longer
than CACHE_LOOKUP_TIMEOUT_S, the in-process store answers: logged once,
retried after REDIS_RETRY_S, never a failed request.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("floodsense.api.cache")

CACHE_PREFIX = "floodsense:cache:v1:"
REPLAY_PREFIX = "floodsense:replay:v1:"
# Written only by `python tasks.py demo-seed` (app/demo_seed.py), so /system can say what was seeded.
DEMO_PREFIX = "floodsense:demo:v1:"
DEMO_SEED_KEY = DEMO_PREFIX + "seeded"
# Layer (c) corpus and retrieval version. Bump it when corpus/manifest.yaml or the
# retrieve_docs ranking changes, so answers cached before an ingest stop being served.
CORPUS_VERSION = "rag-2026-10-27"
REDIS_RETRY_S = 30.0
REDIS_SOCKET_TIMEOUT_S = 0.5

# Mirrors RunRequest's defaults in agents/floodsense_agents/models.py, so a
# request that leaves them out keys the same as one that spells them out.
DEFAULT_EVENT = "EMSR773"
DEFAULT_CUSTOMER = "demo-insurer"
DEFAULT_LANG = "en"
REMEMBERED = ("approved", "edited")
FLAGS_MEMO_S = 30.0

# Same aliases as agents/floodsense_agents/events.py. The agents store the
# canonical id on the run; a client may still post the alias.
_EVENT_ALIASES = {"valencia_2024": "EMSR773", "ahr_2021": "EMSR517"}

# A replay clock is a UTC instant. Callers compare it, so it is normalised to
# YYYY-MM-DDTHH:MM:SSZ. This is the agents' normalize_utc; an unparseable
# value is kept as text so a lookup does not fail the request.
_UTC_LOOSE = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?Z?$")
_UTC_CANON = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


# Copy of agents/floodsense_agents/live.py LIVE_PATTERNS. A request with no
# mode keys on the mode the agents will resolve, so a live answer is never
# served for an event question or the other way round. Change both together.
_LIVE_PATTERNS: tuple[str, ...] = (
    r"now",
    r"right now",
    r"currently",
    r"today",
    r"tonight",
    r"tomorrow",
    r"this week",
    r"next \d+ ?(?:h|hours?|days?)",
    r"next (?:few )?(?:hours?|days?)",
    r"coming (?:hours?|days?)",
    # Spanish
    r"ahora",
    r"hoy",
    r"ma(?:ñ|n)ana",
    r"pr(?:ó|o)xim[ao]s \d+ ?(?:h|horas?)",
    # German. "Guten Morgen" is a greeting, not tomorrow.
    r"jetzt",
    r"heute",
    r"(?<!guten )morgen",
    r"n(?:ä|a)chsten \d+ ?(?:h|stunden)",
)
# A question that names the past is an event question, whatever else it says.
_EVENT_PATTERNS: tuple[str, ...] = (
    r"(?:19\d{2}|20(?:[01]\d|2[0-4]))",  # a year up to 2024
    r"\d{4}-\d{2}-\d{2}",  # an explicit date
    r"\d{1,2}\.? (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ene|abr|ago|dic|"
    r"okt|dez|mai|juli?|juni?|m(?:ä|a)r)\w*",
    r"emsr\d*",
    r"on that day",
)
_EVENT_RE = re.compile(
    "|".join(rf"\b(?:{p})\b" for p in _EVENT_PATTERNS), re.IGNORECASE | re.UNICODE
)
_LIVE_RE = re.compile("|".join(rf"\b(?:{p})\b" for p in _LIVE_PATTERNS), re.IGNORECASE | re.UNICODE)


def _flag(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v in (None, "") else v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class CacheSettings:
    semantic_cache: bool = field(default_factory=lambda: _flag("FF_SEMANTIC_CACHE", False))
    cached_replay: bool = field(default_factory=lambda: _flag("FF_CACHED_REPLAY", False))
    ttl_live_s: float = field(
        default_factory=lambda: float(os.environ.get("CACHE_TTL_LIVE_S") or 900)
    )
    ttl_replay_s: float = field(
        default_factory=lambda: float(os.environ.get("CACHE_TTL_REPLAY_S") or 86400)
    )
    max_entries: int = field(
        default_factory=lambda: int(os.environ.get("CACHE_MAX_ENTRIES") or 256)
    )
    # Recordings in Redis. Long, so the labelled replay outlives a cache entry.
    recording_ttl_s: float = field(
        default_factory=lambda: float(os.environ.get("REPLAY_RECORDING_TTL_S") or 2592000)
    )
    max_recordings: int = field(
        default_factory=lambda: int(os.environ.get("REPLAY_MAX_RECORDINGS") or 8)
    )
    # Cache and replay lookups. Not the 600s budget a live run is allowed.
    lookup_timeout_s: float = field(
        default_factory=lambda: float(os.environ.get("CACHE_LOOKUP_TIMEOUT_S") or 3)
    )


def fold(question: str) -> str:
    """The question as the cache compares it: casefolded, punctuation and spacing folded."""
    return " ".join(re.sub(r"[^\w\s]", " ", (question or "").casefold()).split())


def normalize_utc(value: Any) -> str | None:
    """Canonical UTC instant, or None when there is no clock.

    Zone-less and short forms (2024-10-29T16:00Z, 2024-10-29 16:00:00) become
    YYYY-MM-DDTHH:MM:SSZ. Anything else is returned unchanged so two identical
    raw values still share a key.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    match = _UTC_LOOSE.fullmatch(text)
    if not match:
        return text
    date, hour, minute, second = match.groups()
    return f"{date}T{hour}:{minute}:{second or '00'}Z"


def canonical_event(event_id: str | None) -> str:
    """EMSR id. valencia_2024 and ahr_2021 map to the id the agents store."""
    raw = (str(event_id).strip() if event_id else "") or DEFAULT_EVENT
    return _EVENT_ALIASES.get(raw, raw)


def fingerprint(config: dict[str, Any]) -> str:
    """The agents' flags, lanes and schema, from their GET /config."""
    flags = config.get("flags") or {}
    lanes = config.get("lanes") or {}
    parts = [f"{k}={flags[k]}" for k in sorted(flags)]
    parts += [f"lane.{k}={lanes[k]}" for k in sorted(lanes)]
    parts.append(f"schema={config.get('schema')}")
    return ";".join(parts)


def mode_of(source: dict[str, Any]) -> str:
    """event or live, as the agents resolve it (agents/floodsense_agents/live.py).

    A run body carries the resolved mode; a request carries at most the
    explicit one, and otherwise the question decides.
    """
    resolved = source.get("mode")
    if isinstance(resolved, dict) and resolved.get("mode") in ("event", "live"):
        return resolved["mode"]
    request = _request_of(source)
    if clock_from(source):
        return "event"
    explicit = resolved if resolved in ("event", "live") else request.get("mode")
    if explicit in ("event", "live"):
        return explicit
    question = question_text(source)
    if _EVENT_RE.search(question):
        return "event"
    return "live" if _LIVE_RE.search(question) else "event"


def recorded_mode(run: dict[str, Any]) -> str:
    """The mode a recorded run answered in. A run from before live mode has none: event."""
    resolved = run.get("mode")
    if isinstance(resolved, dict) and resolved.get("mode") in ("event", "live"):
        return resolved["mode"]
    if resolved in ("event", "live"):
        return resolved
    return "event"


def key_of(request: dict[str, Any], flags: str) -> tuple:
    return (
        mode_of(request),
        fold(str(request.get("question") or "")),
        request.get("event_id") or DEFAULT_EVENT,
        request.get("customer_id") or DEFAULT_CUSTOMER,
        normalize_utc(request.get("replay_ts")),
        request.get("lang") or DEFAULT_LANG,
        fold(str(request.get("doc_query") or "")),
        _context_of(request),
        flags,
        CORPUS_VERSION,
    )


def _hhmm(ts: str | None) -> str | None:
    """14:32 out of 2026-10-24T14:32:51Z. None when there is no usable stamp."""
    if not ts or len(ts) < 16 or ts[10] not in ("T", " "):
        return None
    return ts[11:16]


def describe(served_from: str | None, cached_at: str | None, run_id: str | None) -> dict[str, Any]:
    """The banner. Wording matches agents/floodsense_agents/labelling.py."""
    kind = served_from if served_from in ("live", "cache", "replay") else None
    if kind == "live":
        return {"live": True, "kind": "live", "text": None, "at": None}
    at = _hhmm(cached_at if isinstance(cached_at, str) else None)
    if kind == "cache":
        head = f"Cached answer from {at}" if at else "Cached answer"
    elif kind == "replay":
        head = f"Replay of a recorded run from {at}" if at else "Replay of a recorded run"
    else:
        head = "Provenance not recorded"
    parts = [head, "not live"]
    if run_id:
        parts.append(f"original run {run_id}")
    return {"live": False, "kind": kind or "unknown", "text": " · ".join(parts), "at": at}


def _request_of(source: dict[str, Any]) -> dict[str, Any]:
    request = source.get("request")
    return request if isinstance(request, dict) else {}


def question_text(source: dict[str, Any]) -> str:
    return str(source.get("question") or _request_of(source).get("question") or "")


def clock_from(source: dict[str, Any]) -> str | None:
    """The scenario clock, from the run or from its request. Not 'now'."""
    request = _request_of(source)
    if source.get("replay_ts") not in (None, ""):
        return normalize_utc(source.get("replay_ts"))
    return normalize_utc(request.get("replay_ts"))


def mark_cached(run: dict[str, Any]) -> dict[str, Any]:
    """A semantic-cache hit is cache, even when the stored run was a clocked replay.

    replay_ts and an existing cached_at stay that UTC instant. They are not
    rewritten to the time of the hit, and served_from is not left as replay.
    """
    if not run.get("cached_at"):
        clock = clock_from(run)
        if clock and _UTC_CANON.fullmatch(clock):
            run["cached_at"] = clock
    run["served_from"] = "cache"
    run["label"] = describe("cache", run.get("cached_at"), run.get("run_id"))
    return run


def annotate_replay(
    run: dict[str, Any], reason: str, failed_run_id: str | None = None
) -> dict[str, Any]:
    """Label a failover replay and name the question it actually answered."""
    question = question_text(run)
    clock = clock_from(run)
    if not run.get("cached_at") and clock and _UTC_CANON.fullmatch(clock):
        run["cached_at"] = clock
    run["served_from"] = "replay"
    label = describe("replay", run.get("cached_at"), run.get("run_id"))
    if question:
        label["text"] = f"{label['text']} · {question}"
    run["label"] = label
    block: dict[str, Any] = {
        "original_run_id": run.get("run_id"),
        "reason": reason,
        "question": question,
        "replay_ts": clock,
    }
    if failed_run_id:
        block["failed_run_id"] = failed_run_id
    run["replay"] = block
    return run


def _lang_of(source: dict[str, Any]) -> str:
    return str(source.get("lang") or _request_of(source).get("lang") or DEFAULT_LANG)


def _customer_of(source: dict[str, Any]) -> str:
    return str(
        source.get("customer_id") or _request_of(source).get("customer_id") or DEFAULT_CUSTOMER
    )


def _event_of(source: dict[str, Any]) -> str:
    # The request's event first: a run routed to EMSR517 by its question still
    # answers the ask that sent EMSR773 (agents events.route_event).
    # A run's own event_id may be the routed one; its request is what was asked.
    request = source.get("request")
    # A request that carries the key (every RunRequest dump does) decides, even as None.
    if isinstance(request, dict) and "event_id" in request:
        return canonical_event(request.get("event_id"))
    return canonical_event(source.get("event_id"))


def _context_of(source: dict[str, Any]) -> tuple:
    """What the user was looking at, so a cached answer never crosses places or roles."""
    ctx = source.get("context")
    if not isinstance(ctx, dict):
        ctx = _request_of(source).get("context")
    if not isinstance(ctx, dict):
        return ()
    return tuple(sorted((str(k), str(v)) for k, v in ctx.items() if v not in (None, "")))


def ask_of(source: dict[str, Any]) -> tuple:
    """Question, event, customer, clock, language, doc_query, as replay compares them."""
    return (
        mode_of(source),
        fold(question_text(source)),
        _event_of(source),
        _customer_of(source),
        clock_from(source),
        _lang_of(source),
        fold(str(source.get("doc_query") or _request_of(source).get("doc_query") or "")),
        _context_of(source),
    )


def same_ask(request: dict[str, Any], run: dict[str, Any]) -> bool:
    """True when the run answered this question, event, customer, clock and language."""
    return ask_of(request) == (recorded_mode(run), *ask_of(run)[1:])


def past_row_matches(request: dict[str, Any], row: dict[str, Any]) -> bool:
    """A /runs/past row that may be replayed for this request.

    Language is compared only when the row carries it. The agents' past list
    does not, so the full run is checked afterwards.
    """
    if not isinstance(row, dict):
        return False
    run_id = row.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        return False
    if row.get("status") != "approved" or row.get("approval") not in REMEMBERED:
        return False
    if (row.get("thread_id") or run_id) != run_id:
        return False
    if canonical_event(row.get("event_id")) != canonical_event(request.get("event_id")):
        return False
    if (row.get("customer_id") or DEFAULT_CUSTOMER) != (
        request.get("customer_id") or DEFAULT_CUSTOMER
    ):
        return False
    if fold(str(row.get("question") or "")) != fold(str(request.get("question") or "")):
        return False
    if normalize_utc(row.get("replay_ts")) != normalize_utc(request.get("replay_ts")):
        return False
    # A row without a mode predates live mode, so it answered the event window.
    if recorded_mode(row) != mode_of(request):
        return False
    row_lang = row.get("lang")
    if row_lang not in (None, "") and str(row_lang) != (request.get("lang") or DEFAULT_LANG):
        return False
    return True


def approved_by_a_person(run: dict[str, Any]) -> bool:
    """Approved or edited by a reviewer. Enough for a recording to replay."""
    approval = (run.get("approval") or {}).get("status")
    return run.get("status") == "approved" and approval in REMEMBERED


def quick_answered(run: dict[str, Any]) -> bool:
    """A quick- or forecast-lane answer: no playbook, no HITL, ends ``answered`` (router.py).

    Both read the live views, so both are cached with the live TTL.
    """
    return run.get("lane") in ("quick", "forecast") and run.get("status") == "answered"


def finished_well(run: dict[str, Any]) -> bool:
    """Passed by the Judge, and approved or edited by a person, or a quick-lane
    answer (nothing to approve). Nothing else is cached."""
    passed = (run.get("judge_summary") or {}).get("passes") is True
    return passed and (approved_by_a_person(run) or quick_answered(run))


def is_follow_up(run: dict[str, Any]) -> bool:
    request = run.get("request") or {}
    return bool(request.get("thread_id")) or (run.get("thread_id") or run.get("run_id")) != run.get(
        "run_id"
    )


@dataclass
class Entry:
    run_id: str
    stored_at: float  # time.time() when cached
    ttl_s: float


def _slot(prefix: str, key: tuple) -> str:
    """Redis key for a cache or replay tuple. Hashed, so the question is not in the key."""
    raw = json.dumps(list(key), ensure_ascii=False, default=str)
    return prefix + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _client_from_env(timeout_s: float):
    """A redis client for REDIS_URL, or None when unset or the package is missing."""
    url = (os.environ.get("REDIS_URL") or "").strip()
    if not url:
        return None
    try:
        import redis  # noqa: PLC0415
    except ImportError:
        log.warning("REDIS_URL is set but the redis package is missing; cache stays in memory")
        return None
    t = max(0.05, min(REDIS_SOCKET_TIMEOUT_S, timeout_s))
    return redis.Redis.from_url(
        url, socket_timeout=t, socket_connect_timeout=t, retry_on_timeout=False
    )


class _RedisStore:
    """Thin wrapper. A failed or slow call marks Redis down for REDIS_RETRY_S."""

    def __init__(self, client, slow_s: float) -> None:
        self.client = client
        self.slow_s = slow_s
        self._down_until = 0.0
        self._warned = False

    @property
    def up(self) -> bool:
        return time.monotonic() >= self._down_until

    def _fail(self, why: Any) -> None:
        self._down_until = time.monotonic() + REDIS_RETRY_S
        if not self._warned:
            log.warning("Redis unavailable (%s); serving the cache from memory", why)
            self._warned = True

    def call(self, fn, default=None):
        if not self.up:
            return default
        started = time.monotonic()
        try:
            out = fn(self.client)
        except Exception as exc:  # noqa: BLE001 - any Redis failure falls back
            self._fail(exc)
            return default
        took = time.monotonic() - started
        if took > self.slow_s:
            self._fail(f"call took {took:.2f}s")
            return out
        if self._warned:
            log.info("Redis reachable again; cache back on Redis")
            self._warned = False
        return out

    def set_json(self, key: str, value: dict[str, Any], ttl_s: float) -> bool:
        data = json.dumps(value, ensure_ascii=False, default=str)
        ex = max(1, int(-(-ttl_s // 1)))  # ceil, at least a second
        return bool(self.call(lambda c: c.set(key, data, ex=ex), False))

    def get_json(self, key: str) -> tuple[bool, dict[str, Any] | None]:
        """(answered, value). answered is False when Redis did not answer."""
        sentinel = object()
        raw = self.call(lambda c: c.get(key), sentinel)
        if raw is sentinel:
            return False, None
        if raw is None:
            return True, None
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            return True, None
        return True, value if isinstance(value, dict) else None

    def delete(self, *keys: str) -> None:
        if keys:
            self.call(lambda c: c.delete(*keys))


class AnswerCache:
    """Cache of finished runs, plus the last few recordings for replay.

    In process, with Redis behind it when REDIS_URL is set (module docstring).
    The methods are blocking; async handlers call them through asyncio.to_thread.
    """

    def __init__(self, settings: CacheSettings | None = None, redis_client: Any = None) -> None:
        self.settings = settings or CacheSettings()
        if redis_client is None:
            redis_client = _client_from_env(self.settings.lookup_timeout_s)
        self._redis = (
            _RedisStore(redis_client, self.settings.lookup_timeout_s)
            if redis_client is not None
            else None
        )
        self._lock = threading.Lock()
        self._entries: OrderedDict[tuple, Entry] = OrderedDict()
        self._recordings: OrderedDict[tuple, dict[str, Any]] = OrderedDict()
        self._flags: tuple[float, str] | None = None

    # ---------------------------------------------------------------- flags

    def cached_flags(self) -> str | None:
        """The memoised flag fingerprint, or None when it is missing or stale."""
        now = time.monotonic()
        if self._flags is not None and now - self._flags[0] < FLAGS_MEMO_S:
            return self._flags[1]
        return None

    def flags(self, fetch) -> str | None:
        """The agents' flag fingerprint, memoised briefly. None when /config fails.

        ``fetch`` returns an already loaded config dict, or None. It is not
        asked to do I/O: the caller awaits that first.
        """
        memo = self.cached_flags()
        if memo is not None:
            return memo
        config = fetch()
        if config is None:
            return None
        fp = fingerprint(config)
        self._flags = (time.monotonic(), fp)
        return fp

    def forget_flags(self) -> None:
        self._flags = None

    # ---------------------------------------------------------------- cache

    def ttl_for(self, request: dict[str, Any], flags: str) -> float:
        # A live-mode answer reads a rolling window, so it ages like live data
        # whatever the schema flag says.
        live_data = "FF_LIVE_DATA=True" in flags.split(";") and not request.get("replay_ts")
        live = live_data or mode_of(request) == "live"
        return self.settings.ttl_live_s if live else self.settings.ttl_replay_s

    def _write_entry(self, key: tuple, entry: Entry, ttl_s: float) -> None:
        if self._redis is not None:
            self._redis.set_json(
                _slot(CACHE_PREFIX, key),
                {"run_id": entry.run_id, "stored_at": entry.stored_at, "ttl_s": entry.ttl_s},
                ttl_s,
            )

    def remember(self, run: dict[str, Any], flags: str) -> bool:
        """Cache a finished run. False when it does not qualify."""
        if not finished_well(run) or is_follow_up(run):
            return False
        request = run.get("request") or {}
        key = key_of(request, flags)
        # A quick-lane answer is a live reading: it ages like live data.
        ttl = self.settings.ttl_live_s if quick_answered(run) else self.ttl_for(request, flags)
        entry = Entry(run["run_id"], time.time(), ttl)
        with self._lock:
            self._entries[key] = entry
            self._entries.move_to_end(key)
            while len(self._entries) > self.settings.max_entries:
                self._entries.popitem(last=False)  # Redis keeps it until its TTL
        self._write_entry(key, entry, entry.ttl_s)
        return True

    def _memory_entry(self, key: tuple) -> Entry | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            if time.time() - entry.stored_at > entry.ttl_s:
                del self._entries[key]
                return None
            return entry

    def lookup(self, request: dict[str, Any], flags: str) -> Entry | None:
        if request.get("thread_id"):
            return None
        key = key_of(request, flags)
        if self._redis is not None:
            answered, value = self._redis.get_json(_slot(CACHE_PREFIX, key))
            if answered and value is not None:
                try:
                    found = Entry(
                        str(value["run_id"]), float(value["stored_at"]), float(value["ttl_s"])
                    )
                except (TypeError, KeyError, ValueError):
                    found = None
                if found is not None and time.time() - found.stored_at <= found.ttl_s:
                    return found
            entry = self._memory_entry(key)
            if entry is not None and answered:
                # Written while Redis was down, or Redis lost it: put it back.
                left = entry.ttl_s - (time.time() - entry.stored_at)
                self._write_entry(key, entry, left)
            return entry
        return self._memory_entry(key)

    def drop(
        self, run_id: str, request: dict[str, Any] | None = None, flags: str | None = None
    ) -> None:
        """Forget a run. In Redis only the slot of the request that found it is deleted."""
        with self._lock:
            for key in [k for k, e in self._entries.items() if e.run_id == run_id]:
                del self._entries[key]
        if self._redis is not None and request is not None and flags is not None:
            self._redis.delete(_slot(CACHE_PREFIX, key_of(request, flags)))

    # ------------------------------------------------------------ recordings

    def record(self, replay_body: dict[str, Any]) -> None:
        """Keep a replay-labelled run, keyed by the question it answered."""
        stored = dict(replay_body)
        slot = ask_of(stored)
        with self._lock:
            self._recordings[slot] = stored
            self._recordings.move_to_end(slot)
            while len(self._recordings) > self.settings.max_recordings:
                self._recordings.popitem(last=False)  # Redis keeps it until its TTL
        if self._redis is not None:
            self._redis.set_json(_slot(REPLAY_PREFIX, slot), stored, self.settings.recording_ttl_s)

    def recording_for(self, request: dict[str, Any]) -> dict[str, Any] | None:
        """The recording of this question, event, customer, clock and language."""
        slot = ask_of(request)
        if self._redis is not None:
            _, value = self._redis.get_json(_slot(REPLAY_PREFIX, slot))
            if value is not None:
                return value
        with self._lock:
            body = self._recordings.get(slot)
            return dict(body) if body else None

    def backend(self) -> str:
        """redis while Redis answers a ping, memory otherwise."""
        if self._redis is None or not self._redis.up:
            return "memory"
        return "redis" if self._redis.call(lambda c: c.ping(), False) else "memory"

    def key_counts(self, limit: int = 10_000) -> dict[str, int | None]:
        """Keys per prefix. Redis is SCANned (capped at ``limit``); None when it does not answer."""
        prefixes = {"cache": CACHE_PREFIX, "replay": REPLAY_PREFIX, "demo": DEMO_PREFIX}
        if self._redis is None or not self._redis.up:
            with self._lock:
                return {"cache": len(self._entries), "replay": len(self._recordings), "demo": 0}

        def count(prefix: str):
            def go(client):
                n = 0
                for _ in client.scan_iter(match=prefix + "*", count=500):
                    n += 1
                    if n >= limit:
                        break
                return n

            return go

        return {name: self._redis.call(count(p), None) for name, p in prefixes.items()}

    def demo_seeded(self) -> dict[str, Any] | None:
        """The marker demo-seed leaves in Redis: which runs it warmed. None when absent."""
        if self._redis is None:
            return None
        _, value = self._redis.get_json(DEMO_SEED_KEY)
        return value

    def demo_seeded_live(self) -> list[str]:
        """Warmed run ids whose cache entry is still in Redis. An expired or evicted one is left out."""
        marker = self.demo_seeded() or {}
        live = []
        for item in marker.get("entries") or []:
            if not isinstance(item, dict) or not isinstance(item.get("cache_key"), str):
                continue
            _, value = self._redis.get_json(item["cache_key"]) if self._redis else (False, None)
            if value is not None:
                live.append(str(item.get("run_id")))
        return live

    def stats(self) -> dict[str, Any]:
        """Flags, backend and this process's counts. No Redis scan."""
        backend = self.backend()
        with self._lock:
            return {
                "FF_SEMANTIC_CACHE": self.settings.semantic_cache,
                "FF_CACHED_REPLAY": self.settings.cached_replay,
                "backend": backend,
                "entries": len(self._entries),
                "recordings": len(self._recordings),
                "ttl_live_s": self.settings.ttl_live_s,
                "ttl_replay_s": self.settings.ttl_replay_s,
                "recording_ttl_s": self.settings.recording_ttl_s,
                "lookup_timeout_s": self.settings.lookup_timeout_s,
            }
