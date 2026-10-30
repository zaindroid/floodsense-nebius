import { runModelLine } from "./modelChip";

/**
 * The Approvals queue: runs waiting for a person, newest first. Built only from what the API returns
 * (GET /runs/past rows and the live-run handoff id), never invented. A run the agents are still working on
 * is listed so a reviewer can see it coming, but it cannot be decided until it reaches awaiting_approval.
 */
export type QueueState = "awaiting" | "running" | "decided" | "other";

export interface QueueRow {
  runId: string;
  state: QueueState;
  /** Raw run status from the agents (awaiting_approval, running, approved, ...). */
  status: string;
  question: string | null;
  /** ISO start time from the run's own trace (past row created_at). */
  createdAt: string | null;
  eventId: string | null;
  lane: string | null;
  /** "live" or "event" (GET /runs/past `mode`). */
  mode?: string | null;
  judgeOverall: number | null;
  /** Set by curateQueue: every action of the run is internal, so there is nothing to send, only notes to review. */
  internalOnly?: boolean;
  /** Duplicates of the same question and event folded into this (newest) run. Set by curateQueue. */
  earlier?: number;
  earlierIds?: string[];
  /** True when the row came only from the handoff id (the past list did not carry it yet). */
  handoffOnly: boolean;
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function queueState(status: string | null, approval: string | null = null): QueueState {
  if (status === "awaiting_approval") return "awaiting";
  if (status === "running") return "running";
  if (approval === "approved" || approval === "edited" || approval === "rejected") return "decided";
  if (status === "approved" || status === "rejected" || status === "answered") return "decided";
  return "other";
}

/** Pure: GET /runs/past ({runs: [...]} or a bare list) as queue rows. Malformed rows are dropped. */
export function adoptPastRuns(body: unknown): QueueRow[] {
  const list = Array.isArray(body) ? body : Array.isArray(rec(body)?.runs) ? (rec(body)!.runs as unknown[]) : [];
  return list.flatMap((raw) => {
    const r = rec(raw);
    const runId = r && str(r.run_id);
    if (!r || !runId) return [];
    const status = str(r.status) ?? "unknown";
    return [
      {
        runId,
        state: queueState(status, str(r.approval)),
        status,
        question: str(r.question),
        createdAt: str(r.created_at),
        eventId: str(r.event_id),
        lane: str(r.lane),
        mode: str(r.mode),
        judgeOverall: num(r.judge_overall),
        handoffOnly: false,
      },
    ];
  });
}

/** A run this browser started (Alerts "Ask the agents to assess", or the Ask chat handoff). */
export interface StartedRun {
  runId: string;
  question: string;
  startedAt: string;
  eventId?: string | null;
}

const t = (iso: string | null): number => {
  const v = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : -Infinity;
};

/**
 * Pure: the queue shown in the left pane. Awaiting runs first, then runs the agents are still working on, each
 * newest first. The handoff id (the newest live run that reached review in this tab) is kept even before
 * /runs/past lists it; runs started here are kept as "running" until the past list says otherwise.
 */
export function buildQueue(past: readonly QueueRow[], handoffRunId: string | null, started: readonly StartedRun[] = []): QueueRow[] {
  const byId = new Map<string, QueueRow>();
  for (const row of past) if (!byId.has(row.runId)) byId.set(row.runId, row);
  for (const s of started) {
    if (byId.has(s.runId)) continue;
    byId.set(s.runId, {
      runId: s.runId,
      state: "running",
      status: "running",
      question: s.question,
      createdAt: s.startedAt,
      eventId: s.eventId ?? null,
      lane: null,
      judgeOverall: null,
      handoffOnly: true,
    });
  }
  if (handoffRunId && !byId.has(handoffRunId)) {
    byId.set(handoffRunId, {
      runId: handoffRunId,
      state: "awaiting",
      status: "awaiting_approval",
      question: null,
      createdAt: null,
      eventId: null,
      lane: null,
      judgeOverall: null,
      handoffOnly: true,
    });
  }
  const rank: Record<QueueState, number> = { awaiting: 0, running: 1, decided: 2, other: 3 };
  return [...byId.values()]
    .filter((r) => r.state === "awaiting" || r.state === "running")
    .sort((a, b) => rank[a.state] - rank[b.state] || t(b.createdAt) - t(a.createdAt) || a.runId.localeCompare(b.runId));
}

/**
 * Pure: which run the right pane shows. The current pick while it is still awaiting; else the handoff run;
 * else the newest awaiting run; else null (the right pane shows the packed example, labelled as such).
 */
export function pickSelection(
  queue: readonly QueueRow[],
  current: string | null,
  handoff: string | null,
  quality: Readonly<Record<string, RunQuality>> = {},
): string | null {
  const awaiting = queue.filter((r) => r.state === "awaiting");
  if (current && awaiting.some((r) => r.runId === current)) return current;
  if (handoff && awaiting.some((r) => r.runId === handoff)) return handoff;
  // Default: the newest run with something to send, a Judge pass and fresh data; else the newest. (The queue is newest first.)
  const good = awaiting.find((r) => {
    const q = quality[r.runId];
    return !!q && q.outbound > 0 && q.passes === true && q.stale !== true;
  });
  return good?.runId ?? awaiting[0]?.runId ?? null;
}

/** What the run's approval body says about it; filled in per run by the page. `passes` is the Judge verdict, `stale` the run's own STALE note. */
export interface RunQuality {
  outbound: number;
  total: number;
  passes?: boolean | null;
  stale?: boolean;
}

/** "27 Oct 2026, 11:42 UTC", or null. */
export function utcStamp(iso: string | null | undefined): string | null {
  const v = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(v)) return null;
  const d = new Date(v);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}, ${hh}:${mm} UTC`;
}

export interface HeaderFact {
  label: string;
  value: string;
}

export interface ApprovalHeader {
  /** "Live run 3f2a…" or "Packed example run …". */
  title: string;
  /** Live: the run's own facts. Example: a plain "not live" note. */
  kind: "live" | "example";
  facts: HeaderFact[];
  /** One line under the facts, e.g. why a fact is missing. */
  note: string | null;
}

const LANE_TEXT: Record<string, string> = { full: "Full investigation", quick: "Quick check" };

/**
 * Pure: the page header for the selected run. It states the run's own facts (id, start, lane, model, Judge)
 * and nothing about the console's fixture answer, so no "cached at" line from elsewhere leaks in.
 */
export function approvalHeader(input: {
  runId: string | null;
  row: QueueRow | null;
  modelIds: readonly string[];
  judgeScore: number | null;
  judgePasses: boolean | null;
  eventId?: string | null;
  /** The packed example's own run id, when no live run is selected. */
  exampleRunId?: string | null;
}): ApprovalHeader {
  const judge =
    input.judgeScore === null
      ? "not scored"
      : `${input.judgeScore.toFixed(2)}${input.judgePasses === null ? "" : input.judgePasses ? " · passes" : " · does not pass"}`;
  if (!input.runId) {
    return {
      title: "Packed example run",
      kind: "example",
      facts: [
        { label: "Run", value: input.exampleRunId ? `${input.exampleRunId} (example)` : "example" },
        { label: "Judge", value: judge },
      ],
      note: "No live run is waiting. This is the example shipped with the UI: a recording, not live, decided in this browser only.",
    };
  }
  const started = utcStamp(input.row?.createdAt);
  const lane = input.row?.lane ? (LANE_TEXT[input.row.lane] ?? input.row.lane) : null;
  const model = runModelLine(input.modelIds);
  const eventId = input.eventId ?? input.row?.eventId ?? null;
  const facts: HeaderFact[] = [
    { label: "Live run", value: input.runId },
    { label: "Started", value: started ?? "not reported" },
    { label: "Lane", value: lane ?? "not reported" },
    { label: "Model", value: model ?? "rules only (no model call recorded)" },
    { label: "Judge", value: judge },
  ];
  // A live-data run carries whichever event the console had selected; it is a live forecast, not that event's replay.
  if (eventId) facts.push({ label: "Event", value: eventLabel(eventId, input.row?.mode) });
  const missing = [!started && "start time", !lane && "lane"].filter(Boolean);
  return {
    title: `Live run ${input.runId}`,
    kind: "live",
    facts,
    note: missing.length ? `The run list did not report the ${missing.join(" or ")} for this run yet.` : null,
  };
}

const EVENT_LABELS: Record<string, string> = { EMSR517: "Ahr 2021", EMSR773: "Valencia 2024", "LIVE-EU": "Live" };

/** Plain event name for a run: "Ahr 2021", "Valencia 2024", "Live"; an unknown id is shown as given. */
export function eventLabel(eventId: string | null | undefined, mode?: string | null): string {
  if (mode === "live") return "Live";
  if (!eventId) return "";
  return EVENT_LABELS[eventId] ?? eventId;
}

function hhmmUtc(iso: string | null): string | null {
  const v = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(v)) return null;
  const d = new Date(v);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** Pure: the left-pane row's secondary line: "Ahr 2021 · 12:28 UTC · Judge 1.00" (no run id, no raw event id). */
export function queueRowLine(row: QueueRow): string {
  const parts = [
    row.state === "running" ? "Agents working" : null,
    row.internalOnly ? "Internal notes" : null,
    eventLabel(row.eventId, row.mode) || null,
    hhmmUtc(row.createdAt),
    row.judgeOverall !== null ? `Judge ${row.judgeOverall.toFixed(2)}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Pure: a greeting or small talk. The agents may still draft actions for it; nobody should be asked to approve them. */
