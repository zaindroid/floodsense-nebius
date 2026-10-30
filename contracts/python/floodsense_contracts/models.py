"""Hand-checked Pydantic models for the shared contracts.

Wire names are the schema names (snake_case). Do not add fields here
without adding them to contracts/schemas/floodsense.schema.json.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Same strings as date_time and content_sha256 in the schema. CI enforces the schema.
DATE_TIME = (
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$"
)
SHA256 = r"^[a-f0-9]{64}$"

Layer = Literal["a", "b", "c"]
Storage = Literal["full_text", "pointer"]
Grounding = Literal["supported", "partial", "unsupported"]
ServedFrom = Literal["live", "cache", "replay"]
Lane = Literal["quick", "forecast", "full"]  # run lanes; a front-door reply is lane "reply"
ApprovalStatus = Literal["pending", "approved", "edited", "rejected"]
ActionType = Literal[
    "notify-policyholders", "dispatch-loss-adjuster", "flag-underwriting-review", "inform-public"
]
ModelId = Literal[
    "meterless/fast",
    "meterless/deep",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "nvidia/Nemotron-3.5-Super-VL",
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    "deterministic",
]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Locator(ContractModel):
    section: str | None = None
    # Optional on layers a and b. On layer c the validator rejects null.
    # A section-structured source still sets a page-like id. Section does not replace page.
    page: int | None = Field(default=None, ge=1)
    paragraph: int | None = Field(default=None, ge=1)
    lines: str | None = None


class Citation(ContractModel):
    citation_id: str
    claim_id: str
    layer: Layer
    source_url: str
    title: str
    publisher: str
    accessed_at: str = Field(pattern=DATE_TIME)
    licence: str
    attribution: str
    # When quote is present, SHA-256 hex of that quote as UTF-8 (what the Judge compares).
    content_sha256: str = Field(pattern=SHA256)
    storage: Storage
    locator: Locator | None = None
    quote: str | None = None
    query_id: str | None = None
    chunk_id: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def layer_c_names_the_passage(self) -> Citation:
        """Layer c requires page >= 1 even when section is set. Section does not replace page."""
        if self.layer != "c":
            return self
        loc = self.locator
        if (
            not self.quote
            or not self.query_id
            or loc is None
            or loc.page is None
            or loc.paragraph is None
            or not loc.lines
        ):
            raise ValueError(
                "layer c requires quote, query_id, and locator.page, "
                "locator.paragraph, and locator.lines"
            )
        return self


class Evidence(ContractModel):
    query_id: str
    view: str
    sql: str
    rows_sample: list[dict[str, Any]] = Field(max_length=20)
    row_count: int = Field(ge=0)
    executed_at_utc: str = Field(pattern=DATE_TIME)


class DroppedNumber(ContractModel):
    value: float
    reason: str = Field(min_length=1)


class Claim(ContractModel):
    claim_id: str
    text: str
    numbers_dropped: list[DroppedNumber] | None = None


class JudgeClaim(ContractModel):
    claim_id: str
    grounding: Grounding
    citation_faithful: bool
    numbers_match: bool
    score: float = Field(ge=0, le=1)
    rationale: str
    model_id: ModelId
    numbers_dropped: list[DroppedNumber] | None = None


class Judge(ContractModel):
    claims: list[JudgeClaim] = Field(min_length=1)
    overall_score: float = Field(ge=0, le=1)


class PlaybookAction(ContractModel):
    action_id: str
    run_id: str
    title: str
    detail: str
    citation_ids: list[str] = Field(min_length=1)
    # Optional approval-card fields (v0.13).
    action_type: ActionType | None = None
    target_region: str | None = None
    affected_site_count: int | None = Field(default=None, ge=0)
    draft_message: str | None = None
    outbound: bool = False
    released: bool = False


class Approval(ContractModel):
    approval_id: str
    run_id: str
    action_id: str
    status: ApprovalStatus
    note: str | None = None
    judge: Judge | None = None


class MemoryUsed(ContractModel):
    memory_id: str = Field(min_length=1)
    run_id: str | None = None
    claim_id: str | None = None
    approved_at: str | None = None
    text: str
    relevance: float | None = None
    reviewer: str | None = None
    seeded: bool


class Forecast(ContractModel):
    """Forecast lane only: a screening status and a template lead, never official."""

    status: Literal["Normal", "Watch", "Elevated"]
    status_label: str | None = None
    status_reason: str | None = None
    places: list[str] = Field(default_factory=list)
    horizon_h: int | None = Field(default=None, ge=1)
    lead: str | None = None
    screening: str | None = None
    gaps: list[str] = Field(default_factory=list)
    disclaimer: str = Field(min_length=1)
    attribution: str | None = None


class Plain(ContractModel):
    """Quick and forecast lanes: the calm, plain-language answer. Fixed rules, no model."""

    headline: str = Field(min_length=1)
    one_line: str = Field(min_length=1)
    horizon: Literal["48h", "7d"]
    status: Literal["normal", "watch", "elevated", "unknown"]
    basis: Literal["gauge", "model"] | None = None
    places: list[str] = Field(default_factory=list)
    country: str | None = None
    countries: list[str] = Field(default_factory=list)
    service: str | None = None
    context: str | None = None
    next_step: str = Field(min_length=1)
    disclaimer: str = Field(min_length=1)
    details: list[str]


class Answer(ContractModel):
    run_id: str
    question: str
    claims: list[Claim] = Field(min_length=1)
    citations: list[Citation] = Field(min_length=1)
    evidence: list[Evidence]
    served_from: ServedFrom
    cached_at: str | None = Field(default=None, pattern=DATE_TIME)
    playbook_actions: list[PlaybookAction] = Field(default_factory=list)
    judge: Judge | None = None
    lane: Lane | None = None
    router_reason: str | None = None
    forecast: Forecast | None = None
    plain: Plain | None = None
    memory_used: list[MemoryUsed] = Field(default_factory=list)

    @model_validator(mode="after")
    def cached_at_matches_served_from(self) -> Answer:
        if self.served_from == "live":
            if self.cached_at is not None:
                raise ValueError("cached_at must be null when served_from is live")
        elif self.cached_at is None:
            raise ValueError("cached_at is required when served_from is not live")
        return self


ReplyIntent = Literal["greeting", "help", "thanks", "off_topic"]


class ReplyResponse(ContractModel):
    """Front-door reply to POST /runs. No run_id; never a flood fact."""

    kind: Literal["reply"]
    intent: ReplyIntent
    answer: str = Field(min_length=1)
    suggestions: list[str] = Field(max_length=3)
    model_id: str = Field(min_length=1)
    latency_ms: int = Field(ge=0)
    lane: Literal["reply"] | None = None


# What POST /runs returns.
RunResponse = Answer | ReplyResponse


# ---- Control tower (GET /watch/events, /watch/stream, /watch/status) ----

WatchKind = Literal[
    "detected", "checked", "exposure", "drafted", "awaiting_approval", "approved", "info"
]
WatchAgent = Literal["Watch", "Forecast", "Exposure", "Playbook", "Judge", "Human"]
WatchTone = Literal["normal", "watch", "elevated", "neutral", "unknown"]


class WatchSource(ContractModel):
    """The contract view and the Zetaris query id behind an event."""

    view: str = Field(min_length=1)
    query_id: str | None = None


class WatchEvent(ContractModel):
    """One activity-feed row. Fixed-template text; no model writes it."""

    id: str = Field(pattern=r"^w[0-9]{8}$")
    ts: str = Field(pattern=DATE_TIME)
    kind: WatchKind
    agent: WatchAgent
    place_id: str | None = None
    place: str
    river: str
    country: str
    status: str
    tone: WatchTone
    text: str = Field(min_length=1)
    run_id: str | None = None
    source: WatchSource
    detail: str | None = None
    data: dict[str, Any]


class WatchStatus(ContractModel):
    """GET /watch/status: loop, last scan, counts and the auto-assess switch with its caps."""

    note: str
    loop: dict[str, Any]
    scanning: bool
    started_at: str = Field(pattern=DATE_TIME)
    last_cycle: dict[str, Any] | None = None
    counts: dict[str, Any]
    latest_event_id: str | None = None
    awaiting_run_ids: list[str]
    auto_assess: dict[str, Any]
    persisted: bool
    persisted_reason: str | None = None
    served_from: ServedFrom
    cached_at: str | None = None
