"""The quick lane: a live reading answered in one short agent path, with no model call.

    scope ─┬─ in scope, lane=quick → live_watch → quick_answer → quick_judge ─┬─ pass → END (answered)
           │                                                                  └─ flag / no data → escalate → watchers
           └─ declined → END (a decline is never overridden)

live_watch resolves the asked places first, then reads one Zetaris query per
place, in parallel, so every row belongs to exactly one place:

  gauge station   live.gauge_latest_sql(schema, stations=(station,)): latest
                  PEGELONLINE level, the trend baseline, MHW when the view has it
  EU model point  {schema}.eu_watch WHERE point_id = '<id>' (GloFAS model cell)
  event point     {schema}.hazard_now past/forecast summary WHERE point_id = '<id>'

Places come from watch.watch_target (city first, then river; the user's
selected station or watch point), else the event's point names in the
question, else every point of the event. At most MAX_PLACES are read.

quick_answer builds every claim deterministically, one per place, from that
place's row with a fixed template, and cites only that place's query. The
numbers a claim states (claim.numbers) are cells of that row. The summary is
a template too: one lead line per place, worst band first ("KÖLN: above mean
high water and rising (gauge, 12:45 UTC)"), then the claim texts. No model
writes any of it.

quick_judge runs judge.evaluate with no model: per claim, a citation exists,
its query returned rows, and every number in claim.numbers is a cell of the
cited rows (NUMERIC_TOLERANCE). A claim with a failed check is flagged.

No rows, or any flag, escalates: the run goes on to watchers and the full lane,
and the trace says why ("escalated: ...").
"""

from __future__ import annotations

import logging
import re
import time

from floodsense_agents.events import POINT_NAMES, point_label
from floodsense_agents.governance import DEFINITIONS
from floodsense_agents.live import (
    GAUGE_STALE_H,
    LIVE_ROWS,
    gauge_latest_sql,
    gauge_threshold,
    hours_between,
    live_points,
)
from floodsense_agents import plain as plain_mod
from floodsense_agents.models import Claim, Evidence
from floodsense_agents.nodes import judge as judge_node
from floodsense_agents.nodes.investigator import cite
from floodsense_agents.settings import settings
from floodsense_agents.state import Deps, FloodState, add_evidence, trace
from floodsense_agents.watch import EU_POINTS, sql_list, watch_target
from floodsense_agents.zetaris import now_utc, run_sql_parallel

log = logging.getLogger("floodsense.quick")

QUICK, FULL = "quick", "full"
MAX_PLACES = 6
_EU = {p[0]: p for p in EU_POINTS}


def route_after_scope(state: FloodState) -> str:
    """scope's router with the quick lane. A decline always ends the run."""
    if not (state.get("scope") or {}).get("in_scope", True):
        return "declined"
    if state.get("lane") == "forecast":
        return "forecast_data"
    return "live_watch" if state.get("lane") == QUICK else "watchers"


def places(state: FloodState) -> list[tuple[str, str]]:
    """[(kind, id)] the question asks about: gauge, eu or point."""
    request = state.get("request") or {}
    question = str(request.get("question") or "")
    target = watch_target(question, request.get("context") or {})
    if target:
        out = [("gauge", s) for s in target["stations"]] + [("eu", p) for p in target["points"]]
        return out[:MAX_PLACES]
    pts = live_points(state.get("event") or {})
    named = [
        p
        for p in pts
        if p in POINT_NAMES and re.search(rf"\b{re.escape(POINT_NAMES[p])}\b", question, re.I)
    ]
    ctx_point = (request.get("context") or {}).get("point_id")
    if ctx_point in pts and not named:
        named = [ctx_point]
    return [("point", p) for p in (named or list(pts))][:MAX_PLACES]


