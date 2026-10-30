"""Client for the engines sidecar (engines/): H-MEM memory and the World Model.

ENGINES_URL unset means the engines are off. build_engines() returns None,
the graph keeps NoMemory and NoWorld, and nothing is sent.

With ENGINES_URL set:

- Memory, behind FF_HMEM. recall() gives the Investigator past approved
  findings on the same flood event as context. store() writes the claims of
  an approved or edited run. The engines key a memory by (run_id, claim_id),
  so a retried store writes nothing twice, and any other approval status
  writes nothing.
- World Model. The Watchers' anomalies become observations, and each
  hypothesis write records its status, so the board shows how the Skeptic
  moved every link of the chain.

Wire names are the agents' own (models.py): the engines take model_dump()
output as it is and ignore fields they do not use. See engines/README.md.

The engines are a side channel. Every call raises EnginesError on failure,
and the nodes turn that into a trace note. A run never fails because the
engines are down.
"""

from __future__ import annotations

import logging
import time
import unicodedata
from typing import Any, Protocol

import httpx

from floodsense_agents.settings import settings

log = logging.getLogger("floodsense.engines")

ERROR_SNIPPET = 200
# The engines' reference embedder is a token hash, not semantic: a related
# question and an unrelated one both score about 0.2 to 0.3. So recall asks for
# a wide pool with no score cut and keeps the findings tagged with this run's
# event. Real embeddings (Nightshift's embed lane) are what make cross-event
# recall meaningful; HMEM_RECALL_THRESHOLD can rise then.
RECALL_POOL = 50  # engines TOP_N_MAX
# The ranker can bury a fresh approved memory under old ones (the token-hash
# embedder), so recall also reads the newest memories, read-only, cached.
RECENT_LIMIT = 50
RECENT_TTL_S = 30.0
RECENT_MAX = 2  # recent additions per recall, so they cannot crowd out the ranked ones


class EnginesError(RuntimeError):
    """The engines could not be reached, or answered with an error."""


class WorldModel(Protocol):
    """The World Model board. NoWorld when ENGINES_URL is unset."""

    enabled: bool

    def observe(self, anomalies: list[dict[str, Any]]) -> dict[str, Any]: ...
    def update_hypotheses(
        self, run_id: str, at: str, by: str, hypotheses: list[dict[str, Any]]
    ) -> list[dict[str, Any]]: ...


class NoWorld:
    """Records nothing. The graph adds no World Model trace events."""

    enabled = False

    def observe(self, anomalies):
        return {}

    def update_hypotheses(self, run_id, at, by, hypotheses):
        return []


