import { EVENT_META } from "../lib/events";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useConsole } from "../context/ConsoleContext";
import { fetchApproval, postApproval } from "../api/liveRun";
import { fetchPastRuns, type PastRunsLoad } from "../api/pastRuns";
import { adoptRunBody } from "../api/replay";
import { apiBaseUrl } from "../api/config";
import { plainLanguage } from "../lib/plain";
import { routeHref } from "../lib/route";
import { getAwaitingRunId, onAwaitingRunId, setAwaitingRunId } from "../lib/lastRun";
import { onTrackedRuns, trackedRuns, type TrackedRun } from "../lib/assessRuns";
import {
  approvalHeader,
  buildQueue,
  curateQueue,
  earlierText,
  pickSelection,
  type RunQuality,
  queueRowLine,
  readHidden,
  writeHidden,
  type QueueRow,
} from "../lib/approvalQueue";
import { numberAnswerReferences, numberRunReferences, type ReferenceSet } from "../lib/references";
import { answerEventId } from "../lib/sources";
import {
  actionChip,
  adoptPlaybook,
  buildApprovalBody,
  cardStatus,
  decisionStatusLine,
  draftLabel,
  errorDetail,
  reviewEvidence,
  shortTitle,
  sitesLine,
  type ApprovalBody,
  type CardStatus,
  type PlaybookItem,
  type ReviewEvidence,
} from "../lib/hitl";
import { isOperatorRunKey, operatorActionChip } from "../lib/operatorDesk";
import { traceProvider } from "../lib/modelChip";
import { RefMarks } from "./RefMarks";
import "../styles/hitl.css";
import "../styles/insurer.css";

export interface QueueSource {
  /** null: the packed fixture, decided locally. */
  runId: string | null;
  summary: string;
  items: PlaybookItem[];
  judgeScore: number | null;
  judgePasses: boolean | null;
  status: CardStatus;
  note: string | null;
  evidence: ReviewEvidence;
  /** From the approval body; empty for the packed example. */
  modelIds?: string[];
  provider?: string | null;
  eventId?: string | null;
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Pure: the queue for a GET /runs/{id}/approval body. */
export function queueFromApproval(runId: string, body: Record<string, unknown>): QueueSource {
  const js = rec(body.judge_summary);
  const approval = rec(body.approval);
  return {
    runId,
    summary: typeof body.summary === "string" ? body.summary : "",
    items: adoptPlaybook(body.playbook),
    judgeScore: typeof js?.overall === "number" ? js.overall : null,
    judgePasses: typeof js?.passes === "boolean" ? js.passes : null,
    status: cardStatus(typeof body.status === "string" ? body.status : null, typeof approval?.status === "string" ? approval.status : null),
    note: null,
    evidence: reviewEvidence(body),
    modelIds: Array.isArray(body.model_ids) ? body.model_ids.filter((m): m is string => typeof m === "string") : [],
    provider: traceProvider(body.trace),
    eventId: typeof body.event_id === "string" ? body.event_id : null,
  };
}

/** Pure: the edit drafts, starting from every outbound action's current draft. */
export function initialDrafts(items: readonly PlaybookItem[]): Record<string, string> {
  return Object.fromEntries(items.filter((i) => i.outbound).map((i) => [i.actionId, i.draftMessage ?? ""]));
}

const EXAMPLE = "__example__";
const PAST_POLL_MS = 20_000;

type Loaded = { kind: "ok"; source: QueueSource; refs: ReferenceSet | null } | { kind: "gone"; message: string } | { kind: "loading" };

/**
 * The HITL home, two panes. Left: runs waiting for a person, newest first (GET /runs/past plus the live-run
 * handoff). Right: the selected run's proposed actions, drafts, one run-level decision, and its claims with
 * Judge evidence and numbered sources. Nothing is sent from here.
 */
export function Approvals({ operator = false }: { operator?: boolean } = {}) {
  const desk = useConsole();
  const [rawHandoff, setHandoff] = useState<string | null>(() => getAwaitingRunId());
  const [allTracked, setTracked] = useState<TrackedRun[]>(() => trackedRuns());
  // Civil protection desk: only runs started from the operator desk (tracked key "operator:...") are this queue.
  const tracked = useMemo(() => (operator ? allTracked.filter((r) => isOperatorRunKey(r.key)) : allTracked), [operator, allTracked]);
  const handoff = operator && !tracked.some((r) => r.runId === rawHandoff) ? null : rawHandoff;
  const [past, setPast] = useState<PastRunsLoad | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => onAwaitingRunId(setHandoff), []);
  useEffect(() => onTrackedRuns(setTracked), []);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      void fetchPastRuns(50, controller.signal).then((r) => {
        if (!controller.signal.aborted) setPast(r);
      });
    load();
    const timer = setInterval(load, PAST_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [handoff, tracked, refreshKey]);