def _sql(kind: str, ident: str, s: str) -> str:
    if kind == "gauge":
        return gauge_latest_sql(s, stations=(ident,))
    if kind == "eu":
        return (
            f"SELECT point_id, name, country, river, discharge_m3s, forecast_max_m3s, "
            f"past30_median_m3s, band, basis, as_of_date FROM {s}.eu_watch WHERE point_id = "
            f"{sql_list([ident])}"
        )
    return (
        f"SELECT point_id, MAX(CASE WHEN horizon = 'forecast' THEN discharge_m3s END) AS "
        f"forecast_max_discharge_m3s, MAX(CASE WHEN horizon = 'forecast' THEN rain_mm END) AS "
        f"forecast_max_rain_mm, MAX(CASE WHEN horizon = 'past' THEN discharge_m3s END) AS "
        f"past_max_discharge_m3s FROM {s}.hazard_now WHERE point_id = {sql_list([ident])} AND "
        f"{LIVE_ROWS} GROUP BY point_id"
    )


def _own_row(kind: str, ident: str, ev: Evidence) -> dict | None:
    """The row of this place only: matched on the name / river / point_id columns."""
    for r in ev.rows_sample:
        if kind == "gauge" and str(r.get("station") or "").upper() == ident.upper():
            return r
        if kind == "eu":
            p = _EU.get(ident)
            if (
                r.get("point_id") == ident
                and p
                and str(r.get("name") or "").lower() == p[1].lower()
                and str(r.get("river") or "").lower() == p[3].lower()
            ):
                return r
        if kind == "point" and r.get("point_id") == ident:
            return r
    return None


def make_live_watch(deps: Deps):
    def live_watch(state: FloodState) -> dict:
        t = time.time()
        s = settings.schema
        asked = places(state)
        jobs = [(_sql(k, i, s), None) for k, i in asked]
        jobs.append(
            (
                f"SELECT dataset, source_url, publisher, licence, attribution, fetched_at FROM "
                f"{s}.provenance",
                None,
            )
        )
        *reads, prov = run_sql_parallel(deps.zetaris, jobs)
        notes: list[str] = []
        used: list[Evidence] = []
        found: list[dict] = []
        for (kind, ident), ev in zip(asked, reads):
            if ev.error:
                notes.append(f"{ident}: {ev.view} unavailable")
                continue
            row = _own_row(kind, ident, ev)
            if row is None:
                notes.append(f"{ident}: no live row")
                continue
            used.append(ev)
            found.append({"kind": kind, "id": ident, "query_id": ev.query_id})
            notes.append(f"{ident}: {ev.view} 1 row")
        out: dict = {
            "evidence": add_evidence(state, *used),
            "provenance": prov.rows_sample if not prov.error else [],
            "live_findings": {"quick_places": found},
            "trace": trace(
                state,
                "live_watch",
                "; ".join(notes) or "no place to read",
                lane="sql",
                started=t,
                evidence_ids=[e.query_id for e in used],
            ),
        }
        if not used:
            out["escalate"] = (
                "no live rows for the asked place (" + ("; ".join(notes) or "none") + ")"
            )
        return out

    return live_watch


def route_after_live_watch(state: FloodState) -> str:
    return "escalate" if state.get("escalate") else "quick_answer"


def _num(v) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def _fmt(v: float) -> str:
    return f"{v:g}" if abs(v) >= 100 or v == int(v) else f"{v:.1f}"


def _hhmm(ts) -> str | None:
    m = re.search(r"T?(\d{2}:\d{2})", str(ts or "")[10:])
    return m.group(1) if m else None


# How bad a band is, for the summary lead: the worst place comes first.
_SEVERITY = {"above": 3, "near": 2, "rising": 1, "unknown": 0, "below": 0}

# Template output: claim text, the numbers it states (cells of its row),
# the place's one-line lead, and that lead's severity.
Built = tuple[str, list[float], str, int]


