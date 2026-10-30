"""One document retrieve. Ranking stays in Postgres. Hydration stays in Zetaris.

The API key and the database DSN are never logged. FF_RAG_DOCS stays off
until a caller passes the flag.
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

_CHUNK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$")
_EVENTS = {"EMSR773", "EMSR517"}
_HYDRATE_SQL = (
    "SELECT chunk_id, text, text_sha256, title, source_url, publisher, licence, "
    "attribution, page, paragraph, lines, section FROM PGVECTOR_RAG.chunks "
    "WHERE chunk_id IN ({ids})"
)
_HALFVEC_SQL = """
SELECT chunk_id, (embedding::halfvec(2048) <=> $1::halfvec(2048)) AS distance
FROM rag.chunks
WHERE level = 'paragraph'
  AND embedding IS NOT NULL
  AND ($2::text IS NULL OR event_id = $2)
ORDER BY embedding::halfvec(2048) <=> $1::halfvec(2048)
LIMIT $3
""".strip()
_EXACT_SQL = """
SELECT chunk_id, (embedding <=> $1::vector) AS distance
FROM rag.chunks
WHERE level = 'paragraph'
  AND embedding IS NOT NULL
  AND ($2::text IS NULL OR event_id = $2)
ORDER BY embedding <=> $1::vector
LIMIT $3
""".strip()
# Generic (event_id NULL) passages, limited to an allowed doc_id list. $2 is a text[].
_GENERIC_HALFVEC_SQL = """
SELECT chunk_id, (embedding::halfvec(2048) <=> $1::halfvec(2048)) AS distance
FROM rag.chunks
WHERE level = 'paragraph'
  AND embedding IS NOT NULL
  AND event_id IS NULL
  AND doc_id = ANY($2)
ORDER BY embedding::halfvec(2048) <=> $1::halfvec(2048)
LIMIT $3
""".strip()
_GENERIC_EXACT_SQL = """
SELECT chunk_id, (embedding <=> $1::vector) AS distance
FROM rag.chunks
WHERE level = 'paragraph'
  AND embedding IS NOT NULL
  AND event_id IS NULL
  AND doc_id = ANY($2)