  const [hidden, setHidden] = useState<Set<string>>(() => readHidden(safeStorage()));
  const [showHidden, setShowHidden] = useState(false);
  const [counts, setCounts] = useState<Record<string, RunQuality>>({});
  const base = useMemo(() => {
    const rows = past && past.ok ? past.rows : [];
    const own = operator ? rows.filter((row) => tracked.some((r) => r.runId === row.runId)) : rows;
    return buildQueue(own, handoff, tracked);
  }, [past, handoff, tracked, operator]);
  const curated = useMemo(
    () => curateQueue(base, { mode: operator ? "live" : desk.mode, eventId: desk.eventId, hidden, showHidden, actionCounts: counts }),
    [base, operator, desk.mode, desk.eventId, hidden, showHidden, counts],
  );
  const queue = curated.rows;
  // Only runs with an outbound action can be decided; the list endpoint does not say, so look each candidate up once.
  const pendingKey = curated.pendingIds.join(",");
  useEffect(() => {
    const ids = pendingKey ? pendingKey.split(",") : [];
    if (ids.length === 0) return;
    let gone = false;
    for (const id of ids) {
      void fetchApproval(id)
        .then(({ status, body }) => {
          if (gone) return;
          const items = status === 200 && body ? queueFromApproval(id, body).items : [];
          const n: RunQuality = {
            outbound: items.filter((i) => i.outbound).length,
            total: items.length,
            passes: status === 200 && body ? queueFromApproval(id, body).judgePasses : null,
            stale: status === 200 && !!body && /STALE/.test(JSON.stringify([body.summary, body.claims, body.trace])),
          };
          setCounts((m) => (m[id] === undefined ? { ...m, [id]: n } : m));
        })
        .catch(() => {
          if (!gone) setCounts((m) => (m[id] === undefined ? { ...m, [id]: { outbound: 0, total: 0 } } : m));
        });
    }
    return () => {
      gone = true;
    };
  }, [pendingKey]);
  const hideRun = (id: string) =>
    setHidden((cur) => {
      const next = new Set(cur).add(id);
      writeHidden(safeStorage(), next);
      return next;
    });
  const unhideRun = (id: string) =>
    setHidden((cur) => {
      const next = new Set(cur);
      next.delete(id);
      writeHidden(safeStorage(), next);
      return next;
    });
  const auto = pickSelection(queue, picked === EXAMPLE ? null : picked, handoff, counts);
  // A run decided here stays on screen with its outcome, even after it leaves the awaiting list.
  const pickedDecided = !!picked && picked !== EXAMPLE && (() => {
    const l = loaded[picked];
    return l?.kind === "ok" && l.source.status !== "pending";
  })();
  const selectedId = picked === EXAMPLE ? null : pickedDecided ? picked : auto;
  const selectedRow = queue.find((r) => r.runId === selectedId) ?? (past?.ok ? past.rows.find((r) => r.runId === selectedId) : undefined) ?? null;

  useEffect(() => {
    if (!selectedId || loaded[selectedId]?.kind === "ok") return;
    let gone = false;
    setLoaded((m) => ({ ...m, [selectedId]: { kind: "loading" } }));
    void fetchApproval(selectedId)
      .then(({ status, body }) => {
        if (gone) return;
        if (status === 200 && body) {
          const run = adoptRunBody(body, selectedId);
          const refs = run ? numberRunReferences(run.claims, { scope: `apv-${selectedId}`, eventId: run.eventId }) : null;
          setLoaded((m) => ({ ...m, [selectedId]: { kind: "ok", source: queueFromApproval(selectedId, body), refs } }));
          return;
        }
        const message =
          status === 409
            ? `Run ${selectedId} is no longer waiting for a decision.`
            : `Run ${selectedId} could not be loaded (${status}${errorDetail(body) ? `: ${errorDetail(body)}` : ""}).`;
        setLoaded((m) => ({ ...m, [selectedId]: { kind: "gone", message } }));
        if ((status === 404 || status === 409) && handoff === selectedId) setAwaitingRunId(null);
      })
      .catch(() => {
        if (!gone) setLoaded((m) => ({ ...m, [selectedId]: { kind: "gone", message: "The API could not be reached." } }));
      });
    return () => {
      gone = true;
    };
    // `loaded` is read only to skip a refetch; it must not retrigger this effect.
  }, [selectedId, handoff]);