def gauge_claim(row: dict) -> Built | None:
    level = _num(row.get("level_cm"))
    if level is None:
        return None
    station, water = row.get("station"), row.get("water")
    at = _hhmm(row.get("ts_utc"))
    age = hours_between(now_utc(), str(row.get("ts_utc") or ""))
    stale = age is not None and age > GAUGE_STALE_H
    text = f"{station} ({water}) gauge: level {_fmt(level)} cm"
    if at:
        text += f" measured at {at} UTC"
    if stale:
        text += f" (stale: older than {GAUGE_STALE_H} h)"
    nums = [level]
    band = None
    th = gauge_threshold(row)
    if th:
        mhw = th[1]
        nums.append(mhw)
        if level >= mhw:
            band = "above"
            text += f", above the station's mean high water (MHW) of {_fmt(mhw)} cm"
        elif level >= 0.8 * mhw:
            band = "near"
            text += (
                f", near the station's mean high water (MHW) of {_fmt(mhw)} cm (near = at least "
                f"80% of MHW: FloodSense's own cut, not an official threshold)"
            )
        else:
            band = "below"
            text += f", below the station's mean high water (MHW) of {_fmt(mhw)} cm"
    trend = None
    prev = _num(row.get("prev_cm"))
    # One reading only: the baseline is the reading itself, so there is no trend.
    if prev is not None and row.get("prev_utc") != row.get("ts_utc"):
        trend = "rising" if level > prev else "falling" if level < prev else "steady"
        text += f"; {trend} from {_fmt(prev)} cm about three hours earlier"
        nums.append(prev)
    parts = [p for p in (f"{band} mean high water" if band else None, trend) if p]
    lead = f"{station}: {' and '.join(parts) or 'latest level'}"
    lead += f" (gauge{', ' + at + ' UTC' if at else ''}{', stale' if stale else ''})"
    severity = _SEVERITY.get(band or "", 0) + (1 if trend == "rising" else 0)
    return text + " (PEGELONLINE).", nums, lead, severity


def eu_claim(row: dict) -> Built | None:
    q, fmax, med = (
        _num(row.get(k)) for k in ("discharge_m3s", "forecast_max_m3s", "past30_median_m3s")
    )
    if q is None and fmax is None:
        return None
    text = f"{row.get('name')} ({row.get('river')}, {row.get('country')}): model"
    nums: list[float] = []
    if q is not None:
        text += f" discharge {_fmt(q)} m3/s today"
        nums.append(q)
    if fmax is not None:
        text += f", forecast maximum {_fmt(fmax)} m3/s"
        nums.append(fmax)
    if med is not None:
        text += f" against a past-month median of {_fmt(med)} m3/s"
        nums.append(med)
    band = str(row.get("band") or "unknown")
    text += f"; band {band} (GloFAS model cell value, not an official warning)."
    lead = f"{row.get('name')}: model band {band} (GloFAS model, not an official warning)"
    return text, nums, lead, _SEVERITY.get(band, 0)


def point_claim(row: dict) -> Built | None:
    fmax, rain = _num(row.get("forecast_max_discharge_m3s")), _num(row.get("forecast_max_rain_mm"))
    if fmax is None and rain is None:
        return None
    name = point_label(str(row.get("point_id")))
    text = f"{name}: in the live forecast window"
    nums: list[float] = []
    if fmax is not None:
        text += f" discharge peaks at {_fmt(fmax)} m3/s"
        nums.append(fmax)
    if rain is not None:
        text += f"{',' if fmax is not None else ''} hourly rain peaks at {_fmt(rain)} mm"
        nums.append(rain)
    crosses = fmax is not None and fmax >= DEFINITIONS["anomaly_discharge"].value
    if fmax is None:
        # Rain only: no discharge forecast, so say so rather than claim it stays under the line.
        lead = f"{name}: no discharge forecast in the live window (hazard_now)"
    else:
        lead = f"{name}: forecast discharge {'crosses' if crosses else 'stays under'} the anomaly line (hazard_now)"
    return text + " (GloFAS / Open-Meteo, hazard_now).", nums, lead, 3 if crosses else 0


_TEMPLATES = {"gauge": gauge_claim, "eu": eu_claim, "point": point_claim}