export function isSmallTalk(question: string | null): boolean {
  const q = (question ?? "").trim().toLowerCase();
  if (!q) return false;
  return /^(hi|hello|hey|hallo|hola|good (morning|afternoon|evening))\b/.test(q) || /\bhow are you\b/.test(q) || /^(thanks|thank you)\b/.test(q);
}

/** A run the API still reports as running after this long was abandoned, not worked on. */
export const STALE_RUNNING_MS = 20 * 60_000;

export interface CurateInput {
  /** Wall clock (ms) for the stale-running rule. Defaults to now. */
  now?: number;
  mode: "live" | "past";
  eventId: string;
  hidden: ReadonlySet<string>;
  showHidden: boolean;
  /** Actions per run, from GET /runs/{id}/approval. Absent: not looked up yet. */
  actionCounts: Readonly<Record<string, RunQuality>>;
}

export interface CuratedQueue {
  rows: QueueRow[];
  /** Runs the reviewer hid (listed only with "Show hidden"). */
  hiddenCount: number;
  /** Candidate run ids whose actions still have to be looked up. */
  pendingIds: string[];
}

const dupKey = (r: QueueRow): string => `${(r.question ?? r.runId).trim().toLowerCase().replace(/\s+/g, " ")}|${r.eventId ?? ""}`;