  const answer = desk.answer;
  const fixture: QueueSource = useMemo(
    () => ({
      runId: null,
      summary: answer.question,
      items: (answer.playbook_actions ?? []).map((a) => ({
        actionId: a.action_id,
        horizonH: null,
        text: plainLanguage(a.detail),
        claimIds: [],
        outbound: a.outbound ?? false,
        released: a.released ?? false,
        actionType: a.action_type ?? null,
        title: a.title || shortTitle(a.detail),
        targetRegion: a.target_region ?? null,
        affectedSiteCount: a.affected_site_count ?? null,
        draftMessage: a.draft_message ?? null,
      })),
      judgeScore: answer.judge?.overall_score ?? null,
      judgePasses: null,
      status: desk.approval.status,
      note: desk.approval.note ?? null,
      evidence: reviewEvidence({
        claims: answer.claims.map((c) => ({ ...c, citations: answer.citations.filter((ci) => ci.claim_id === c.claim_id) })),
        judge: answer.judge?.claims ?? [],
      }),
      eventId: answerEventId(answer) ?? "EMSR773",
    }),
    [answer, desk.approval],
  );
  const fixtureRefs = useMemo(() => numberAnswerReferences(answer, { scope: "apv-example", eventId: answerEventId(answer) }), [answer]);

  const current = selectedId ? loaded[selectedId] : undefined;
  const live = current?.kind === "ok" ? current : null;
  const source = live ? live.source : fixture;
  const refs = live ? live.refs : fixtureRefs;
  const showingLive = !!selectedId && !!live;
  // The operator queue has no packed insurer example: with no live run selected it shows an empty state.
  const operatorEmpty = operator && !showingLive && current?.kind !== "loading";