def build_claims(state: FloodState) -> tuple[list[Claim], str]:
    """One claim per place, from that place's row, citing only that place's query.

    Also the summary lead: each place's line, worst band first. Deterministic.
    """
    prov = state.get("provenance") or []
    claims: list[Claim] = []
    leads: list[tuple[int, int, str]] = []
    for place in (state.get("live_findings") or {}).get("quick_places") or []:
        raw = (state.get("evidence") or {}).get(place["query_id"])
        if not raw:
            continue
        ev = Evidence(**raw)
        row = _own_row(place["kind"], place["id"], ev)
        built = _TEMPLATES[place["kind"]](row) if row else None
        if not built:
            continue
        text, nums, lead, severity = built
        cid = f"Q{len(claims) + 1}"
        claims.append(
            Claim(
                claim_id=cid,
                text=text,
                kind="number",
                numbers=nums,
                citations=cite(cid, ev, prov, 1),
            )
        )
        leads.append((-severity, len(leads), lead))
    lead = "; ".join(line for _, _, line in sorted(leads))
    return claims, lead


# ------------------------------------------------------------------ plain answer


def _gauge_check(ident: str, row: dict | None) -> plain_mod.Check:
    row = row or {}
    c = plain_mod.Check(
        name=plain_mod.nice_name(row.get("station") or ident),
        river=plain_mod.nice_river(row.get("water")),
        country="DE",
        kind="gauge",
        needs=("level",),
    )
    c.week_note = f"We only have the current reading for {c.where}, not a forecast for the week."
    level = _num(row.get("level_cm"))
    if level is None:
        return c
    age = hours_between(now_utc(), str(row.get("ts_utc") or ""))
    if age is None or age > GAUGE_STALE_H:  # no readable time stamp counts as stale
        c.stale = True
        return c
    th = gauge_threshold(row)
    status, above = plain_mod.UNKNOWN, False
    if th:
        mhw = th[1]
        status = (
            plain_mod.ELEVATED
            if level >= mhw
            else plain_mod.WATCH
            if level >= 0.8 * mhw
            else plain_mod.NORMAL
        )
        above = level >= mhw
    prev = _num(row.get("prev_cm"))
    trend = None
    if prev is not None and row.get("prev_utc") != row.get("ts_utc"):
        trend = "rising" if level > prev else "falling" if level < prev else "steady"
    c.signals.append(
        plain_mod.Signal("level", status, above_mhw=above, level_text=_fmt(level), trend=trend)
    )
    return c


def _eu_check(ident: str, row: dict | None) -> plain_mod.Check:
    row = row or {}
    p = _EU.get(ident)
    c = plain_mod.Check(
        name=plain_mod.nice_name(row.get("name") or (p[1] if p else ident)),
        river=plain_mod.nice_river(row.get("river") or (p[3] if p else None)),
        country=str(row.get("country") or (p[2] if p else "")) or None,
        kind="model",
        needs=("river",),
        covers_week=True,
    )
    band = str(row.get("band") or "")
    status = {"above": plain_mod.ELEVATED, "near": plain_mod.WATCH, "below": plain_mod.NORMAL}.get(
        band
    )
    if row and (status or _num(row.get("forecast_max_m3s")) is not None):
        c.signals.append(plain_mod.Signal("river", status or plain_mod.UNKNOWN))
    return c


def _point_check(ident: str, row: dict | None) -> plain_mod.Check:
    row = row or {}
    c = plain_mod.Check(
        name=POINT_NAMES.get(ident, ident),
        river=None,
        country="ES" if ident.startswith("VAL") else "DE" if ident.startswith("AHR") else None,
        kind="model",
        needs=("river",),
        week_note=f"We only have the next two days for {POINT_NAMES.get(ident, ident)}, not a full week.",
    )
    fmax = _num(row.get("forecast_max_discharge_m3s"))
    if fmax is not None:
        crosses = fmax >= DEFINITIONS["anomaly_discharge"].value
        c.signals.append(
            plain_mod.Signal(
                "river", plain_mod.ELEVATED if crosses else plain_mod.NORMAL, valencia=True
            )
        )
    return c


_CHECKS = {"gauge": _gauge_check, "eu": _eu_check, "point": _point_check}