/**
 * Pure: what the Approvals list actually shows. Scoped to the global mode (Live: live-data runs; Past flood: the
 * chosen event's runs), full-lane runs only (quick, forecast and reply runs have nothing to approve), runs with at
 * at least one action (internal-only runs are listed as "Internal notes"), duplicates (same question and event) folded into the newest with `earlier`, and
 * hidden runs held back. Runs started in this tab are kept while the agents work or until they reach review.
 */
export function curateQueue(queue: readonly QueueRow[], input: CurateInput): CuratedQueue {
  const inScope = (r: QueueRow): boolean => {
    if (r.handoffOnly) return input.mode === "live" || r.eventId === input.eventId;
    if (input.mode === "live") return r.mode === "live" || r.eventId === "LIVE-EU";
    return r.eventId === input.eventId && r.mode !== "live";
  };
  const now = input.now ?? Date.now();
  const working = queue.filter((r) => r.state === "running" && inScope(r) && (r.handoffOnly || now - t(r.createdAt) < STALE_RUNNING_MS));
  const candidates = queue.filter((r) => r.state === "awaiting" && inScope(r) && (r.handoffOnly || (r.lane === "full" && !isSmallTalk(r.question))));
  const seen = new Map<string, QueueRow>();
  for (const r of candidates) {
    if (r.handoffOnly) {
      seen.set(`h:${r.runId}`, r);
      continue;
    }
    const key = dupKey(r);
    const kept = seen.get(key);
    if (!kept) seen.set(key, { ...r, earlier: 0, earlierIds: [] });
    else {
      kept.earlier = (kept.earlier ?? 0) + 1;
      kept.earlierIds = [...(kept.earlierIds ?? []), r.runId];
    }
  }
  const pendingIds: string[] = [];
  const decidable: QueueRow[] = [];
  for (const r of seen.values()) {
    if (r.handoffOnly) decidable.push(r);
    else if (input.actionCounts[r.runId] === undefined) pendingIds.push(r.runId);
    else {
      const c = input.actionCounts[r.runId];
      if (c.outbound > 0) decidable.push(r);
      else if (c.total > 0) decidable.push({ ...r, internalOnly: true });
    }
  }
  const isHidden = (r: QueueRow) => input.hidden.has(r.runId);
  const visible = decidable.filter((r) => input.showHidden || !isHidden(r));
  return { rows: [...visible, ...working], hiddenCount: decidable.filter(isHidden).length, pendingIds };
}