ORDER BY embedding <=> $1::vector
LIMIT $3
""".strip()

# At most this many generic passages are appended after the event top k.
GENERIC_MAX = 2
# Generic passages are added only for an insurer role or an insurance-type question.
_INSURER_WORDS = re.compile(
    r"\b(insur\w*|versicher\w*|seguro\w*|protection gap|insured loss(?:es)?"
    r"|economic loss(?:es)?|claims paid|polic(?:y|ies))\b",
    re.IGNORECASE,
)
# Event country. rag.chunks has no country column, so the allowed generic doc_ids
# come from rag_scope.json, which scripts/rag_corpus.py writes from corpus/manifest.yaml.
_EVENT_COUNTRY = {"EMSR773": "ES", "EMSR517": "DE"}
# The Europe live watch (events.WATCH_EVENT) has no event passages. Its run searches
# only the event-agnostic documents in rag_scope.json: all of them, or, when the
# filters carry a country, that country's and the EU-wide ones.
WATCH_EVENT = "LIVE-EU"
_SCOPE_FILE = Path(__file__).resolve().parent / "rag_scope.json"

Embedder = Callable[[list[str], str], list[list[float]]]
Search = Callable[[list[float], str | None, int], list[tuple[str, float]]]
GenericSearch = Callable[[list[float], list[str], int], list[tuple[str, float]]]
Hydrate = Callable[[list[str]], tuple[str, list[dict]]]


@dataclass(frozen=True)
class RetrieveResult:
    citations: list[dict]
    error: str | None


def quote_from_text(text: str, paragraph_lines: str) -> tuple[str, str]:
    """Return a verbatim quote of at most 600 characters and its line range."""
    pieces = text.split("\n")
    if len(text) <= 600 and len(pieces) == 1:
        return text, "1-1"
    if len(text) <= 600:
        return text, paragraph_lines
    chosen: list[str] = []
    for line in pieces:
        candidate = line if not chosen else "\n".join([*chosen, line])
        if len(candidate) > 600:
            break
        chosen.append(line)
    if not chosen:
        return text[:600], "1-1"
    return "\n".join(chosen), f"1-{len(chosen)}"


def retrieve_docs(
    query: str,
    k: int,
    filters: dict | None,
    *,
    embedder: Embedder,
    search: Search,
    hydrate: Hydrate,
    search_generic: GenericSearch | None = None,
    scope: dict[str, str] | None = None,
) -> RetrieveResult:
    """Embed the query, rank in Postgres, and hydrate text through Zetaris.

    Inside an event run the event top k comes first and is never displaced. Then,
    for an insurer role or an insurance-type question, at most GENERIC_MAX
    event-agnostic passages are appended, limited to EU-wide documents and
    documents of the event's country (`scope` maps doc_id to country).
    """
    if isinstance(k, bool) or not isinstance(k, int) or not 1 <= k <= 20:
        return RetrieveResult([], "k must be from 1 to 20")
    event_id, event_error = _event_id(filters)
    if event_error:
        return RetrieveResult([], event_error)
    try:
        vectors = embedder([query], "query")
    except Exception as exc:
        return RetrieveResult([], _short(exc))
    if not vectors:
        return RetrieveResult([], "embedder returned no vector")
    if event_id == WATCH_EVENT:
        allowed = watch_doc_ids(
            load_watch_scope() if scope is None else scope, (filters or {}).get("country")
        )
        if search_generic is None or not allowed:
            return RetrieveResult([], None)
        try:
            ranked = list(search_generic(vectors[0], allowed, k))[:k]
        except Exception as exc:
            return RetrieveResult([], _short(exc))
    else:
        try:
            ranked = list(search(vectors[0], event_id, k))[:k]
        except Exception as exc:
            return RetrieveResult([], _short(exc))
    generic_ids: set[str] = set()
    if event_id in _EVENT_COUNTRY and search_generic is not None and wants_generic(query, filters):
        allowed = generic_doc_ids(event_id, load_scope() if scope is None else scope)
        if allowed:
            try:
                extra = search_generic(vectors[0], allowed, GENERIC_MAX)
            except Exception:
                extra = []  # the event passages stand on their own
            seen = {chunk_id for chunk_id, _distance in ranked}
            for chunk_id, distance in list(extra)[:GENERIC_MAX]:
                if chunk_id not in seen:
                    ranked.append((chunk_id, distance))
                    seen.add(chunk_id)
                    generic_ids.add(chunk_id)
    if not ranked:
        return RetrieveResult([], None)
    ids = [chunk_id for chunk_id, _distance in ranked]
    if any(_CHUNK_ID.fullmatch(chunk_id) is None for chunk_id in ids):
        return RetrieveResult([], "chunk_id is not safe to query")
    try:
        query_id, rows = hydrate(ids)
    except Exception as exc:
        return RetrieveResult([], _short(exc))
    if not query_id:
        return RetrieveResult([], None)
    by_id = {row.get("chunk_id"): row for row in rows if isinstance(row, dict)}
    citations = []
    for chunk_id, _distance in ranked:
        row = by_id.get(chunk_id)
        if row is None:
            continue
        citation = _citation(query_id, row)
        if citation is not None:
            if chunk_id in generic_ids:
                # event-agnostic passage: the Investigator gives it its own claim
                citation["generic"] = True
            citations.append(citation)
    return RetrieveResult(citations, None)


def wants_generic(query: str, filters: dict | None) -> bool:
    """Insurer role, or a question about insurance, losses, claims, or policies."""
    role = (filters or {}).get("role")
    if isinstance(role, str) and role.lower() == "insurer":
        return True
    return bool(_INSURER_WORDS.search(query or ""))


def generic_doc_ids(event_id: str, scope: dict[str, str]) -> list[str]:
    """Event-agnostic doc_ids allowed in this event's run: EU-wide or same country."""
    country = _EVENT_COUNTRY.get(event_id)
    if country is None:
        return []
    return sorted(doc_id for doc_id, c in scope.items() if c in ("EU", country))


