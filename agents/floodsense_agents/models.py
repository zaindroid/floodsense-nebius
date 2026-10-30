"""Contracts shared by the agents, the API, the Judge and the UI.

Shapes follow docs/GAMEPLAN.md §5.5 field for field. Anything beyond the
contract is marked "extra" and the UI may ignore it.

Evidence (layer a)  {query_id, view, sql, rows_sample[<=20], row_count, executed_at_utc}
Citation record     {citation_id, claim_id, layer a|b|c, source_url, title, publisher, accessed_at, licence, attribution,
                     locator{section,page,paragraph,lines}, quote, content_sha256, storage full_text|pointer, query_id?}
Judge score         {claim_id, grounding supported|partial|unsupported, citation_faithful, numbers_match, score 0-1, rationale, model_id}
Agent state         run_id, thread_id, event_id, customer_id, replay_ts, anomalies[], hypotheses[{id, link, status, evidence[],
                     citations[], rounds}], exposure{}, playbook[], judge[], approval{status, decision, edits, reviewer_note}, trace[]
Trace event         {run_id, seq, ts, node, lane, model_id, latency_ms, tokens, summary, evidence_ids[]}

The Zetaris view column names are still a proposal; see zetaris.py.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Layer = Literal["a", "b", "c"]
Grounding = Literal["supported", "partial", "unsupported"]


class Evidence(BaseModel):
    query_id: str
    view: str
    sql: str
    rows_sample: list[dict[str, Any]] = Field(default_factory=list)
    row_count: int = 0
    executed_at_utc: str
    source: str = "zetaris"  # extra: zetaris | zetaris-fake
    error: str | None = None  # extra: a failed query is still evidence of a failed query


class Locator(BaseModel):
    section: str | None = None
    page: int | None = None
    paragraph: int | None = None
    lines: str | None = None


class Citation(BaseModel):
    citation_id: str
    claim_id: str
    layer: Layer
    source_url: str | None = None
    title: str | None = None
    publisher: str | None = None
    accessed_at: str | None = None
    licence: str | None = None
    attribution: str | None = None
    locator: Locator | None = None
    quote: str | None = None
    content_sha256: str | None = None
    storage: Literal["full_text", "pointer"] | None = None
    query_id: str | None = None
    chunk_id: str | None = None


class Claim(BaseModel):
    claim_id: str
    text: str
    kind: Literal["fact", "number", "cause", "action"] = "fact"
    numbers: list[float] = Field(
        default_factory=list
    )  # numbers stated in the text; the Judge checks each against the cited rows
    citations: list[Citation] = Field(default_factory=list)
    hypothesis_id: str | None = None  # which causal link the claim backs
    # Numbers the Investigator took off `numbers`, each {value, reason}: a date
    # part, a named declared line, or a coordinate filter. Kept for audit.
    numbers_dropped: list[dict] = Field(default_factory=list)


class Hypothesis(BaseModel):
    """One link of the causal chain.

    `link` names the edge; the Skeptic sets `status` and `rounds`.
    """

    id: str  # H1..Hn
    link: Literal["rain->catchment", "catchment->river", "river->site", "site->exposure"]
    statement: str
    status: Literal["proposed", "supported", "not_supported"] = "proposed"
    evidence: list[str] = Field(default_factory=list)  # query ids: the Skeptic's counter-checks
    citations: list[str] = Field(default_factory=list)  # claim ids that back the link
    rounds: int = 0
    rationale: str = ""  # extra: Skeptic's reason


class Anomaly(BaseModel):
    id: str
    kind: Literal["rain", "discharge", "warning"]
    point_id: str
    ts_utc: str
    value: float | None = None
    unit: str | None = None
    why: str
    query_id: str
    horizon: str | None = None  # extra: live mode only, past | forecast (hazard_now.horizon)


class ExposedAsset(BaseModel):
    policy_id: str
    site_id: str
    lat: float | None = None
    lon: float | None = None
    segment: str | None = None
    sum_insured_eur: float | None = None


class Exposure(BaseModel):
    assets: list[ExposedAsset] = Field(default_factory=list)
    policies: int = 0
    sum_insured_eur: float = 0.0
    by_segment: list[dict[str, Any]] = Field(default_factory=list)
    query_ids: list[str] = Field(default_factory=list)


ActionType = Literal[
    "notify-policyholders",
    "dispatch-loss-adjuster",
    "flag-underwriting-review",
    "inform-public",
]


class PlaybookAction(BaseModel):
    action_id: str
    horizon_h: Literal[6, 24, 72]
    text: str
    claim_ids: list[str] = Field(default_factory=list)
    outbound: bool = False  # contacts a person or authority: waits for approval
    released: bool = False  # set by HITL on approve / edit
    # extra (approval card). All optional so older runs still load.
    action_type: ActionType | None = None
    title: str | None = None
    target_region: str | None = None
    # Distinct exposed sites from the Exposure node's query. None when unknown.
    affected_site_count: int | None = None
    # The exact text that would be sent. Nothing is sent before approval; it
    # states only facts from the claims in claim_ids.
    draft_message: str | None = None


class JudgeScore(BaseModel):
    claim_id: str
    grounding: Grounding
    citation_faithful: bool
    numbers_match: bool
    score: float
    rationale: str
    model_id: str
    coverage: bool = True  # extra
    licence_ok: bool = True  # extra


class JudgeSummary(BaseModel):
    """Extra: run-level metrics next to the per-claim scores (contract: judge[] + overall)."""

    overall: float
    n_claims: int
    hallucination_rate: float
    citation_coverage: float
    numeric_accuracy: float
    passes: bool
    flagged_claim_ids: list[str] = Field(default_factory=list)
    model_id: str


class Approval(BaseModel):
    status: Literal["not_reached", "awaiting", "approved", "edited", "rejected", "auto"] = (
        "not_reached"
    )
    decision: Literal["approve", "edit", "reject"] | None = None
    edits: str | None = None
    reviewer_note: str | None = None
    reviewer: str | None = None  # extra
    decided_at_utc: str | None = None  # extra


class ApprovalDecision(BaseModel):
    action: Literal["approve", "edit", "reject"]
    edits: str | None = None  # the analyst's summary replaces ours on edit
    reviewer_note: str | None = None
    reviewer: str | None = None
    # extra: on edit, a replacement draft_message per action_id.
    draft_messages: dict[str, str] | None = None


class TraceEvent(BaseModel):
    run_id: str
    seq: int
    ts: str
    node: str
    lane: str | None = None  # fast | deep | sql | none
    model_id: str | None = None
    latency_ms: int | None = None
    tokens: int | None = None
    summary: str
    evidence_ids: list[str] = Field(default_factory=list)
    phase: Literal["started", "finished"] = "finished"  # extra: a trace entry is a finished step
    duration_ms: int | None = None  # extra: same value as latency_ms
    provider: str | None = None  # extra: backend that served model_id (nightshift | nebius)


# A replay clock is a UTC instant and nothing else. Callers compare it and
# bind it into SQL, so it is normalised here to YYYY-MM-DDTHH:MM:SSZ.
_UTC_LOOSE = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?Z?$")
UTC_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def normalize_utc(value: str) -> str:
    """Canonical UTC instant. Rejects anything that is not a clock."""
    match = _UTC_LOOSE.fullmatch((value or "").strip())
    if not match:
        raise ValueError("replay_ts must be a UTC instant such as 2024-10-29T16:00:00Z")
    date, hour, minute, second = match.groups()
    return f"{date}T{hour}:{minute}:{second or '00'}Z"


class RunContext(BaseModel):
    """What the user is looking at. Allowlisted keys, short strings only.

    Never an SQL identifier: point_id is used only when it is a known point
    (events.POINT_NAMES), station only as an escaped string literal, and
    event_id only through events.spec.
    """

    model_config = ConfigDict(extra="forbid")

    page: str | None = Field(default=None, pattern=r"^[a-z][a-z_-]{0,23}$")
    role: Literal["citizen", "insurer", "operator"] | None = None
    place: str | None = Field(default=None, min_length=1, max_length=64, pattern=r"^[\w .,'()-]+$")
    point_id: str | None = Field(default=None, pattern=r"^[A-Z]{3}\d{2}$")
    station: str | None = Field(default=None, pattern=r"^[A-Za-zÄÖÜäöüß .-]{2,40}$")
    event_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_]{1,24}$")
    replay_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    # True on a run the control tower started by itself (FF_AUTO_ASSESS). A tag only.
    auto: bool | None = None


class RunRequest(BaseModel):
    question: str
    # None lets events.route_event pick: context, then the question (Rhine, Köln, Ahr ->
    # EMSR517), else EMSR773. An explicit id always stands.
    event_id: str | None = None  # Copernicus activation; EMSR773 Valencia 2024, EMSR517 Ahr 2021
    customer_id: str = "demo-insurer"
    replay_ts: str | None = (
        None  # "now" of the replay, e.g. 2024-10-29T16:00:00Z; null = whole window
    )
    lang: str = "en"
    reviewer: str | None = None
    # extra: continue a conversation. An earlier run's thread_id; the new run
    # gets that thread's earlier turns as short-term memory. Null starts a thread.
    thread_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,64}$")
    # extra: layer (c) document search. The Investigator calls retrieve_docs with
    # it once when FF_RAG_DOCS is on. Null or blank skips retrieval.
    doc_query: str | None = None
    # extra: event replays the event window; live reads hazard_now (past days and
    # the ~48 h forecast). Null lets live.resolve_mode classify the question.
    # replay_ts set always means event.
    mode: Literal["event", "live"] | None = None
    # extra: what the user is looking at (page, role, place, point, station).
    # A selected station, point or place wins over the default event.
    context: RunContext | None = None

    @field_validator("replay_ts")
    @classmethod
    def _utc_instant(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        return normalize_utc(v)