/** "+2 earlier runs" / "+1 earlier run", or null. */
export function earlierText(row: Pick<QueueRow, "earlier">): string | null {
  const n = row.earlier ?? 0;
  return n > 0 ? `+${n} earlier ${n === 1 ? "run" : "runs"}` : null;
}

export const HIDDEN_RUNS_KEY = "floodsense-hidden-runs";

export function readHidden(storage: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const raw = storage?.getItem(HIDDEN_RUNS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeHidden(storage: Pick<Storage, "setItem"> | null, ids: ReadonlySet<string>): void {
  try {
    storage?.setItem(HIDDEN_RUNS_KEY, JSON.stringify([...ids]));
  } catch {
    /* private window: hiding lasts for this tab only */
  }
}

/** Pure: finished full-lane runs for the mode's event (Live: live-data runs), newest first, from the /runs/past rows. */
export function completedFullRuns(rows: readonly QueueRow[], mode: "live" | "past", eventId: string, skipId?: string): QueueRow[] {
  // awaiting_approval or approved only; newest by created_at (list order is not trusted). Live: any event.
  // Past flood: the chosen event's runs first, then the rest, so a real run is always shown when one exists.
  const done = rows.filter(
    (r) => r.lane === "full" && !isSmallTalk(r.question) && (r.status === "awaiting_approval" || r.status === "approved") && r.runId !== skipId,
  );
  // Equal start times: the current event's run first.
  const byNewest = (a: QueueRow, b: QueueRow) => t(b.createdAt) - t(a.createdAt) || Number(b.eventId === eventId) - Number(a.eventId === eventId);
  if (mode === "live") return [...done].sort(byNewest);
  const own = (r: QueueRow) => r.eventId === eventId && r.mode !== "live";
  return [...done.filter(own).sort(byNewest), ...done.filter((r) => !own(r)).sort(byNewest)];
}

/**
 * Pure: which of the candidate runs (newest first) Review shows: the newest that passed the Judge, else the newest.
 * `passes` is the Judge verdict of each loaded run (undefined: not looked at).
 */
export function preferJudgePass<T extends { runId: string }>(candidates: readonly T[], passes: Readonly<Record<string, boolean | null | undefined>>): T | null {
  return candidates.find((c) => passes[c.runId] === true) ?? candidates[0] ?? null;
}
