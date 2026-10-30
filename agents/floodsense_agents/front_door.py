"""Chat front door: answer small talk before the graph runs.

"hello" or "what can you do?" used to start a full LangGraph run (minutes on
Nightshift). The front door classifies the message first:

    greeting | help | thanks | off_topic | flood_question

1. A rules pre-check. Clear cases (a bare "hi", "thanks", "what can you do",
   or any flood word) are decided without a model call.
2. Otherwise one fast-lane call (``TASK: front_door``) with a short deadline
   (FRONT_DOOR_TIMEOUT_S, default the API lookup timeout less 0.5 s, so 2.5 s),
   asked only for a message of at most six words that names no place. A failure, a timeout or a bad label falls back to
   the rules, and the rules fall back to ``flood_question``.

Only the four non-flood intents get a reply, and the reply text is a fixed,
role-aware template: the front door never states a flood fact. Anything that
might be a flood question, or that names an event or a document query, goes
to the cited agent run.
"""

from __future__ import annotations

import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any

from floodsense_agents.nightshift import LLM, parse_json, submit_with_deadline

log = logging.getLogger("floodsense.front_door")

INTENTS = ("greeting", "help", "thanks", "off_topic", "flood_question")
REPLY_INTENTS = ("greeting", "help", "thanks", "off_topic")

# Any of these sends the message to the full run, whatever the model says.
_FLOOD = re.compile(
    r"\b(flood\w*|inundat\w*|river\w*|rain\w*|precipit\w*|storm\w*|dana|gauge\w*|"
    r"level\w*|water\w*|risk\w*|warn\w*|alert\w*|forecast\w*|hazard\w*|emsr\w*|"
    r"exposure|exposed|polic(?:y|ies)|insur\w*|claims?|evacuat\w*|"
    r"valencia|ahr|rhine|rhein|k[oö]ln|cologne|spain|germany|europe|"
    r"copernicus|efas|glofas|hochwasser|inundaci\w*|riada|lluvia\w*|"
    r"station\w*|basin|catchment|weather|safe|danger\w*|damage\w*|"
    r"riesgo\w*|inund\w*|überschwemm\w*|keller\w*|basement\w*|wet|pegel\w*|"
    r"crecida\w*|r[ií]o\w*|fluss\w*|flüsse\w*|"
    r"2021|2024|48\s*h|next\s+\d+)\b",
    re.I,
)
_GREETING = re.compile(
    r"^(hi+|hello+|hey+|hiya|yo|howdy|good\s+(morning|afternoon|evening|day)|"
    r"greetings|hallo|guten\s+(morgen|tag|abend)|servus|moin|hola|buenos\s+d[ií]as|"
    r"buenas(\s+tardes|\s+noches)?|bonjour|ciao|salut)\b[\s!.,?¿¡]*"
    r"(there|all|everyone|floodsense|team)?[\s!.,?¿¡]*"
    r"((how\s+are\s+you|how\s+are\s+things|how'?s\s+it\s+going|how\s+is\s+it\s+going|"
    r"what'?s\s+up|wie\s+geht'?s|qu[eé]\s+tal|c[oó]mo\s+est[aá]s|[cç]a\s+va)"
    r"(\s+(today|doing))?[\s!.,?¿¡]*(floodsense|there)?[\s!.,?¿¡]*)?$",
    re.I,
)
_THANKS = re.compile(
    r"^(thanks?(\s+you)?|thank\s+you(\s+(so|very)\s+much)?|thx|ty|cheers|"
    r"danke(\s+sch[oö]n)?|gracias|merci|great,?\s+thanks?|perfect,?\s+thanks?|"
    r"ok(ay)?,?\s+thanks?|that'?s\s+(great|helpful))[\s!.,]*(a\s+lot|so\s+much)?[\s!.,]*$",
    re.I,
)
_HELP = re.compile(
    r"^(help|\?|what\s+(can|do)\s+you\s+do|what\s+are\s+you|who\s+are\s+you|"
    r"how\s+do(es)?\s+(this|it|you)\s+work|what\s+can\s+i\s+ask(\s+you)?|"
    r"what\s+should\s+i\s+ask|how\s+can\s+you\s+help(\s+me)?|what\s+is\s+(this|floodsense)|"
    r"what('?s|\s+is)\s+floodsense|tell\s+me\s+about\s+yourself|"
    r"what\s+do\s+you\s+know)\b[\s?!.]*(here|exactly|for\s+me)?[\s?!.]*$",
    re.I,
)
_OFF_TOPIC = re.compile(
    r"\b(joke|poem|song|recipe|football|soccer|movie|film|bitcoin|crypto|stock\s+price|"
    r"capital\s+of|write\s+(me\s+)?(a|an)\s+(essay|story|code)|translate|homework)\b",
    re.I,
)

SYSTEM = """TASK: front_door
You route one chat message for FloodSense EU, a flood-risk assistant for Europe.
Answer with JSON only: {"intent": "<one of: greeting, help, thanks, off_topic, flood_question>"}.
greeting: a hello with no question. help: asks what you can do or how to use you.
thanks: thanks or praise with no question. off_topic: a request with nothing to do with
floods, rivers, weather, risk, insurance exposure or past flood events.
flood_question: anything else, and every case where you are unsure.
Do not answer the message."""


def _timeout_s() -> float:
    """The model's budget. Defaults to the API's lookup timeout (CACHE_LOOKUP_TIMEOUT_S,
    3 s) less a margin, so the API never gives up first and leaves a call running."""
    raw = os.environ.get("FRONT_DOOR_TIMEOUT_S")
    try:
        if raw:
            return float(raw)
        return max(0.5, float(os.environ.get("CACHE_LOOKUP_TIMEOUT_S") or 3) - 0.5)
    except ValueError:
        return 2.5


