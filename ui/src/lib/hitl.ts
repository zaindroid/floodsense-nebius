import type { ReplayCitation } from "../api/replay";
import { decisionNoteError } from "./decision";

/* ---------- Source badges per sentence ---------- */

export interface SourceChip {
  kind: "zetaris" | "document" | "provenance" | "other";
  text: string;
}

/** Pure: one chip per distinct source of a claim, from citations[].layer (a = Zetaris query, b = provenance, c = document). */
export function sourceChips(citations: readonly ReplayCitation[]): SourceChip[] {
  const out: SourceChip[] = [];
  const seen = new Set<string>();
  for (const c of citations) {
    let chip: SourceChip;
    if (c.layer === "a") chip = { kind: "zetaris", text: c.queryId ? `Zetaris · query ${c.queryId.slice(0, 8)}` : "Zetaris · query" };
    else if (c.layer === "b") chip = { kind: "provenance", text: "Provenance" };
    else if (c.layer === "c") chip = { kind: "document", text: `Document · ${c.title}` };
    else chip = { kind: "other", text: c.title };
    if (seen.has(chip.text)) continue;
    seen.add(chip.text);
    out.push(chip);
  }
  return out;
}

/* ---------- Memories used (run level, never per claim) ---------- */

export interface MemoryUsed {
  memoryId: string;
  runId: string | null;
  claimId: string | null;
  approvedAt: string | null;
  text: string;
  relevance: number | null;
  /** Who approved it, from the engines' provenance label. */
  reviewer: string | null;
  /** Added by `tasks.py demo-seed` for a demo, not approved by an analyst. */
  seeded: boolean;
}

export const SEEDED_MEMORY_CHIP = "Demo seed — not analyst-approved";

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function adoptMemoryUsed(value: unknown): MemoryUsed[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, i) => {
    const m = rec(raw);
    const text = m && str(m.text);
    if (!m || !text) return [];
    return [
      {
        memoryId: str(m.memory_id) ?? `m${i}`,
        runId: str(m.run_id),
        claimId: str(m.claim_id),
        approvedAt: str(m.approved_at),
        text,
        relevance: num(m.relevance),
        reviewer: str(m.reviewer),
        seeded: m.seeded === true,
      },
    ];
  });
}

/** "27 Oct 2026", or the raw value when it does not parse. */
export function shortDate(iso: string | null): string {
  if (!iso) return "an unknown date";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export const DEATH_TOLL_NOTE = "[source text, verify before quoting]";

/** Pure: the note shown beside a seeded memory whose text states a death toll ("died", "deaths", "killed"); null otherwise. */
export function seededMemoryNote(m: { text: string; seeded?: boolean }): string | null {
  return m.seeded && /\b(died|deaths?|dead|killed|killing|lives|fatalit\w*|victims?|casualt\w*)\b/i.test(m.text) ? DEATH_TOLL_NOTE : null;
}

export const NO_MEMORIES = "No approved memories matched — this run starts fresh.";

export function memoryLine(m: MemoryUsed): string {
  if (m.seeded) return `Seeded for the demo as run ${m.runId ?? "unknown"} on ${shortDate(m.approvedAt)}: ${m.text}`;
  return `Recalled from approved run ${m.runId ?? "unknown"} on ${shortDate(m.approvedAt)}: ${m.text}`;
}

/* ---------- Approval card ---------- */

export type ActionType = "notify-policyholders" | "dispatch-loss-adjuster" | "flag-underwriting-review" | "inform-public";

export const ACTION_LABELS: Record<ActionType, string> = {
  "notify-policyholders": "Notify policyholders",
  "dispatch-loss-adjuster": "Dispatch loss adjuster",
  "flag-underwriting-review": "Underwriting review",
  "inform-public": "Inform public",
};

export interface PlaybookItem {
  actionId: string;
  horizonH: number | null;
  text: string;
  claimIds: string[];
  outbound: boolean;
  released: boolean;
  actionType: ActionType | null;
  title: string;
  targetRegion: string | null;
  affectedSiteCount: number | null;
  draftMessage: string | null;
}

export function adoptPlaybook(value: unknown): PlaybookItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const a = rec(raw);
    const actionId = a && str(a.action_id);
    if (!a || !actionId) return [];
    const type = str(a.action_type);
    const text = str(a.text) ?? "";
    return [
      {
        actionId,
        horizonH: num(a.horizon_h),
        text,
        claimIds: Array.isArray(a.claim_ids) ? a.claim_ids.filter((c): c is string => typeof c === "string") : [],
        outbound: a.outbound === true,
        released: a.released === true,
        actionType: type && type in ACTION_LABELS ? (type as ActionType) : null,
        title: str(a.title) ?? shortTitle(text || actionId),
        targetRegion: str(a.target_region),
        affectedSiteCount: typeof a.affected_site_count === "number" && Number.isInteger(a.affected_site_count) ? a.affected_site_count : null,
        draftMessage: str(a.draft_message),
      },
    ];
  });
}