def plain_for(state: FloodState, claims: list[Claim]) -> dict | None:
    """The calm `plain` object for the places this run asked, from the rows it read."""
    found = {
        (q["kind"], q["id"]): q["query_id"]
        for q in (state.get("live_findings") or {}).get("quick_places") or []
    }
    checks = []
    for kind, ident in places(state):
        row = None
        raw = (state.get("evidence") or {}).get(found.get((kind, ident)) or "")
        if raw:
            row = _own_row(kind, ident, Evidence(**raw))
        checks.append(_CHECKS[kind](ident, row))
    question = str((state.get("request") or {}).get("question") or "")
    return plain_mod.build_plain(
        checks,
        asked=plain_mod.horizon_of(question),
        claims=[c.model_dump() for c in claims],
    )


def quick_answer(state: FloodState) -> dict:
    """Template claims and a template lead. No model call."""
    t = time.time()
    claims, lead = build_claims(state)
    if not claims:
        return {
            "escalate": "the live rows hold no reading to state",
            "trace": trace(
                state, "quick_answer", "no reading in the live rows", lane="none", started=t
            ),
        }
    try:
        calm = plain_for(state, claims)
    except Exception:  # noqa: BLE001 - the plain object is an addition; the claims still answer
        log.exception("quick: plain answer failed")
        calm = None
    return {
        "claims": [c.model_dump() for c in claims],
        "summary": f"{lead}. " + " ".join(c.text for c in claims),
        **({"plain": calm} if calm else {}),
        "trace": trace(
            state,
            "quick_answer",
            f"{len(claims)} template claims, one per place; lead: {lead}",
            lane="none",
            model_id="deterministic",
            started=t,
            evidence_ids=[q for c in claims for q in (x.query_id for x in c.citations) if q],
        ),
    }


def route_after_answer(state: FloodState) -> str:
    return "escalate" if state.get("escalate") else "quick_judge"


def quick_judge(state: FloodState) -> dict:
    """judge.evaluate with no model. A pass ends the run as answered."""
    t = time.time()
    claims = [Claim(**c) for c in state.get("claims") or []]
    evidence = {q: Evidence(**e) for q, e in (state.get("evidence") or {}).items()}
    scores, rep = judge_node.evaluate(claims, evidence, None)
    unmatched = [
        s.claim_id
        for s in scores
        if not s.numbers_match or not s.coverage or not s.citation_faithful
    ]
    flagged = sorted(set(rep.flagged_claim_ids) | set(unmatched))
    ok = rep.passes and not flagged
    out = {
        "judge": [s.model_dump() for s in scores],
        "judge_summary": rep.model_dump(),
        "trace": trace(
            state,
            "judge",
            f"{'PASS' if ok else 'FLAG'} overall={rep.overall:.2f} "
            f"coverage={rep.citation_coverage:.0%} "
            f"numbers={rep.numeric_accuracy:.0%} flagged={flagged or '-'}",
            lane="none",
            model_id=rep.model_id,
            started=t,
        ),
    }
    if ok:
        out["status"] = "answered"
    else:
        out["escalate"] = f"judge flagged {', '.join(flagged) or 'the answer'}"
    return out


def route_after_quick_judge(state: FloodState) -> str:
    return "escalate" if state.get("escalate") else "done"


def escalate(state: FloodState) -> dict:
    """Hand the run to the full lane and say why on the trace."""
    why = state.get("escalate") or "quick lane could not answer"
    return {
        "lane": FULL,
        "router_reason": f"{state.get('router_reason') or 'chose quick'}; escalated: {why}",
        "escalate": None,
        "claims": [],
        "judge": [],
        "judge_summary": {},
        "summary": "",
        "forecast": {},
        "plain": {},
        "status": "running",
        "trace": trace(state, "router", f"escalated: {why}; running the full lane", lane="none"),
    }


def route_after_escalate(state: FloodState) -> str:
    """Never run the full lane on a declined question: end with the decline."""
    return "watchers" if (state.get("scope") or {}).get("in_scope", True) else "declined"