class EnginesClient:
    """HTTP client for the sidecar. One instance serves as Memory and as the World Model."""

    enabled = True

    def __init__(
        self,
        base_url: str,
        *,
        timeout_s: float = 5.0,
        recall_top_n: int = 3,
        recall_threshold: float = 0.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.recall_top_n = recall_top_n
        self.recall_threshold = recall_threshold
        self._http = httpx.Client(base_url=self.base_url, timeout=timeout_s, transport=transport)
        self._recent: tuple[float, list[dict[str, Any]]] = (float("-inf"), [])

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            r = self._http.request(method, path, json=body)
        except httpx.HTTPError as e:
            raise EnginesError(f"engines not reachable at {self.base_url} ({e})") from e
        try:
            data = r.json()
        except ValueError:
            data = None
        if r.status_code >= 400:
            detail = data.get("error") if isinstance(data, dict) else r.text
            raise EnginesError(
                f"engines {method} {path} returned HTTP {r.status_code}: "
                f"{str(detail)[:ERROR_SNIPPET]}"
            )
        if not isinstance(data, dict):
            raise EnginesError(f"engines {method} {path} did not return a JSON object")
        return data

    # ------------------------------------------------------------------ Memory

    def recall(self, request: dict[str, Any]) -> list[dict[str, Any]]:
        """Past approved findings on this run's event, most relevant first."""
        request = request or {}
        question = str(request.get("question") or "").strip()
        if not question:
            return []
        body = {"query": question, "top_n": RECALL_POOL, "threshold": self.recall_threshold}
        memories = list(self._call("POST", "/hmem/recall", body).get("memories") or [])
        recent = self._recent_naming(question, {m.get("memory_id") for m in memories})
        event_id = request.get("event_id")
        if event_id:
            tag = f"event:{event_id}"
            # shortcut: an approved run once stored event None; keep those, the caller's place match decides

            def keep(ms):
                return [
                    m
                    for m in ms
                    if tag in (m.get("tags") or [])
                    or not any(str(t).startswith("event:") for t in m.get("tags") or [])
                ]

            memories, recent = keep(memories), keep(recent)
        # Recent ones take the last slots; at least one ranked result stays.
        room = max(self.recall_top_n - 1, 0)
        recent = recent[:room]
        return memories[: self.recall_top_n - len(recent)] + recent

    def _recent_naming(self, question: str, seen: set) -> list[dict[str, Any]]:
        """Newest memories whose text names a place or river of the question, as recall rows."""
        from floodsense_agents.watch import FORECAST_POINTS

        asked = fold(question)
        names = {fold(n) for p in FORECAST_POINTS for n in (p[3], p[4]) if n and fold(n) in asked}
        if not names:
            return []
        at, rows = self._recent
        if time.monotonic() - at > RECENT_TTL_S:
            try:
                rows = list(self._call("GET", f"/hmem/memories?limit={RECENT_LIMIT}").get("memories") or [])
            except EnginesError as e:  # recall still has the ranked results
                log.warning("memory: recent read failed: %s", short(e))
                rows = []
            self._recent = (time.monotonic(), rows)
        out = [
            {**m, "relevance": 0.0, "layer": None}
            for m in rows
            if m.get("memory_id") not in seen and any(n in fold(str(m.get("content") or "")) for n in names)
        ]
        return out[:RECENT_MAX]

    def store(
        self,
        run_id: str,
        request: dict[str, Any],
        claims: list[dict[str, Any]],
        approval: dict[str, Any],
    ) -> dict[str, Any]:
        """Write-on-approval. Returns the engines' report: stored, already_stored, skipped."""
        request = request or {}
        approval = approval or {}
        body = {
            "run_id": run_id,
            "question": request.get("question") or "",
            "event_id": request.get("event_id"),
            "approval": {"status": approval.get("status"), "reviewer": approval.get("reviewer")},
            "claims": claims or [],
        }
        return self._call("POST", "/hmem/store", body)

    # ------------------------------------------------------------- World Model

    def observe(self, anomalies: list[dict[str, Any]]) -> dict[str, Any]:
        """The Watchers' anomalies as observations. A replayed reading changes nothing."""
        if not anomalies:
            return {}
        return self._call("POST", "/wm/observations", {"anomalies": anomalies})

    def update_hypotheses(
        self, run_id: str, at: str, by: str, hypotheses: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Upsert this run's hypotheses. Returns the run's board."""
        if not hypotheses:
            return []
        body = {"run_id": run_id, "at": at, "by": by, "hypotheses": hypotheses}
        return list(self._call("POST", "/wm/hypotheses", body).get("board") or [])


def build_engines() -> EnginesClient | None:
    """The sidecar client, or None when ENGINES_URL is unset."""
    if not settings.engines_url:
        return None
    return EnginesClient(
        settings.engines_url,
        timeout_s=settings.engines_timeout_s,
        recall_top_n=settings.hmem_recall_top_n,
        recall_threshold=settings.hmem_recall_threshold,
    )


SEED_REVIEWER = "demo-seed"


def memory_origin(memory: dict[str, Any]) -> tuple[bool, str | None]:
    """(seeded, reviewer) of a recalled memory.

    The engines label a stored memory "run R <status> by <reviewer>". A memory
    is seeded when `tasks.py demo-seed` wrote it: reviewer demo-seed, a
    demo-seed-* run id, or the entity:demo-seed tag.
    """
    prov = memory.get("provenance") if isinstance(memory.get("provenance"), dict) else {}
    label = str(prov.get("label") or "")
    reviewer = label.rsplit(" by ", 1)[1].strip() or None if " by " in label else None
    tags = memory.get("tags") if isinstance(memory.get("tags"), list) else []
    seeded = (
        reviewer == SEED_REVIEWER
        or str(memory.get("run_id") or "").startswith(SEED_REVIEWER)
        or f"entity:{SEED_REVIEWER}" in tags
    )
    return seeded, reviewer


def fold(text: str) -> str:
    """Lower-case, accent-free text: "Orléans" matches "Orleans"."""
    return "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c))


def short(err: Exception) -> str:
    """One line for the trace."""
    return " ".join(str(err).split())[:ERROR_SNIPPET]
