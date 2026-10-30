import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AgentPipeline, LiveAgentPipeline } from "./AgentPipeline";
import { TechTrace } from "./TechTrace";
import { RetrievalPanel } from "./RetrievalPanel";
import { mergeContext } from "../lib/askContext";
import { capTurns, followUpThreadId, modeForPage, modeLabel } from "../api/ask";
import { fetchRecordedRun, replayRunId, type RecordedRun } from "../api/replay";
import { useConsole, useConsoleMaybe } from "../context/ConsoleContext";
import { citationsForClaim, numberedCitations } from "../lib/citations";
import { SourceBadges, SourceLegend } from "./SourceBadges";
import { CalmAnswer } from "./CalmAnswer";
import { calmApplies } from "../lib/calmAnswer";
import { answerEventId, sourceFromCitation, sourceFromRun } from "../lib/sources";
import { buildPipeline } from "../lib/pipeline";
import { servingLabel, servingQualifier } from "../lib/format";
import { greetingFor, switchEventLabel, switchTarget } from "../lib/chatGreeting";
import { shownEventId } from "../lib/events";
import { contextForMode, modeName } from "../lib/mode";
import { routeHref } from "../lib/route";
import { resolveFinalRun, startLiveRun, subscribeRunEvents } from "../api/liveRun";
import { turnBadge } from "../lib/turnBadge";
import { formatElapsed, initialLiveState, liveReducer, tipFor, type LiveRunState } from "../lib/liveRun";
import { evidenceForMemories } from "../lib/liveEvidence";
import { memoryLine, NO_MEMORIES, SEEDED_MEMORY_CHIP, seededMemoryNote, type MemoryUsed } from "../lib/hitl";
import { setAwaitingRunId } from "../lib/lastRun";
import { friendlyError, statusFromMessage } from "../lib/friendlyError";
import "../styles/hitl.css";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

interface Turn {
  id: number;
  question: string;
  run: RecordedRun | null;
  error: string | null;
  /** A plain assistant reply (the API's fast intent path: `{kind: "reply", answer}`, no run). */
  reply?: string | null;
  suggestions?: string[];
  /** The streamed pipeline as it ended, for a failed live run. */
  live?: LiveRunState | null;
}

/**
 * Gmail-style dock, bottom right. Non-modal: it never covers or pushes the page, and it never opens on a route change.
 * It opens with a greeting and three suggested questions fitted to the role and page. The recorded run
 * (VITE_REPLAY_RUN_ID, or the fixture on the desk) waits behind "See an example answer". The composer posts
 * a question to POST /runs; each answer is labelled by its own served_from, so a replay is never called live.
 */