  const decide = useCallback(
    async (body: ApprovalBody): Promise<string | null> => {
      if (!source.runId) {
        const status: CardStatus = body.action === "approve" ? "approved" : body.action === "edit" ? "edited" : "rejected";
        desk.decide(status, body.reviewer_note ?? "");
        return null;
      }
      const runId = source.runId;
      setPicked(runId);
      const result = await postApproval(runId, body);
      if (!result.ok) return result.message;
      const approval = rec(result.body?.approval);
      const status = cardStatus(typeof result.body?.status === "string" ? result.body.status : null, typeof approval?.status === "string" ? approval.status : null);
      setLoaded((m) => {
        const cur = m[runId];
        if (cur?.kind !== "ok") return m;
        const next: QueueSource = {
          ...cur.source,
          status: status === "pending" ? (body.action === "reject" ? "rejected" : body.action === "edit" ? "edited" : "approved") : status,
          note: body.reviewer_note ?? null,
          items: cur.source.items.map((i) => (body.draft_messages?.[i.actionId] ? { ...i, draftMessage: body.draft_messages[i.actionId] } : i)),
        };
        return { ...m, [runId]: { ...cur, source: next } };
      });
      if (getAwaitingRunId() === runId) setAwaitingRunId(null);
      setRefreshKey((k) => k + 1);
      return null;
    },
    [desk, source.runId],
  );

  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => setEditing(false), [source.runId]);
  const startEdit = () => {
    setDrafts(initialDrafts(source.items));
    setEditing(true);
  };

  const header = approvalHeader({
    runId: showingLive ? source.runId : null,
    row: selectedRow,
    modelIds: source.modelIds ?? [],
    provider: source.provider,
    judgeScore: source.judgeScore,
    judgePasses: source.judgePasses,
    eventId: source.eventId,
    exampleRunId: answer.run_id,
  });
  const ev = source.evidence;
  const reviewHref = source.runId ? `${apiBaseUrl()}/runs/${encodeURIComponent(source.runId)}` : routeHref("insurer", "review");
  const awaitingCount = queue.filter((r) => r.state === "awaiting").length;

  return (
    <div className="apv hitl">
      <nav className="apv-queue card" aria-label={operator ? "Runs from the Civil protection desk awaiting approval" : "Runs awaiting approval"}>
        <div className="apv-queue__head">
          <p className="section-label">Awaiting approval</p>
          <span className="apv-count" aria-label={`${awaitingCount} runs awaiting approval`}>
            {awaitingCount}
          </span>
        </div>
        {past && !past.ok && <p className="note">Run list unavailable ({past.detail}). Only runs started in this tab are listed.</p>}
        {curated.pendingIds.length > 0 && (
          <p className="note" role="status">
            Checking {curated.pendingIds.length} {curated.pendingIds.length === 1 ? "run" : "runs"} for actions to approve…
          </p>
        )}
        {queue.length === 0 && curated.pendingIds.length === 0 ? (
          <p className="apv-empty note">
            {operator
              ? "No run from the Civil protection desk is waiting for a decision. Use Escalate to agents on the Situation board; the run lands here once the agents finish."
              : desk.mode === "past"
                ? `No ${EVENT_META[desk.eventId].short} run has actions or notes waiting for a decision.`
                : "No live run has actions or notes waiting for a decision."}{" "}
            {operator ? "" : "Runs started from Alerts or Ask FloodSense land here once the agents finish."}
          </p>
        ) : (
          <ul className="apv-queue__list">
            {queue.map((row) => (
              <QueueItem
                key={row.runId}
                row={row}
                selected={row.runId === selectedId}
                onSelect={() => setPicked(row.runId)}
                hidden={hidden.has(row.runId)}
                onHide={() => hideRun(row.runId)}
                onUnhide={() => unhideRun(row.runId)}
              />
            ))}
          </ul>
        )}
        {(curated.hiddenCount > 0 || showHidden) && (
          <p className="note">
            <button type="button" className="link-button" aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? "Hide hidden runs again" : `Show hidden (${curated.hiddenCount})`}
            </button>
          </p>
        )}
        {!operator && (
          <ul className="apv-queue__list apv-queue__list--example">
            <li>
              <button
                type="button"
                className={`apv-item apv-item--example${!showingLive ? " is-selected" : ""}`}
                aria-current={!showingLive ? "true" : undefined}
                onClick={() => setPicked(EXAMPLE)}
              >
                <span className="apv-item__title">Packed example run</span>
                <span className="apv-item__line">Recording shipped with the UI · not live</span>
              </button>
            </li>
          </ul>
        )}
      </nav>

      {operatorEmpty ? (
        <div className="apv-detail">
          <section className="card" aria-labelledby="apv-title">
            <p className="section-label">Civil protection</p>
            <h2 id="apv-title">Nothing selected</h2>
            <p className="note">
              Proposed actions for your authority appear here after you press Escalate to agents on the Situation board and the agents
              finish. Nothing is sent from this page: each action is a draft that a person approves, edits or rejects.
            </p>
            <p>
              <a className="button ghost" href={routeHref("operator", "situation")}>
                Back to the Situation board
              </a>
            </p>
          </section>
        </div>
      ) : (
      <div className="apv-detail">
        <section className="card apv-header" aria-labelledby="apv-title">
          <p className="section-label">{header.kind === "live" ? "Selected run" : "Example"}</p>
          <h2 id="apv-title">{header.title}</h2>
          {current?.kind === "loading" && <p className="note">Loading run {selectedId}…</p>}
          {current?.kind === "gone" && <p className="note">{current.message} Showing the packed example.</p>}
          <dl className="apv-facts">
            {header.facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          {header.note && <p className="note">{header.note}</p>}
          {source.summary && <p className="apv-question">{plainLanguage(source.summary)}</p>}
          {operator && (
            <p className="note">
              Action wording is for authorities: Inform public, Request support. The agents' action types are reused, so a draft may still use
              the wording it was written with.
            </p>
          )}
        </section>

        <section className="card" aria-labelledby="apv-actions">
          <div className="apv-section-head">
            <h3 id="apv-actions">Proposed actions</h3>
            <span className="muted small">
              {source.items.length} action{source.items.length === 1 ? "" : "s"} · {ev.scored > 0 ? `${ev.supported} / ${ev.claims.length} claims supported` : "claims not scored"} ·{" "}
              {ev.citations} citations
            </span>
          </div>
          {source.items.length === 0 ? (
            <p className="note">No proposed action on this run.</p>
          ) : (
            <ul className="approval-list">
              {source.items.map((item) => (
                <ActionCard
                  key={item.actionId}
                  item={item}
                  source={source}
                  operator={operator}
                  editing={editing && item.outbound}
                  draft={drafts[item.actionId] ?? item.draftMessage ?? ""}
                  onDraft={(text) => setDrafts((d) => ({ ...d, [item.actionId]: text }))}
                />
              ))}
            </ul>
          )}
          <DecisionBar
            key={source.runId ?? EXAMPLE}
            source={source}
            editing={editing}
            drafts={drafts}
            onStartEdit={startEdit}
            onCancelEdit={() => setEditing(false)}
            onDecide={async (body) => {
              const message = await decide(body);
              if (!message) setEditing(false);
              return message;
            }}
          />
        </section>

        <section className="card" aria-labelledby="apv-claims">
          <div className="apv-section-head">
            <h3 id="apv-claims">Claims and Judge evidence</h3>
            {!source.runId && <span className="chip chip--sample">Recorded example · not live</span>}
          </div>
          {ev.claims.length === 0 ? (
            <p className="note">This run carries no claims.</p>
          ) : (
            <ul className="claim-summary apv-claims">
              {ev.claims.map((claim) => (
                <li key={claim.id}>
                  {claim.grounding ? (
                    <span className={`badge badge-${claim.grounding}`}>
                      {claim.grounding}
                      {claim.score !== null ? ` ${claim.score.toFixed(2)}` : ""}
                    </span>
                  ) : (
                    <span className="badge">not scored</span>
                  )}{" "}
                  {plainLanguage(claim.text)} {refs && <RefMarks nums={refs.claims.find((c) => c.id === claim.id)?.refs ?? []} refs={refs.refs} />}
                </li>
              ))}
            </ul>
          )}
          <div className="button-row">
            {source.runId ? (
              <a className="button ghost" href={reviewHref} target="_blank" rel="noreferrer">
                Raw run {source.runId} (JSON)
              </a>
            ) : (
              <a className="button ghost" href={reviewHref}>
                Read the review chain
              </a>
            )}
            {!source.runId && source.status !== "pending" && (
              <button type="button" className="button ghost" onClick={desk.resetApproval}>
                Reset example
              </button>
            )}
          </div>
        </section>
      </div>
      )}
    </div>
  );
}