MAX_REPLY_WORDS = 6
_WORD = re.compile(r"[^\W\d_][\w'-]*")
_SKIP_CAPS = {"i", "floodsense", "ok", "okay"}


def _short_without_place(question: str) -> bool:
    """A model reply label is trusted only for a short message naming no place.

    A capitalised word after the first one is taken as a place (Bonn, Paiporta).
    """
    words = _WORD.findall(question or "")
    if len(words) > MAX_REPLY_WORDS:
        return False
    return not any(w[0].isupper() and w.lower() not in _SKIP_CAPS for w in words[1:])


def enabled() -> bool:
    v = (os.environ.get("FF_FRONT_DOOR") or "true").strip().lower()
    return v in ("1", "true", "yes", "on")


def rules(question: str) -> tuple[str, bool]:
    """(intent, decisive). Not decisive means the model may still decide."""
    q = " ".join((question or "").split())
    if not q:
        return "help", True
    # The product's own name ("FloodSense") is not a flood word.
    if _FLOOD.search(re.sub(r"flood\s*sense", " ", q, flags=re.I)):
        return "flood_question", True
    if _GREETING.match(q):
        return "greeting", True
    if _THANKS.match(q):
        return "thanks", True
    if _HELP.match(q):
        return "help", True
    if _OFF_TOPIC.search(q):
        return "off_topic", False
    return "flood_question", False


_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="front-door")


def _ask_model(llm: LLM, question: str, timeout: float) -> tuple[str, str] | None:
    """(intent, model_id) from one fast-lane call, or None on any failure."""
    fut = submit_with_deadline(_POOL, timeout, llm.complete, "fast", SYSTEM, question[:500])
    try:
        text, model_id = fut.result(timeout=timeout)
        intent = str(parse_json(text).get("intent", "")).strip().lower()
    except FutureTimeout:
        log.warning("front door: fast lane over %.0fs; using rules", timeout)
        return None
    except Exception as e:  # noqa: BLE001 - any model failure falls back to rules
        log.warning("front door: fast lane failed (%s); using rules", type(e).__name__)
        return None
    if intent not in INTENTS:
        return None
    return intent, model_id


def classify(question: str, llm: LLM | None = None) -> tuple[str, str]:
    """(intent, model_id). model_id is "rules" when no model decided."""
    intent, decisive = rules(question)
    if decisive:
        return intent, "rules"
    if not _short_without_place(question):
        return "flood_question", "rules"  # long or names a place: the cited run
    if llm is None:
        return intent, "rules"
    got = _ask_model(llm, question, _timeout_s())
    if got is None:
        return intent, "rules"
    return got


_SUGGEST = {
    "citizen": [
        "Is Valencia at risk of flooding in the next 48 hours?",
        "What are the river levels on the Ahr right now?",
        "What happened in the Valencia floods of October 2024?",
    ],
    "insurer": [
        "Which insured sites are exposed in Valencia right now?",
        "What alerts would you draft for the Ahr 2021 event?",
        "Show the evidence behind the exposure for EMSR773.",
    ],
    "operator": [
        "Which gauges on the Elbe are above normal?",
        "Brief me on the Rhine at Köln",
        "What does the 48 h outlook show along the Danube?",
    ],
}

_WHAT = {
    "citizen": (
        "I can tell you the flood risk at a place and why, show live river levels, "
        "and walk you through past floods such as Valencia 2024 and the Ahr 2021. "
        "Every answer comes with its sources."
    ),
    "insurer": (
        "I can show which insured sites are exposed to a flood, draft alerts that a "
        "person approves before anything is sent, and give the evidence and sources "
        "behind every number."
    ),
    "operator": (
        "I can brief you on any of our 45 watched places, show upstream gauges, and prepare "
        "a script for callers. Every line comes from a stated source, and I never issue "
        "a warning or a forecast of my own."
    ),
}

_OPENER = {
    "greeting": "Hello! I'm FloodSense.",
    "help": "Here is what I can help with.",
    "thanks": "You're welcome, glad it helped.",
    "off_topic": ("Sorry, I can only help with flood risk in Europe, so I can't answer that one."),
}


def reply_text(intent: str, role: str | None) -> tuple[str, list[str]]:
    r = role if role in _WHAT else "citizen"
    tail = {
        "greeting": _WHAT[r],
        "help": _WHAT[r],
        "thanks": "Ask me anything else about flood risk. " + _WHAT[r],
        "off_topic": _WHAT[r],
    }[intent]
    return f"{_OPENER[intent]} {tail} Try one of these:", list(_SUGGEST[r])


def explicit_run(req: Any) -> bool:
    """An explicit event, replay moment or document query always gets the full run.

    The UI mirrors the question into doc_query; that mirror is not explicit.
    """
    if getattr(req, "event_id", None) or getattr(req, "replay_ts", None):
        return True
    doc = (getattr(req, "doc_query", None) or "").strip()
    q = (getattr(req, "question", None) or "").strip()
    return bool(doc) and doc.casefold() != q.casefold()


def front_door(req: Any, llm: LLM | None) -> dict | None:
    """A ReplyResponse dict, or None when the request goes to the full run."""
    if not enabled() or explicit_run(req):
        return None
    t0 = time.monotonic()
    intent, model_id = classify(req.question, llm)
    if intent not in REPLY_INTENTS:
        return None
    ctx = getattr(req, "context", None)
    answer, suggestions = reply_text(intent, getattr(ctx, "role", None))
    return {
        "kind": "reply",
        "lane": "reply",  # router.py: the reply lane
        "intent": intent,
        "answer": answer,
        "suggestions": suggestions,
        "model_id": model_id,
        "latency_ms": int((time.monotonic() - t0) * 1000),
    }