export function AskFloodSense() {
  const desk = useConsole();
  const { answer, askOpen, askPrefill, clearAskPrefill, closeAsk, evidenceOpen, page, deskRoute } =
    desk;
  const greeting = greetingFor(deskRoute, desk.mode, shownEventId(desk.mode, desk.eventId));
  const exampleId = useId();
  const [showExample, setShowExample] = useState(false);
  // agents-visual: screen context (and a replay moment, when the popup was opened from Replay).
  const { askContext, screenContext } = desk;
  const panelId = useId();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  // A ref, so the drawer opening does not re-run the effect and pull focus around.
  const evidenceOpenRef = useRef(evidenceOpen);
  evidenceOpenRef.current = evidenceOpen;
  // Non-modal: hand focus back to the launcher only if it was still in the panel when it closed.
  const restoreFocusRef = useRef(false);
  const dismiss = () => {
    restoreFocusRef.current = Boolean(panelRef.current?.contains(document.activeElement));
    closeAsk();
  };
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const serving = servingLabel(answer);
  const hasLayerC = answer.citations.some((citation) => citation.layer === "c");
  // Optional recorded run. Unset or failed keeps the fixture answer.
  const [recorded, setRecorded] = useState<RecordedRun | null>(null);
  useEffect(() => {
    const runId = replayRunId();
    if (!runId) return;
    const controller = new AbortController();
    void fetchRecordedRun(runId, undefined, controller.signal).then((run) => {
      if (!controller.signal.aborted) setRecorded(run);
    });
    return () => controller.abort();
  }, []);

  // Conversation typed in this popup. Newest at the bottom; it survives closing the popup.
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<{ question: string; started: number; live: LiveRunState | null } | null>(
    null,
  );
  const [elapsed, setElapsed] = useState(0);
  // 429: Send waits until this instant, with a countdown.
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const [retryLeft, setRetryLeft] = useState(0);
  // Announced only when the countdown starts and when it ends, not every second.
  const [retryAnnounce, setRetryAnnounce] = useState("");
  useEffect(() => {
    if (retryUntil === null) return;
    const tick = () => {
      const left = Math.ceil((retryUntil - Date.now()) / 1000);
      if (left <= 0) {
        setRetryUntil(null);
        setRetryLeft(0);
        setRetryAnnounce("You can ask again now.");
      } else setRetryLeft(left);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [retryUntil]);
  const stopStreamRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopStreamRef.current?.(), []);
  const inflightRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTurnRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => inflightRef.current?.abort(), []);
  // A pre-filled question (the Now page's button) lands in the composer and waits for Send.
  useEffect(() => {
    if (!askOpen || askPrefill === null) return;
    setDraft(askPrefill);
    clearAskPrefill();
    textareaRef.current?.focus();
  }, [askOpen, askPrefill, clearAskPrefill]);
  useEffect(() => {
    if (!pending) return;
    const tick = () => setElapsed(Math.floor((Date.now() - pending.started) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [pending]);
  // A new answer: bring that turn's start into view.
  useEffect(() => {
    if (turns.length === 0) return;
    lastTurnRef.current?.scrollIntoView?.({ block: "start" });
  }, [turns]);
  // Anything else (pending bubble, reopening): follow the bottom only if the reader is already there.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [pending, askOpen]);

  const send = async (typed?: string, eventOverride?: string) => {
    const question = (typed ?? draft).trim();
    if (!question || sendingRef.current || retryUntil !== null) return;
    // A new question ends any earlier stream or poll.
    stopStreamRef.current?.();
    stopStreamRef.current = null;
    inflightRef.current?.abort();
    sendingRef.current = true;
    const controller = new AbortController();
    inflightRef.current = controller;
    // Follow-ups continue the thread of the newest answered run.
    const previous = [...turns].reverse().find((t) => t.run)?.run ?? null;
    if (typed === undefined) setDraft("");
    setPending({ question, started: Date.now(), live: null });
    // The global mode decides the event: Live sends none, Past sends the chosen event and its replay date.
    const mergedContext = contextForMode(mergeContext(screenContext(), askContext), desk.mode);
    const result = await startLiveRun(
      {
        question,
        threadId: followUpThreadId(previous),
        mode: modeForPage(page),
        context: mergedContext,
        ...(eventOverride ? { eventId: eventOverride } : mergedContext?.event_id ? { eventId: mergedContext.event_id } : {}),
      },
      controller.signal,
    );
    if (controller.signal.aborted || result.kind === "aborted") return;
    const finish = (turn: Partial<Omit<Turn, "id" | "question">>) => {
      if (controller.signal.aborted) return;
      stopStreamRef.current?.();
      stopStreamRef.current = null;
      sendingRef.current = false;
      inflightRef.current = null;
      setPending(null);
      setTurns((prev) => capTurns([...prev, { id: Date.now(), question, run: null, error: null, ...turn }]));
    };
    if (result.kind === "reply") return finish({ reply: result.answer, suggestions: result.suggestions });
    if (result.kind === "run") return finish({ run: result.run });
    if (result.kind === "error") return finish({ error: result.message });
    if (result.kind === "rate_limited") {
      // One message only: the countdown line. The question goes back to the composer; no turn is added.
      const secs = result.retryAfterS ?? 30;
      sendingRef.current = false;
      inflightRef.current = null;
      setPending(null);
      setDraft(question);
      setRetryUntil(Date.now() + secs * 1000);
      setRetryAnnounce(`FloodSense is busy. Your question was not started; you can ask again in ${secs} seconds.`);
      return;
    }
    // 202: a live run. Stream its pipeline, then read the final run.
    const runId = result.runId;
    let live = initialLiveState(runId);
    let concluded = false;
    setPending((p) => (p ? { ...p, live } : p));
    const conclude = async () => {
      if (concluded) return;
      concluded = true;
      stopStreamRef.current?.();
      if (live.status === "not_found") {
        return finish({ error: `Run ${runId} was not found. It may have stopped before its first step. Try again.`, live });
      }
      if (live.status === "failed") {
        return finish({ error: `Run ${runId} failed after it started. A failed live run is not swapped for a replay; try again.`, live });
      }
      if (live.status === "error") {
        return finish({ error: live.error ?? `Lost contact with run ${runId}.`, live });
      }
      try {
        // The badge comes from the stream's served_from, not the GET.
        const run = await resolveFinalRun(runId, live.servedFrom, { signal: controller.signal });
        if (run) {
          if (run.status === "awaiting_approval") setAwaitingRunId(runId);
          return finish({ run });
        }
        return finish({ error: `Run ${runId} ended (${live.status}) but its answer could not be read.`, live });
      } catch {
        if (!controller.signal.aborted) finish({ error: `Run ${runId} ended, but the final answer could not be fetched.`, live });
      }
    };
    stopStreamRef.current = subscribeRunEvents(runId, (event) => {
      if (controller.signal.aborted || concluded) return;
      live = liveReducer(live, event);
      setPending((p) => (p ? { ...p, live } : p));
      if (live.status !== "running") void conclude();
    }, { signal: controller.signal });
  };
  const cancel = () => {
    stopStreamRef.current?.();
    stopStreamRef.current = null;
    inflightRef.current?.abort();
    inflightRef.current = null;
    sendingRef.current = false;
    setPending(null);
  };
  const onComposerKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  useEffect(() => {
    if (!askOpen) return;
    closeRef.current?.focus();
    const launcher = launcherRef.current;
    restoreFocusRef.current = false;
    const onKey = (event: KeyboardEvent) => {
      const root = panelRef.current;
      if (!root) return;
      // The Evidence drawer is modal and handles its own Escape. Another open menu
      // (chip, bell, account) keeps its own Escape, so only dismiss from inside the panel.
      const active = document.activeElement;
      const inside =
        active === null ||
        active === document.body ||
        active === launcherRef.current ||
        (active instanceof Node && root.contains(active));
      if (event.key === "Escape" && event.isComposing) return;
      if (event.key === "Escape" && !evidenceOpenRef.current && inside && !event.defaultPrevented) {
        event.preventDefault();
        // First Esc in a non-empty composer clears the draft; the next one closes.
        if (active === textareaRef.current && draftRef.current !== "") {
          setDraft("");
          return;
        }
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      if (!(active instanceof Node) || !root.contains(active)) return;
      const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (restoreFocusRef.current) launcher?.focus();
    };
  }, [askOpen, closeAsk]);

  return (
    <div className="ask-dock">
      {askOpen && (
        <section className="ask-panel" id={panelId} role="dialog" aria-modal="false" aria-labelledby={titleId} ref={panelRef}>
          <header className="ask-head">
            <div>
              <h2 id={titleId}>Ask FloodSense</h2>
              <div className="segmented segmented--small ask-modes" role="group" aria-label="Answer mode">
                <span className="segmented__option is-active" title="Answers are grounded in retrieved, cited sources">
                  With retrieval
                </span>
              </div>
            </div>
            <button ref={closeRef} type="button" className="icon-button" aria-label="Close Ask FloodSense" onClick={dismiss}>
              <CloseIcon />
            </button>
          </header>
          <div
            className="ask-body"
            ref={scrollRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            <div className="ask-turn ask-greeting">
              <p className="ask-question">{greeting.text}</p>
              <p className="note ask-mode">Asking about: {modeName(desk.modeState)}{desk.demo ? " · DEMO DATA on screen" : ""}</p>
              <ul className="ask-suggestions" aria-label="Suggested questions">
                {greeting.suggestions.map((q) => (
                  <li key={q}>
                    <button
                      type="button"
                      className="ask-suggestion"
                      disabled={pending !== null}
                      onClick={() => void send(q)}
                    >
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="ask-link"
                aria-expanded={showExample}
                aria-controls={exampleId}
                onClick={() => setShowExample((v) => !v)}
              >
                {showExample ? "Hide the example answer" : "See an example answer"}
              </button>
            </div>
            <div className="ask-turn" id={exampleId} hidden={!showExample}>
              {showExample && (
              <>
              {!recorded && <p className="ask-badge ask-badge-replay">Example · Recorded run · not live</p>}
              {recorded ? (
                <RecordedAnswer run={recorded} badge={`Example · Recorded run · not live · ${recorded.runId}`} />
              ) : (
                <>
                  <p className="note">
                    Reviewed answer, {servingQualifier(serving)}, run {serving.runId}. Not live.
                  </p>
                  <p className="ask-question">{answer.question}</p>
                  <SourceLegend />
                  <ul className="ask-claims">
                    {answer.claims.map((claim) => (
                      <li key={claim.claim_id}>
                        {claim.text}{" "}
                        <SourceBadges
                          items={citationsForClaim(answer, claim.claim_id).map((c) => ({
                            n: c.n,
                            detail: sourceFromCitation(c.citation, answerEventId(answer)),
                          }))}
                        />
                      </li>
                    ))}
                  </ul>
                  <ol className="ask-citations">
                    {numberedCitations(answer).map(({ n, citation }) => (
                      <li key={citation.citation_id}>
                        [{n}] {citation.title} · {citation.publisher}
                      </li>
                    ))}
                  </ol>
                  <details className="disclosure">
                    <summary>How I got this</summary>
                    <ol className="ask-trace">
                      {answer.evidence.map((evidence) => (
                        <li key={evidence.query_id}>
                          <p className="menu-title">{evidence.view}</p>
                          <p className="note">
                            {evidence.query_id} · {evidence.row_count} row{evidence.row_count === 1 ? "" : "s"} ·{" "}
                            {evidence.executed_at_utc}
                          </p>
                          <pre className="sql">{evidence.sql}</pre>
                        </li>
                      ))}
                    </ol>
                    <p className="note">Fixture SQL, packed with the answer.</p>
                    {!hasLayerC && <p className="note">This answer has no layer (c) document citations.</p>}
                  </details>
                </>
              )}
              <div className="button-row">
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    // Move focus out first, so the drawer records the launcher as its opener.
                    launcherRef.current?.focus();
                    dismiss();
                    desk.openEvidence("discharge");
                  }}
                >
                  Open evidence
                </button>
              </div>
              </>
              )}
            </div>
            {turns.map((turn, i) => (
              <div
                key={turn.id}
                className="ask-turn"
                ref={i === turns.length - 1 ? lastTurnRef : undefined}
                aria-live={i === turns.length - 1 ? "polite" : undefined}
              >
                <p className="ask-bubble">{turn.question}</p>
                {turn.run ? (
                  <RecordedAnswer
                    run={turn.run}
                    badge={turnBadge(turn.run)}
                    onSwitch={
                      pending === null && switchTarget(turn.run) ? (eventId) => void send(turn.question, eventId) : undefined
                    }
                  />
                ) : turn.reply ? (
                  <>
                    <p className="ask-question ask-reply">{turn.reply}</p>
                    {turn.suggestions && turn.suggestions.length > 0 && (
                      <ul className="ask-suggestions" aria-label="Suggested follow-ups">
                        {turn.suggestions.map((q) => (
                          <li key={q}>
                            <button type="button" className="ask-suggestion" disabled={pending !== null} onClick={() => void send(q)}>
                              {q}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <ErrorTurn
                    raw={turn.error ?? ""}
                    role={deskRoute.role}
                    live={turn.live ?? null}
                    recorded={recorded}
                    onRetry={pending === null && retryUntil === null ? () => void send(turn.question) : undefined}
                  />
                )}
              </div>
            ))}
            {pending && (
              <div className="ask-turn">
                <p className="ask-bubble">{pending.question}</p>
                <p className="ask-working">
                  <span>{pending.live ? "Agents are working on your question" : "Starting a live run"}</span>
                  <span className="ask-elapsed">
                    {" "}
                    · <span className="sr-only">elapsed </span>
                    {formatElapsed(elapsed)}
                  </span>{" "}
                  . A full run can take several minutes.{" "}
                  <button type="button" className="ask-link" onClick={cancel} aria-label="Stop watching this run">
                    Cancel
                  </button>
                </p>
                <p className="ask-tip" aria-hidden="true">
                  Tip: {tipFor(elapsed)}
                </p>
                <p className="sr-only" role="status" aria-live="polite">
                  {pending.live?.announce ?? "Starting a live run."}
                </p>
                {pending.live && <LiveAgentPipeline state={pending.live} />}
              </div>
            )}
            {retryUntil !== null && (
              <p className="ask-retry" aria-hidden="true">
                FloodSense is busy; your question was not started. You can ask again in {formatElapsed(retryLeft)}.
              </p>
            )}
            <p className="sr-only" role="status" aria-live="polite">
              {retryAnnounce}
            </p>
          </div>
          <form
            className="ask-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={textareaRef}
              aria-label="Your question"
              rows={2}
              value={draft}
              placeholder="Ask about flood risk, exposure, or a place…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKey}
            />
            <button
              type="submit"
              className="button"
              disabled={pending !== null || retryUntil !== null || draft.trim() === ""}
              aria-label={retryUntil !== null ? `Send, available in ${retryLeft} seconds` : "Send question"}
            >
              Send
            </button>
          </form>
        </section>
      )}
      <button
        ref={launcherRef}
        type="button"
        className="ask-launcher"
        aria-expanded={askOpen}
        aria-controls={askOpen ? panelId : undefined}
        onClick={() => (askOpen ? dismiss() : desk.openAsk())}
      >
        Ask FloodSense
      </button>
    </div>
  );
}

/** An agent run, labelled by its own served_from: live, cache or replay. */
function RecordedAnswer({
  run,
  badge,
  onSwitch,
}: {
  run: RecordedRun;
  badge: string;
  /** A declined run that names the event holding the question: re-ask it there. */
  onSwitch?: (eventId: string) => void;
}) {
  const switchLabel = run.elsewhere ? switchEventLabel(run.elsewhere) : null;
  const kind = run.servedFrom === "live" ? "live" : run.servedFrom === "cache" ? "cached" : "replay";
  const calm = calmApplies(run);
  return (
    <>
      <p className={`ask-badge ask-badge-${kind}`}>{badge}</p>
      {modeLabel(run) && !calm && <p className="note ask-mode">{modeLabel(run)}</p>}
      {run.servedFrom !== "live" && run.label !== badge && <p className="note">{run.label}</p>}
      {run.status === "awaiting_approval" && (
        <p className="note ask-approval">
          Pending your approval on the <a href={routeHref("insurer", "approvals")}>Approvals page</a> · run {run.runId}
        </p>
      )}
      {calm && run.plain ? <CalmAnswer run={run} plain={run.plain} /> : <p className="ask-question">{run.summary}</p>}
      {onSwitch && run.elsewhere && switchLabel && (
        <div className="button-row">
          <button type="button" className="button" onClick={() => onSwitch(run.elsewhere as string)}>
            {switchLabel}
          </button>
        </div>
      )}
      {!calm && run.claims.some((c) => c.citations.length > 0) && <SourceLegend />}
      {!calm && <ul className="ask-claims">
        {(() => {
          // One number per distinct source across the answer, in first-seen order.
          const numbers = new Map<string, number>();
          return run.claims.map((claim) => (
            <li key={claim.id}>
              {claim.text}{" "}
              {run.flaggedClaimIds.includes(claim.id) && <strong className="note">[Flagged by Judge] </strong>}
              <SourceBadges
                items={claim.citations.map((citation) => {
                  const key = `${citation.layer}|${citation.title}|${citation.queryId ?? ""}|${citation.page ?? ""}|${citation.paragraph ?? ""}`;
                  if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
                  return { n: numbers.get(key) as number, detail: sourceFromRun(citation, run.eventId) };
                }).filter((item, i, all) => all.findIndex((o) => o.n === item.n) === i)}
              />
            </li>
          ));
        })()}
      </ul>}
      {(run.memoryUsed?.length || (!calm && (run.memoryUsed || buildPipeline(run).board))) && <MemoriesPanel memories={run.memoryUsed ?? []} run={run} />}
      {run.judgeOverall !== null && (
        <p className="note" title="Score from our independent checker agent">
          Checked: {run.judgeOverall.toFixed(2)}
          {run.judgePasses === null ? "" : run.judgePasses ? " · passes" : " · does not pass"}
        </p>
      )}
      {/* agents-visual: the pipeline folds to one line once the answer is here. */}
      <AgentPipeline run={run} />
      {!calm && <TechTrace run={run} />}
      {run.claims.some((c) => c.citations.some((ci) => ci.layer === "c")) && (
        <details className="disclosure">
          <summary>Document retrieval</summary>
          <RetrievalPanel run={run} />
          <p className="note">Trace recorded with run {run.runId}.</p>
        </details>
      )}
    </>
  );
}

/** A failed turn: friendly, role-aware text, Retry, an optional recorded answer, and the stripped detail collapsed. */
function ErrorTurn({
  raw,
  role,
  live,
  recorded,
  onRetry,
}: {
  raw: string;
  role: string;
  live: LiveRunState | null;
  recorded: RecordedRun | null;
  onRetry?: () => void;
}) {
  const info = friendlyError(statusFromMessage(raw), raw, role, recorded !== null);
  return (
    <>
      <p className="ask-error">{info.text}</p>
      {info.retry && (
        <div className="button-row">
          <button type="button" className="button" disabled={!onRetry} onClick={onRetry} aria-label="Retry this question">
            Retry
          </button>
        </div>
      )}
      {info.offerRecorded && recorded && (
        <div className="ask-fallback">
          <RecordedAnswer run={recorded} badge={`Latest recorded answer · not live · run ${recorded.runId}`} />
        </div>
      )}
      {live && <LiveAgentPipeline state={live} collapsed />}
      {info.technical && (
        <details className="disclosure">
          <summary>Technical detail</summary>
          <p className="note">{info.technical}</p>
        </details>
      )}
    </>
  );
}

/** Run-level H-MEM recall. Memories are prompt context, never cited, so no sentence is marked as using one. */
export function MemoriesPanel({ memories, run }: { memories: MemoryUsed[]; run?: RecordedRun }) {
  const board = run ? buildPipeline(run).board : null;
  const openLiveEvidence = useConsoleMaybe()?.openLiveEvidence;
  return (
    <section className="mem-panel" aria-label="Memories used">
      <p className="mem-title">Memories used</p>
      {memories.length === 0 ? (
        <p className="note">{NO_MEMORIES}</p>
      ) : (
        <ul className="mem-list">
          {memories.map((m) => (
            <li key={m.memoryId}>
              {m.seeded ? (
                <span className="chip chip--sample">{SEEDED_MEMORY_CHIP}</span>
              ) : (
                <span className="src-chip src-chip-memory">H-MEM</span>
              )}{" "}
              {memoryLine(m)}
              {seededMemoryNote(m) && <span className="note"> {seededMemoryNote(m)}</span>}
            </li>
          ))}
        </ul>
      )}
      {board && (
        <p className="note">
          <span className="src-chip src-chip-world">World Model</span>{" "}
          {board.states.map((s) => `${s.id} ${s.state.replace(/_/g, " ")}`).join(" · ")}
        </p>
      )}
      {memories.length > 0 && (
        <p className="note">
          Context for the whole run; not linked to any one sentence.{" "}
          {openLiveEvidence && (
            <button type="button" className="link-button" onClick={() => openLiveEvidence(evidenceForMemories(memories))}>
              Open in the evidence panel
            </button>
          )}
        </p>
      )}
    </section>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