/** First ~80 characters, cut at a word. */
export function shortTitle(text: string, max = 80): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function actionChip(type: ActionType | null): string {
  return type ? ACTION_LABELS[type] : "Proposed action";
}

/**
 * The site count, said honestly. null: the Exposure step gave no count, so nothing is claimed. 0 outside Valencia:
 * the demo book (synthetic, Valencia only) has no site there, which is not the same as "no exposure".
 */
export function sitesLine(count: number | null, eventId?: string | null): string {
  if (count === null) return "Site count not reported by the Exposure step";
  if (count === 0) {
    return eventId && eventId !== "EMSR773"
      ? "0 insured sites · the demo book covers Valencia only"
      : "0 insured sites in the affected area";
  }
  return `${count} insured site${count === 1 ? "" : "s"} in the affected area`;
}

/** The label above an action's message: an outbound draft waits for approval; an internal action sends nothing. */
export function draftLabel(outbound: boolean): string {
  return outbound ? "Draft message (sent only after approval)" : "Internal note — nothing is sent";
}

export type CardStatus = "pending" | "approved" | "edited" | "rejected";

export function decisionStatusLine(status: CardStatus): string | null {
  if (status === "approved" || status === "edited") return "Approved — finding saved to H-MEM memory; nothing was sent (demo).";
  if (status === "rejected") return "Rejected — the run ends without sending anything.";
  return null;
}

/** Pure: map a run's approval.status (or run status) to the card status. */
export function cardStatus(runStatus: string | null, approvalStatus: string | null): CardStatus {
  const s = approvalStatus ?? runStatus ?? "";
  if (s === "approved" || s === "edited" || s === "rejected") return s;
  if (runStatus === "approved" || runStatus === "rejected") return runStatus;
  return "pending";
}

export interface ApprovalBody {
  action: "approve" | "edit" | "reject";
  reviewer_note?: string;
  reviewer?: string;
  draft_messages?: Record<string, string>;
}

/**
 * Pure: the POST /runs/{id}/approval body, or a message the card shows inline instead of a 422.
 * Only changed, non-empty drafts of outbound actions are sent.
 */
export function buildApprovalBody(
  action: ApprovalBody["action"],
  note: string,
  drafts: Record<string, string>,
  playbook: readonly PlaybookItem[],
): { ok: true; body: ApprovalBody } | { ok: false; message: string } {
  const noteError = decisionNoteError(action === "approve" ? "approved" : action === "edit" ? "edited" : "rejected", note);
  if (noteError) return { ok: false, message: noteError };
  const body: ApprovalBody = { action, reviewer: "insurer-desk" };
  if (note.trim()) body.reviewer_note = note.trim();
  if (action !== "edit") return { ok: true, body };
  const changed: Record<string, string> = {};
  for (const [id, text] of Object.entries(drafts)) {
    const item = playbook.find((p) => p.actionId === id);
    if (!item || !item.outbound) return { ok: false, message: `${id} is not an outbound action; only outbound drafts can be edited.` };
    // Unchanged drafts (including ones that were blank to begin with) are skipped before the empty check.
    if (text.trim() === (item.draftMessage ?? "").trim()) continue;
    if (!text.trim()) return { ok: false, message: "The draft message cannot be empty." };
    changed[id] = text;
  }
  if (Object.keys(changed).length === 0) return { ok: false, message: "Nothing changed. Edit the draft before saving, or approve it as it is." };
  body.draft_messages = changed;
  return { ok: true, body };
}

/** Pure: a FastAPI error body as one line. */
export function errorDetail(body: unknown): string | null {
  const d = rec(body)?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => rec(x)?.msg).filter((m): m is string => typeof m === "string").join("; ") || null;
  return null;
}

/* ---------- Review evidence (claims, Judge per claim, KPIs) ---------- */

export interface ReviewClaim {
  id: string;
  text: string;
  grounding: string | null;
  score: number | null;
}

export interface ReviewEvidence {
  claims: ReviewClaim[];
  supported: number;
  scored: number;
  citations: number;
}

/** Pure: claims with their Judge verdict, from an approval payload or run body. */
export function reviewEvidence(body: Record<string, unknown>): ReviewEvidence {
  const judge = new Map<string, { grounding: string | null; score: number | null }>();
  if (Array.isArray(body.judge)) {
    for (const raw of body.judge) {
      const j = rec(raw);
      const id = j && str(j.claim_id);
      if (j && id) judge.set(id, { grounding: str(j.grounding), score: num(j.score) });
    }
  }
  let citations = 0;
  const claims: ReviewClaim[] = Array.isArray(body.claims)
    ? body.claims.flatMap((raw) => {
        const c = rec(raw);
        const text = c && str(c.text);
        if (!c || !text) return [];
        if (Array.isArray(c.citations)) citations += c.citations.length;
        const id = str(c.claim_id) ?? text;
        const v = judge.get(id);
        return [{ id, text, grounding: v?.grounding ?? null, score: v?.score ?? null }];
      })
    : [];
  return {
    claims,
    supported: claims.filter((c) => c.grounding === "supported").length,
    scored: claims.filter((c) => c.grounding !== null).length,
    citations,
  };
}