def watch_doc_ids(scope: dict[str, str], country: object = None) -> list[str]:
    """Event-agnostic doc_ids a LIVE-EU run may read: all, or EU-wide plus one country."""
    if isinstance(country, str) and country.strip():
        wanted = ("EU", country.strip().upper())
        return sorted(doc_id for doc_id, c in scope.items() if c in wanted)
    return sorted(scope)


_SCOPE_CACHE: dict[str, str] | None = None


_WATCH_CACHE: dict[str, str] | None = None


def load_watch_scope() -> dict[str, str]:
    """doc_id -> country of every event-agnostic document (the LIVE-EU run's scope)."""
    global _WATCH_CACHE
    if _WATCH_CACHE is None:
        load_scope()
    return _WATCH_CACHE or {}


def load_scope() -> dict[str, str]:
    """doc_id -> country of the event-agnostic insurer/authority documents (the event-run
    add-on). Citizen-audience river history is only in the watch scope. Read once."""
    global _SCOPE_CACHE, _WATCH_CACHE
    if _SCOPE_CACHE is None:
        import json

        try:
            data = json.loads(_SCOPE_FILE.read_text(encoding="utf-8"))
            _SCOPE_CACHE = {str(k): str(v) for k, v in data.get("generic", {}).items()}
            _WATCH_CACHE = {str(k): str(v) for k, v in data.get("watch", {}).items()}
        except (OSError, ValueError, AttributeError) as exc:
            import logging

            logging.getLogger("floodsense.retrieve_docs").warning(
                "rag_scope.json missing or invalid (%s); no generic passages will be added",
                exc.__class__.__name__,
            )
            _SCOPE_CACHE = {}
            _WATCH_CACHE = {}
    return _SCOPE_CACHE


def default_search_generic(
    vector: list[float], doc_ids: list[str], k: int
) -> list[tuple[str, float]]:
    dsn = os.environ.get("PGVECTOR_DSN", "")
    if not dsn:
        raise RuntimeError("PGVECTOR_DSN is not set")
    try:
        return _search_ids(dsn, _GENERIC_HALFVEC_SQL, vector, doc_ids, k)
    except Exception as exc:
        if "halfvec" not in str(exc).lower():
            raise RuntimeError(_hide(str(exc), dsn)) from None
        return _search_ids(dsn, _GENERIC_EXACT_SQL, vector, doc_ids, k)


def _search_ids(
    dsn: str, statement: str, vector: list[float], doc_ids: list[str], k: int
) -> list[tuple[str, float]]:
    sql = statement.replace("$1", "%(vector)s").replace("$2", "%(doc_ids)s").replace("$3", "%(k)s")
    rendered = "[" + ",".join(str(item) for item in vector) + "]"
    try:
        with _connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, {"vector": rendered, "doc_ids": list(doc_ids), "k": k})
                return [(str(chunk_id), float(distance)) for chunk_id, distance in cur.fetchall()]
    except Exception as exc:
        raise RuntimeError(_hide(str(exc), dsn)) from None


def default_embedder(texts: list[str], input_type: str) -> list[list[float]]:
    from floodsense_agents.nim_embed import DEFAULT_URL, EmbedError, embed_texts

    key = os.environ.get("NVIDIA_NIM_API_KEY", "")
    if not key:
        raise EmbedError("NVIDIA_NIM_API_KEY is not set")
    url = os.environ.get("NIM_EMBEDDINGS_URL") or DEFAULT_URL
    root = Path(__file__).resolve().parents[2]
    return embed_texts(texts, input_type, root=root, api_key=key, url=url)


def default_search(vector: list[float], event_id: str | None, k: int) -> list[tuple[str, float]]:
    dsn = os.environ.get("PGVECTOR_DSN", "")
    if not dsn:
        raise RuntimeError("PGVECTOR_DSN is not set")
    try:
        return _search(dsn, _HALFVEC_SQL, vector, event_id, k)
    except Exception as exc:
        if "halfvec" not in str(exc).lower():
            raise RuntimeError(_hide(str(exc), dsn)) from None
        return _search(dsn, _EXACT_SQL, vector, event_id, k)