function QueueItem({
  row,
  selected,
  onSelect,
  hidden,
  onHide,
  onUnhide,
}: {
  row: QueueRow;
  selected: boolean;
  onSelect: () => void;
  hidden: boolean;
  onHide: () => void;
  onUnhide: () => void;
}) {
  const running = row.state === "running";
  const earlier = earlierText(row);
  return (
    <li className={hidden ? "apv-item-wrap is-hidden" : "apv-item-wrap"}>
      <button
        type="button"
        className={`apv-item apv-item--${row.state}${selected ? " is-selected" : ""}`}
        aria-current={selected ? "true" : undefined}
        disabled={running}
        onClick={onSelect}
        title={running ? "The agents are still working on this run. It can be decided once it reaches review." : undefined}
      >
        <span className="apv-item__title">{row.question ? shortTitle(row.question, 70) : "Run waiting for review"}</span>
        <span className="apv-item__line">
          {running && <span className="agp-pulse" aria-hidden="true" />} {queueRowLine(row)}
          {earlier ? ` · ${earlier}` : ""}
        </span>
      </button>
      {!running && (
        <button
          type="button"
          className="link-button apv-hide"
          aria-label={`${hidden ? "Unhide" : "Hide"} this run: ${row.question ?? "run waiting for review"}`}
          onClick={hidden ? onUnhide : onHide}
        >
          {hidden ? "Unhide this run" : "Hide this run"}
        </button>
      )}
    </li>
  );
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function JudgeBadge({ score, passes }: { score: number | null; passes: boolean | null }) {
  if (score === null) return <span className="judge-badge judge-badge--none">Judge · not scored</span>;
  const tone = passes === false || score < 0.7 ? "warn" : "ok";
  return (
    <span className={`judge-badge judge-badge--${tone}`} title="Judge overall score for this run">
      Judge {score.toFixed(2)}
      {passes === null ? "" : passes ? " · passes" : " · does not pass"}
    </span>
  );
}

/** One proposed action: content and its draft. No buttons; the decision is run level. */
function ActionCard({
  item,
  source,
  operator = false,
  editing,
  draft,
  onDraft,
}: {
  item: PlaybookItem;
  source: QueueSource;
  operator?: boolean;
  editing: boolean;
  draft: string;
  onDraft: (text: string) => void;
}) {
  const draftId = useId();
  return (
    <li className={`approval approval--${source.status}`}>
      <div className="approval__summary">
        <span className={`chip chip--${item.actionType ?? "action"}`}>{operator ? operatorActionChip(item.actionType) : actionChip(item.actionType)}</span>
        <strong>{item.title}</strong>
        <span className="muted small">
          {item.targetRegion ?? "Region not stated"}
          {operator ? "" : ` · ${sitesLine(item.affectedSiteCount, source.eventId)}`}
          {item.horizonH !== null ? ` · ${item.horizonH} h` : ""}
        </span>
        <JudgeBadge score={source.judgeScore} passes={source.judgePasses} />
        <span className={`status status--${source.status}`}>{source.status}</span>
      </div>
      <div className="approval__detail">
        {item.text && item.text !== item.title && <p>{plainLanguage(item.text)}</p>}
        <p className="eyebrow" id={draftId}>
          {draftLabel(item.outbound)}
        </p>
        {editing ? (
          <textarea aria-labelledby={draftId} value={draft} rows={5} onChange={(e) => onDraft(e.target.value)} />
        ) : item.draftMessage ? (
          <blockquote className={`draft${item.outbound ? "" : " draft--internal"}`}>{item.draftMessage}</blockquote>
        ) : (
          <p className="note">{item.outbound ? "No draft was built for this action." : "No note text for this internal action."}</p>
        )}
      </div>
    </li>
  );
}

function DecisionBar({
  source,
  editing,
  drafts,
  onStartEdit,
  onCancelEdit,
  onDecide,
}: {
  source: QueueSource;
  editing: boolean;
  drafts: Record<string, string>;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onDecide: (body: ApprovalBody) => Promise<string | null>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = source.items.length;
  const anyOutbound = source.items.some((i) => i.outbound);
  const locked = source.status !== "pending" || busy;

  const submit = async (action: ApprovalBody["action"]) => {
    const built = buildApprovalBody(action, note, action === "edit" ? drafts : {}, source.items);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const message = await onDecide(built.body);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  };

  if (source.status !== "pending") {
    return (
      <p className={`status-line status-line--${source.status === "edited" ? "approved" : source.status}`} role="status">
        {decisionStatusLine(source.status)}
        {source.note && <> Note: “{source.note}”</>}
      </p>
    );
  }
  return (
    <div className="decision-bar hitl-decision apv-decision" role="group" aria-label="Decision for this run">
      <p className="hitl-scope">
        This decision applies to all {n} proposed action{n === 1 ? "" : "s"} in this run. Nothing is sent: outbound actions are drafts in this demo.
      </p>
      <label className="field">
        Reviewer note
        <input
          type="text"
          placeholder="Required to reject or edit."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={locked}
        />
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="approval__actions">
        {editing ? (
          <>
            <button type="button" className="button primary" disabled={locked} onClick={() => void submit("edit")}>
              Save edits and approve
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => { setError(null); onCancelEdit(); }}>
              Cancel edit
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button danger" disabled={locked} onClick={() => void submit("reject")}>
              Reject run
            </button>
            {anyOutbound && (
              <button type="button" className="button" disabled={locked} onClick={onStartEdit}>
                Edit drafts
              </button>
            )}
            <button type="button" className="button primary" disabled={locked} onClick={() => void submit("approve")}>
              Approve run
            </button>
          </>
        )}
      </div>
    </div>
  );
}
