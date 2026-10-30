"""Exposure. Deterministic SQL only.

Which policies and sites sit inside the mapped flood footprint, the sum
insured, and the split by segment. Adds the site exposure hypothesis with
number claims the Judge can check exactly.
"""

from __future__ import annotations

import math
import re
import time
from decimal import Decimal, InvalidOperation

from floodsense_agents.events import WATCH_EVENT
from floodsense_agents.governance import IN_FOOTPRINT_SQL
from floodsense_agents.live import focus, is_live, phrase_for_role
from floodsense_agents.models import Claim, ExposedAsset, Exposure, Hypothesis, normalize_utc
from floodsense_agents.nodes.investigator import cite
from floodsense_agents.settings import settings
from floodsense_agents.state import Deps, FloodState, add_evidence, answered, trace
from floodsense_agents.zetaris import run_sql_parallel


def _number(value: object, default: float = 0.0) -> float:
    """Zetaris JDBC/REST returns DECIMAL sums as str or Decimal.

    ``:,.0f`` only accepts a real number, so a numeric string crashed the
    segment claim on a live run. Missing or unreadable cells use ``default``.
    """
    if value is None or isinstance(value, bool):
        return default
    try:
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return default
            parsed = Decimal(text)
        elif isinstance(value, Decimal):
            parsed = value
        elif isinstance(value, (int, float)):
            parsed = Decimal(str(value))
        else:
            parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return default
    try:
        out = float(parsed)
    except (OverflowError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _count(value: object) -> int:
    return int(_number(value))


def _eur(value: object) -> str:
    return f"{_number(value):,.0f}"


def _segments(rows: list[dict]) -> list[dict]:
    out = []
    for raw in rows:
        item = dict(raw)
        if "policies" in item:
            item["policies"] = _count(item.get("policies"))
        if "sum_insured_eur" in item:
            item["sum_insured_eur"] = _number(item.get("sum_insured_eur"))
        out.append(item)
    return out


def _exposure_trace(
    have_footprint: bool, ok: bool, published: str, policies: int, total: float, new_claims: int
) -> str:
    """Unpublished, failed, and empty are three different sentences."""
    if not have_footprint:
        return f"footprint not published until {published}"
    if not ok:
        return "exposure not computed: the portfolio query failed"
    return (
        f"{policies} exposed policies, {_eur(total)} EUR sum insured, "
        f"{new_claims} new number claims"
    )


def make(deps: Deps):
    def exposure(state: FloodState) -> dict:
        t = time.time()
        s = settings.schema
        ev = state["event"]
        # in_footprint alone is portfolio-wide: an Ahr run read the Valencia
        # sites. Scope to where this event actually is.
        lat0, lat1, lon0, lon1 = ev["bbox"]
        here = (
            f"{IN_FOOTPRINT_SQL} AND lat BETWEEN {lat0} AND {lat1} "
            f"AND lon BETWEEN {lon0} AND {lon1}"
        )
        live = is_live(state)
        # A Europe live-watch question (Budapest, the Elbe at Dresden) is not about
        # this event's footprint; the synthetic portfolio would answer another place.
        if ev.get("event_id") == WATCH_EVENT or (state.get("live_findings") or {}).get(
            "watch_hypothesis"
        ):
            return {
                "exposure": {},
                "trace": trace(
                    state,
                    "exposure",
                    "skipped: a Europe live-watch question; the synthetic portfolio covers the "
                    f"{ev['event_id']} footprint only",
                    lane="none",
                    started=t,
                ),
            }
        # Live mode has no forecast extent. The EMSR773 layer is the 2024
        # observed extent, so it is used as a historical proxy and says so.
        where_txt = (
            f"the historical {ev['event_id']} flood footprint (2024 observed extent, "
            f"a proxy, not a forecast extent)"
            if live
            else "the mapped footprint"
        )
        published = normalize_utc(ev["footprint_published_utc"])
        clock_raw = state.get("replay_ts")
        clock = normalize_utc(clock_raw) if clock_raw else None
        # The mapping is a published product. Before it existed, nobody could
        # have acted on it, so a replay before that moment must not use it.
        # Both clocks are canonical, so the comparison is not a string accident.
        have_footprint = clock is None or clock >= published
        if not have_footprint:
            q = deps.zetaris.run_sql(
                f"SELECT policy_id, site_id, lat, lon, segment, sum_insured_eur "
                f"FROM {s}.exposure_join WHERE 1 = 0"
            )
            agg = whole = q
        else:
            # The sample, the segment rollup, and the portfolio total do not
            # depend on each other. Order is the evidence order.
            # run_sql keeps 20 rows. The seed has 7, so summing the sample
            # looked right; a real portfolio would state a partial total that
            # the Judge could still match. Take the totals from the aggregate.
            q, agg, whole = run_sql_parallel(
                deps.zetaris,
                [
                    (
                        f"SELECT policy_id, site_id, lat, lon, segment, sum_insured_eur "
                        f"FROM {s}.exposure_join WHERE {here} ORDER BY sum_insured_eur DESC",
                        None,
                    ),
                    (
                        f"SELECT segment, COUNT(*) AS policies, SUM(sum_insured_eur) AS "
                        f"sum_insured_eur "
                        f"FROM {s}.exposure_join WHERE {here} "
                        f"GROUP BY segment ORDER BY sum_insured_eur DESC",
                        None,
                    ),
                    (
                        f"SELECT COUNT(*) AS policies, SUM(sum_insured_eur) AS sum_insured_eur "
                        f"FROM {s}.exposure_join WHERE {here}",
                        None,
                    ),
                ],
            )
        # A query that errored returned nothing because it failed, not because
        # the portfolio is empty. Saying "no site is exposed" would be as wrong
        # as naming seven.
        ok = answered(q, agg, whole)
        assets = [ExposedAsset(**r) for r in q.rows_sample] if ok else []
        row = (whole.rows_sample or [{}])[0] if ok else {}
        policies = _count(row.get("policies"))
        total = _number(row.get("sum_insured_eur"))
        segments = _segments(agg.rows_sample)
        exp = Exposure(
            assets=assets,
            policies=policies,
            sum_insured_eur=total,
            by_segment=segments,
            query_ids=[q.query_id, agg.query_id, whole.query_id],
        )

        claims = [Claim(**c) for c in state["claims"]]
        n = max([int(m.group(1)) for c in claims if (m := re.match(r"C(\d+)$", c.claim_id))] or [0])
        prov = state.get("provenance", [])
        new_ids: list[str] = []
        if assets:
            n += 1
            cid = f"C{n}"
            claims.append(
                Claim(
                    claim_id=cid,
                    kind="number",
                    hypothesis_id="H4",
                    citations=cite(cid, whole, prov, 1),
                    numbers=[policies, total],
                    text=f"{policies} policies sit inside {where_txt}, sum insured "
                    f"{_eur(total)} EUR; the largest is {assets[0].policy_id} "
                    f"({assets[0].segment}, {_eur(assets[0].sum_insured_eur)} EUR).",
                )
            )
            new_ids.append(cid)
            if segments:
                top = segments[0]
                n += 1
                cid = f"C{n}"
                claims.append(
                    Claim(
                        claim_id=cid,
                        kind="number",
                        hypothesis_id="H4",
                        citations=cite(cid, agg, prov, 1),
                        numbers=[top["policies"], top["sum_insured_eur"]],
                        text=f"The most exposed segment is {top['segment']}: {top['policies']} "
                        f"policies, {_eur(top['sum_insured_eur'])} EUR sum insured"
                        + (" inside the historical footprint (proxy)." if live else "."),
                    )
                )
                new_ids.append(cid)
        hyps = [Hypothesis(**h) for h in state["hypotheses"] if h["id"] != "H4"]
        if not have_footprint:
            statement = "The footprint is not published yet at this replay time"
            rationale = (
                f"{ev['event_id']} mapping published {published}; this replay stands at {clock}"
            )
        elif not ok:
            statement = "Exposure is unknown: the portfolio query failed"
            rationale = f"exposure_join query failed: {(q.error or agg.error or '')[:160]}"
        elif policies:
            # policies is the aggregate COUNT(*), not len(assets). rows_sample
            # is capped at 20, so the sample is not the portfolio.
            statement = (
                f"{policies} insured policies sit inside the historical footprint (proxy)"
                if live
                else f"{policies} insured policies are exposed"
            )
            rationale = f"deterministic join on exposure_join.{IN_FOOTPRINT_SQL}"
        else:
            statement = "No insured site in the footprint"
            rationale = f"deterministic join on exposure_join.{IN_FOOTPRINT_SQL}"
        hyps.append(
            Hypothesis(
                id="H4",
                link="site->exposure",
                citations=new_ids,
                status="supported" if assets else "not_supported",
                rounds=0,
                evidence=[q.query_id],
                statement=statement,
                rationale=rationale,
            )
        )
        # Phrase the answer for who is asking (context.role). Exposure first for an insurer.
        role = focus(state)["role"]
        summary = state.get("summary") or ""
        if role and not summary.startswith(("In plain words:", "Exposure:")):
            cited = f" [{', '.join(new_ids)}]" if new_ids else ""
            summary = phrase_for_role(summary, role, statement + cited)
        return {
            "summary": summary,
            "exposure": exp.model_dump(),
            "claims": [c.model_dump() for c in claims],
            "hypotheses": [h.model_dump() for h in hyps],
            "evidence": add_evidence(state, q, agg, whole),
            "trace": trace(
                state,
                "exposure",
                _exposure_trace(have_footprint, ok, published, policies, total, len(new_ids)),
                lane="sql",
                started=t,
                evidence_ids=[q.query_id, agg.query_id, whole.query_id],
            ),
        }

    return exposure