def default_hydrate(chunk_ids: list[str], zetaris) -> tuple[str, list[dict]]:
    if any(_CHUNK_ID.fullmatch(chunk_id) is None for chunk_id in chunk_ids):
        raise ValueError("chunk_id is not safe to query")
    if not chunk_ids:
        return "", []
    quoted = ", ".join("'" + chunk_id + "'" for chunk_id in chunk_ids)
    sql = _HYDRATE_SQL.format(ids=quoted)
    if "<=>" in sql or "<->" in sql or "embedding" in sql.lower():
        raise ValueError("hydrate sql is not metadata only")
    evidence = zetaris.run_sql(sql)
    if evidence.error:
        raise RuntimeError(str(evidence.error)[:200])
    return evidence.query_id, list(evidence.rows_sample)


def _event_id(filters: dict | None) -> tuple[str | None, str | None]:
    if not filters or "event_id" not in filters or filters.get("event_id") is None:
        return None, None
    event_id = filters.get("event_id")
    if event_id in _EVENTS or event_id == WATCH_EVENT:
        return str(event_id), None
    return None, "event_id must be EMSR773, EMSR517 or LIVE-EU"


def _positive_int(value: object) -> int | None:
    """Zetaris REST returns every column as a string, so '3' counts as 3."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str) and value.isascii() and value.isdigit():
        value = int(value)
    if isinstance(value, int) and value >= 1:
        return value
    return None


def _citation(query_id: str, row: dict) -> dict | None:
    text = row.get("text")
    page = _positive_int(row.get("page"))
    if not isinstance(text, str) or page is None:
        return None
    paragraph = _positive_int(row.get("paragraph"))
    lines = row.get("lines")
    if paragraph is None:
        return None
    if not isinstance(lines, str) or not lines:
        return None
    quote, quote_lines = quote_from_text(text, lines)
    locator = {"page": page, "paragraph": paragraph, "lines": quote_lines}
    section = row.get("section")
    if isinstance(section, str) and section:
        locator["section"] = section
    chunk_id = row.get("chunk_id")
    citation = {
        "layer": "c",
        "query_id": query_id,
        "source_url": row.get("source_url"),
        "title": row.get("title"),
        "publisher": row.get("publisher"),
        "licence": row.get("licence"),
        "attribution": row.get("attribution"),
        "locator": locator,
        "quote": quote,
        "content_sha256": hashlib.sha256(quote.encode()).hexdigest(),
        "storage": "full_text",
        "chunk_id": chunk_id,
        "text": text,
        "text_sha256": row.get("text_sha256"),
    }
    return citation


def bind_search(
    statement: str, vector: list[float], event_id: str | None, k: int
) -> tuple[str, dict]:
    """Bind $1, $2, and $3 by name. The statements reuse $1 and $2."""
    sql = statement.replace("$1", "%(vector)s").replace("$2", "%(event_id)s").replace("$3", "%(k)s")
    rendered = "[" + ",".join(str(item) for item in vector) + "]"
    return sql, {"vector": rendered, "event_id": event_id, "k": k}


def _connect(dsn: str):
    import psycopg

    return psycopg.connect(dsn)


def _search(
    dsn: str, statement: str, vector: list[float], event_id: str | None, k: int
) -> list[tuple[str, float]]:
    sql, params = bind_search(statement, vector, event_id, k)
    try:
        with _connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                return [(str(chunk_id), float(distance)) for chunk_id, distance in cur.fetchall()]
    except Exception as exc:
        message = _hide(str(exc), dsn)
        if "halfvec" in message.lower():
            raise RuntimeError(message) from None
        raise RuntimeError(message) from None


def _hide(message: str, secret: str) -> str:
    if secret and secret in message:
        return "pgvector search failed"
    return message[:200]


def _short(exc: BaseException) -> str:
    return str(exc)[:200]
