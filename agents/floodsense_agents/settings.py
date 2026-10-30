"""Runtime settings, read from the environment (agents/.env under Compose).

Names match agents/.env.example. No secrets are stored here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def _flag(name: str, default: bool) -> bool:
    v = _env(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    # Zetaris: the only data path for agents (GAMEPLAN "win line")
    zetaris_rest_url: str | None = _env("ZETARIS_REST_URL")
    zetaris_org_id: str = _env("ZETARIS_ORG_ID", "1")
    zetaris_api_key: str | None = _env("ZETARIS_API_KEY")
    zetaris_user: str | None = _env("ZETARIS_USER")
    zetaris_password: str | None = _env("ZETARIS_PASSWORD")
    zetaris_mode: str = _env(
        "ZETARIS_MODE", "auto"
    )  # auto | live | fake   (fake = in-memory seed views, no network)
    zetaris_row_limit: int = int(_env("ZETARIS_ROW_LIMIT", "5000"))
    # Independent SELECTs in one node. 8 covers Watchers (5), Investigator (5),
    # and Exposure (3). 1 runs that fan-out one statement at a time.
    zetaris_max_parallel: int = int(_env("ZETARIS_MAX_PARALLEL", "8"))
    live_data: bool = _flag("FF_LIVE_DATA", False)  # floodsense.* instead of floodsense_seed.*

    # Nightshift (Meterless): every LLM call goes through one client on pinned lanes
    meterless_base_url: str | None = _env("METERLESS_BASE_URL")
    meterless_app: str = _env("METERLESS_APP", "floodsense-eu")
    meterless_scope: str = _env("METERLESS_SCOPE", "user")
    meterless_runtime_token: str = _env("METERLESS_RUNTIME_TOKEN", "") or ""
    model_fast: str = _env("MODEL_FAST", "meterless/fast")
    model_deep: str = _env("MODEL_DEEP", "meterless/deep")
    # Nebius Token Factory (LLM_BACKEND=nebius): see NebiusClient in nightshift.py
    llm_backend: str = _env("LLM_BACKEND", "nightshift")  # nightshift | nebius
    nebius_api_key: str = _env("NEBIUS_API_KEY", "") or ""
    nebius_base_url: str = _env("NEBIUS_BASE_URL", "https://api.tokenfactory.nebius.com/v1")
    nebius_model_fast: str = _env("NEBIUS_MODEL_FAST", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B")
    nebius_model_deep: str = _env("NEBIUS_MODEL_DEEP", "nvidia/Nemotron-3.5-Super-VL")
    llm_timeout_s: float = float(_env("LLM_TIMEOUT_S", "180"))
    # Attempts per call for transient errors (5xx, connection, bad JSON body).
    # A read timeout is never retried: it already cost llm_timeout_s, and the
    # node falls back to its deterministic path instead of waiting again.
    llm_max_attempts: int = int(_env("LLM_MAX_ATTEMPTS", "2"))
    # An error that arrives after this many seconds is not retried either
    # (Nightshift's gateway answers 502 at ~45 s on long generations).
    llm_slow_fail_s: float = float(_env("LLM_SLOW_FAIL_S", "20"))
    # Stream chat completions (SSE) and assemble the reply. The gateway's
    # 502 at ~45 s cuts a non-streamed request only: a stream gets its first
    # bytes at once and runs to the end (measured 74-84 s, no 502).
    llm_stream: bool = _flag("LLM_STREAM", True)
    # Upper bound on completion tokens per lane. Nemotron on Nightshift counts
    # its hidden reasoning here (2-4k tokens measured), so the cap is a
    # runaway guard, not a length budget. 0 = send no max_tokens.
    llm_max_tokens_fast: int = int(_env("LLM_MAX_TOKENS_FAST", "6000"))
    llm_max_tokens_deep: int = int(_env("LLM_MAX_TOKENS_DEEP", "8000"))
    # Concurrent model calls inside one node (Skeptic rationales, Judge
    # grounding). Nightshift serves them in parallel; 1 = serial.
    llm_max_parallel: int = int(_env("LLM_MAX_PARALLEL", "6"))
    # Repair round only when the Judge did not pass the run. True restores
    # the old behaviour (repair any flagged claim even on a passing run).
    judge_repair_when_passing: bool = _flag("JUDGE_REPAIR_WHEN_PASSING", False)
    llm_mode: str = _env(
        "LLM_MODE", "auto"
    )  # auto | live | fake   (fake = deterministic offline model)

    # Engines sidecar (engines/): H-MEM and the World Model. Unset = off.
    engines_url: str | None = _env("ENGINES_URL")
    engines_timeout_s: float = float(_env("ENGINES_TIMEOUT_S", "5"))
    hmem_recall_top_n: int = int(_env("HMEM_RECALL_TOP_N", "3"))
    # 0 while the engines embed with their reference hash; see engines.RECALL_POOL
    hmem_recall_threshold: float = float(_env("HMEM_RECALL_THRESHOLD", "0"))

    # Feature flags (defaults from agents/.env.example; a slipped increment stays behind its flag)
    ff_skeptic: bool = _flag("FF_SKEPTIC", True)
    ff_hitl: bool = _flag("FF_HITL", True)
    # On, matching agents/.env.example. A process with the variable unset
    # follows that file; tests that need the judge off pass ff_judge=False.
    ff_judge: bool = _flag("FF_JUDGE", True)
    ff_hmem: bool = _flag("FF_HMEM", False)
    ff_rag_docs: bool = _flag("FF_RAG_DOCS", False)
    ff_tavily: bool = _flag("FF_TAVILY", False)  # cited web context via Tavily Search
    tavily_api_key: str | None = _env("TAVILY_API_KEY")
    tavily_timeout_s: float = float(_env("TAVILY_TIMEOUT_S", "6"))

    # Skeptic / Judge knobs
    skeptic_max_rounds: int = int(_env("SKEPTIC_MAX_ROUNDS", "3"))
    judge_repair_rounds: int = int(_env("JUDGE_REPAIR_ROUNDS", "1"))
    judge_min_score: float = float(
        _env("JUDGE_MIN_SCORE", "0.7")
    )  # proposal until the first eval run
    numeric_tolerance: float = float(
        _env("NUMERIC_TOLERANCE", "0.02")
    )  # 2 % relative, for numbers_match

    # HITL checkpointer: SQLite under the compose volume; memory when the directory is not writable
    checkpoint_dir: str = _env("CHECKPOINT_DIR", "/data/checkpoints")
    checkpointer: str = _env("CHECKPOINTER", "auto")  # auto | sqlite | memory

    # Agents service (internal to the compose network; the API proxies it)
    # Build identity for GET /version; the image build sets these.
    git_sha: str = _env("GIT_SHA", "unknown")
    built_at: str = _env("BUILT_AT", "unknown")

    host: str = _env("AGENTS_HOST", "0.0.0.0")
    port: int = int(_env("AGENTS_PORT", "8100"))

    @property
    def schema(self) -> str:
        return "floodsense" if self.live_data else "floodsense_seed"

    def lane(self, name: str) -> str:
        """The routing id for one lane.

        This is the only place the app chooses ``meterless/fast`` or
        ``meterless/deep``. The map from those ids to the model that answers
        today lives in ``docs/architecture/c4.md``. A value set in the
        environment after import is used; otherwise the field, which tests
        can assign.
        """
        if self.llm_backend == "nebius" and name in ("fast", "deep"):
            return self.nebius_model_fast if name == "fast" else self.nebius_model_deep
        if name == "fast":
            env_name, field, default = "MODEL_FAST", self.model_fast, "meterless/fast"
        elif name == "deep":
            env_name, field, default = "MODEL_DEEP", self.model_deep, "meterless/deep"
        else:
            raise KeyError(name)
        raw = os.environ.get(env_name)
        if raw:
            return raw
        return field or default


settings = Settings()
