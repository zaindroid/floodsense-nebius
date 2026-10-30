import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { RecordedRun } from "../api/replay";
import { escalationOf, formatLatency, NODE_LABELS, pipelineIds, type PipelineNodeId } from "../lib/pipeline";
import { boardText, buildWalkthrough, clampBeat, type Beat } from "../lib/walkthrough";

/** One beat on screen before the next, when playing. Reading pace, not the run's real clock. */
const BEAT_MS = 1600;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const KIND_TEXT: Record<Beat["kind"], string> = {
  work: "agent step",
  board: "world model",
  loop: "loop back",
  gate: "human gate",
};

/** Pure: the state of a graph node at a beat, for the spine. */
export function nodeState(node: PipelineNodeId, beats: Beat[], at: number): "current" | "visited" | "ahead" {
  if (beats[at]?.spine === node) return "current";
  return beats.slice(0, at + 1).some((b) => b.spine === node) ? "visited" : "ahead";
}

/** Pure: how many agent steps a node has taken by this beat, so a re-run shows as ×2. */
export function nodeRuns(node: PipelineNodeId, beats: Beat[], at: number): number {
  return beats.slice(0, at + 1).filter((b) => b.spine === node && b.isRun).length;
}

function Ledger({ beat }: { beat: Beat }) {
  const l = beat.ledger;
  const items: [string, string][] = [
    ["queries", String(l.queries)],
    ["cited claims", String(l.claims)],
    ["supported", String(l.supported)],
    ["dropped", String(l.dropped)],
    ["revise", String(l.revises)],
    ["repair", String(l.repairs)],
    ["flagged", String(l.flagged)],
  ];
  return (
    <dl className="wt-ledger" aria-label="Verification so far">
      {items.map(([label, value]) => (
        <div key={label} className={`wt-tally${value === "0" ? " is-zero" : ""}`}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What the current beat did, and what can be checked against it. */
function BeatDetail({ beat, run, total }: { beat: Beat; run: RecordedRun; total: number }) {
  const flagged = beat.verdict?.flagged ?? [];
  const verdicts = (run.judgeClaims ?? []).filter((j) => flagged.includes(j.claimId));
  return (
    <div className="wt-detail" key={beat.index}>
      <p className="wt-beat-no">
        Beat {beat.index + 1} of {total}
      </p>
      <h3 className="wt-beat-head">
        {beat.heading}
        <span className={`wt-kind wt-kind-${beat.kind}`}>{KIND_TEXT[beat.kind]}</span>
      </h3>
      <p className="wt-said">{beat.summary}</p>
      <p className="wt-beat-meta">
        {beat.latencyMs !== null ? formatLatency(beat.latencyMs) : "no clock recorded"}
        {beat.lane && beat.lane !== "none" ? ` · lane ${beat.lane}` : ""}
        {beat.modelId ? ` · ${beat.modelId}` : ""}
      </p>

      {beat.loopTo && (
        <p className="wt-loop-note">
          The chain goes back to {NODE_LABELS[beat.loopTo]} and runs again. Nothing downstream keeps the old answer.
        </p>
      )}

      {beat.queryIds.length > 0 && (
        <section className="wt-block">
          <p className="section-label">Zetaris queries this step ran</p>
          <ul className="wt-ids">
            {beat.queryIds.map((id) => (
              <li key={id} className="wt-id" title={id}>
                {id.slice(0, 8)}
              </li>
            ))}
          </ul>
          <p className="note">Each id resolves to the statement and the rows it returned, so the step can be re-run.</p>
        </section>
      )}

      {beat.claims.length > 0 && (
        <section className="wt-block">
          <p className="section-label">Claims these queries ground</p>
          <ul className="wt-claims">
            {beat.claims.map((c) => (
              <li key={c.id}>
                <span className="wt-claim-id">{c.id}</span> {c.text}
                <span className="note"> · {c.citations.length} citation{c.citations.length === 1 ? "" : "s"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {beat.verdict && (
        <section className="wt-block">
          <p className="section-label">Judge</p>
          <p className={`wt-verdict ${beat.verdict.passed ? "is-pass" : "is-flag"}`}>
            {beat.verdict.passed ? "Passed" : "Flagged"}
            {beat.verdict.overall !== null && ` · overall ${beat.verdict.overall.toFixed(2)}`}
            {beat.verdict.hallucination !== null && ` · unsupported ${Math.round(beat.verdict.hallucination * 100)}%`}
          </p>
          {verdicts.map((j) => (
            <p key={j.claimId} className="wt-judge-claim">
              <span className="wt-claim-id">{j.claimId}</span> {j.grounding ?? "no grounding"}
              {j.score !== null && ` · ${j.score.toFixed(2)}`}
              {j.rationale && <span className="note"> — {j.rationale}</span>}
            </p>
          ))}
        </section>
      )}

      {beat.board && (
        <section className="wt-block">
          <p className="section-label">Hypotheses on the board</p>
          <ul className="wt-hyps">
            {beat.board.states.map((s) => (
              <li key={s.id} className={`wt-hyp wt-hyp-${s.state}`}>
                {s.id} {s.state.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Step through a recorded run, one trace step at a time.
 *
 * The pipeline card shows the finished graph. This shows the order it happened
 * in, which is where the run's judgement lives: a hypothesis proposed and then
 * dropped, the revise edge back to the Investigator, a claim the Judge flagged
 * and the repair round that rewrote it, and the human gate it stops at.
 */
export function RunWalkthrough({ run, onClose }: { run: RecordedRun; onClose: () => void }) {
  const { beats, unlinkedClaims } = useMemo(() => buildWalkthrough(run), [run]);
  const spineNodes = useMemo(() => pipelineIds(run), [run]);
  const escalation = escalationOf(run);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const total = beats.length;
  const beat = beats[at];

  const seek = useCallback((next: number) => setAt(clampBeat(next, total)), [total]);

  // Play stops itself at the gate rather than looping round.
  useEffect(() => {
    if (!playing) return;
    if (at >= total - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setAt((i) => clampBeat(i + 1, total)), BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [playing, at, total]);

  // Escape closes, arrows step, and Tab stays inside the dialog.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        setPlaying(false);
        setAt((i) => clampBeat(i + (event.key === "ArrowRight" ? 1 : -1), total));
        return;
      }
      const root = panelRef.current;
      if (event.key !== "Tab" || !root) return;
      const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [onClose, total]);

  if (!beat) return null;
  const atEnd = at >= total - 1;

  return (
    <div className="wt-backdrop">
      <div className="wt" role="dialog" aria-modal="true" aria-labelledby="wt-title" ref={panelRef}>
        <div className="wt-head">
          <div>
            <p className="section-label">Run walkthrough</p>
            <h2 id="wt-title">How this answer was reached, step by step</h2>
            <p className="wt-sub">
              run {run.runId} · {total} beats · paced for reading, each beat shows its own recorded time
            </p>
            {escalation && <p className="wt-escalation">{escalation}</p>}
          </div>
          <button ref={closeRef} type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="wt-body">
          <ol className="wt-spine" aria-label="Agent graph">
            {spineNodes.map((node, i) => {
              const state = nodeState(node, beats, at);
              const runs = nodeRuns(node, beats, at);
              const returning = beat.kind === "loop" && beat.loopTo === node;
              return (
                <li
                  key={node}
                  className={`wt-node is-${state}${returning ? " is-returning" : ""}`}
                  style={{ "--i": i } as CSSProperties}
                  aria-current={state === "current" ? "step" : undefined}
                >
                  <span className="wt-dot" aria-hidden="true" />
                  <span className="wt-node-name">{NODE_LABELS[node]}</span>
                  {runs > 1 && <span className="wt-runs">×{runs}</span>}
                </li>
              );
            })}
          </ol>

          <BeatDetail beat={beat} run={run} total={total} />
        </div>

        <div className="wt-foot">
          <div className="wt-transport">
            <button type="button" className="button" onClick={() => { setPlaying(false); seek(0); }} disabled={at === 0 && !playing}>
              Restart
            </button>
            <button type="button" className="button" onClick={() => { setPlaying(false); seek(at - 1); }} disabled={at === 0}>
              Back
            </button>
            <button type="button" className="button primary" onClick={() => (atEnd ? (seek(0), setPlaying(true)) : setPlaying(!playing))}>
              {playing ? "Pause" : atEnd ? "Play again" : "Play"}
            </button>
            <button type="button" className="button" onClick={() => { setPlaying(false); seek(at + 1); }} disabled={atEnd}>
              Next
            </button>
          </div>
          <ol className="wt-scrub" aria-label="Beats">
            {beats.map((b, i) => (
              <li key={b.index}>
                <button
                  type="button"
                  className={`wt-tick wt-tick-${b.kind}${i === at ? " is-at" : ""}${i < at ? " is-past" : ""}`}
                  onClick={() => { setPlaying(false); seek(i); }}
                  aria-label={`Beat ${i + 1}, ${b.heading}`}
                  aria-current={i === at ? "true" : undefined}
                  title={`${i + 1}. ${b.heading}`}
                />
              </li>
            ))}
          </ol>
          <Ledger beat={beat} />
          <p className="note wt-board-line">
            Board: {boardText(beat.board)}
            {unlinkedClaims.length > 0 &&
              ` · ${unlinkedClaims.length} claim(s) carry no query id in this trace: ${unlinkedClaims.map((c) => c.id).join(", ")}`}
          </p>
        </div>
      </div>
    </div>
  );
}
