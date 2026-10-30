import { useState, type ReactNode } from "react";
import type { RecordedRun } from "../api/replay";
import { buildPipeline, escalationOf, formatLatency, type PipelineBadge, type WorldBoard } from "../lib/pipeline";
import type { LiveRunState } from "../lib/liveRun";
import { modelChip, runModelLine } from "../lib/modelChip";

type StepState = "done" | "flag" | "waiting" | "skipped" | "running" | "idle";

interface StepRow {
  id: string;
  label: string;
  state: StepState;
  durationMs: number | null;
  chip: string | null;
  summary: string;
  runs: number;
  badges: PipelineBadge[];
  loop: string | null;
}

const STATE_TEXT: Record<StepState, string> = {
  done: "done",
  flag: "flagged",
  waiting: "waiting",
  skipped: "not run",
  running: "running",
  idle: "queued",
};

const STATE_ICON: Record<StepState, string> = {
  done: "✓",
  flag: "!",
  waiting: "⏸",
  skipped: "–",
  running: "",
  idle: "○",
};

/** One agent per line: icon, name, status, duration and model chip. Details (summary, sources) open on click. */
function StepList({ rows }: { rows: StepRow[] }) {
  return (
    <ol className="stp-list">
      {rows.map((row) => {
        const head = (
          <>
            <span className={`stp-icon stp-icon-${row.state}`} aria-hidden="true">
              {row.state === "running" ? <span className="agp-pulse" /> : STATE_ICON[row.state]}
            </span>
            <span className="stp-name">{row.label}</span>
            <span className={`stp-state stp-state-${row.state}`}>{STATE_TEXT[row.state]}</span>
            {row.durationMs !== null && <span className="stp-time">{formatLatency(row.durationMs)}</span>}
            {row.chip && <span className="stp-chip">{row.chip}</span>}
            {row.loop && <span className="stp-loop">{row.loop}</span>}
          </>
        );
        const hasDetail = row.summary || row.badges.length > 0 || row.runs > 1;
        return (
          <li key={row.id} className={`stp-row stp-row-${row.state}`} data-node={row.id} aria-current={row.state === "running" ? "step" : undefined}>
            {hasDetail ? (
              <details className="stp-details">
                <summary className="stp-head">{head}</summary>
                <div className="stp-body">
                  {row.summary && <p className="stp-summary">{row.summary}</p>}
                  {row.runs > 1 && <p className="note">Ran {row.runs}× (a revise or repair loop runs it again).</p>}
                  {row.badges.length > 0 && (
                    <ul className="agp-badges" aria-label={`${row.label} sources`}>
                      {row.badges.map((b) => (
                        <li key={b.text} className={`agp-badge agp-badge-${b.kind}`}>
                          {b.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            ) : (
              <div className="stp-head">{head}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function LoopChips({ revise, repair }: { revise: number; repair: number }) {
  if (revise === 0 && repair === 0) return null;
  return (
    <p className="stp-chips" aria-label="Loops">
      {revise > 0 && <span className="stp-loop">Skeptic revise ×{revise}</span>}
      {repair > 0 && <span className="stp-loop">Judge repair ×{repair}</span>}
    </p>
  );
}

/** "Escalated to the full investigation: …" when the quick lane handed the run on (#79 router). */
export function escalationLine(summary: string | null | undefined): string | null {
  if (!summary) return null;
  return `Escalated to the full investigation: ${summary.replace(/^escalated:\s*/i, "")}`;
}

function EscalationLine({ summary }: { summary: string | null | undefined }) {
  const line = escalationLine(summary);
  return line ? <p className="stp-escalation">↗ {line}</p> : null;
}

function BoardChips({ board }: { board: WorldBoard | null }) {
  if (!board) return null;
  return (
    <p className="stp-chips stp-board" aria-label="World Model hypotheses">
      <span className="agp-badge agp-badge-world">World Model</span>
      {board.states.map((s) => (
        <span key={s.id} className={`agp-hyp agp-hyp-${s.state}`}>
          {s.id} {s.state.replace(/_/g, " ")}
        </span>
      ))}
    </p>
  );
}

/** Pure: "8 agents · 5 min 12 s · Nemotron 3.5 Lightning 30B via Nebius Token Factory · Judge 0.90". */
export function pipelineSummary(run: RecordedRun): string {
  const model = buildPipeline(run);
  const ran = model.nodes.filter((n) => n.status !== "skipped" && n.id !== "approval").length;
  const parts = [`${ran} agent${ran === 1 ? "" : "s"}`];
  if (model.totalLatencyMs > 0) parts.push(formatLatency(model.totalLatencyMs));
  // Provider only when the run states it; otherwise the model names alone (a recorded run is not assumed to be the current backend).
  const usageIds = (run.usage?.models ?? []).map((u) => u.modelId);
  const m =
    runModelLine(run.modelIds, run.provider) ??
    runModelLine(run.trace.map((s) => s.modelId ?? ""), run.provider) ??
    runModelLine(usageIds, run.provider);
  if (m) parts.push(m);
  if (run.judgeOverall !== null) parts.push(`Judge ${run.judgeOverall.toFixed(2)}`);
  return parts.join(" · ");
}

function Collapsible({ line, children }: { line: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="agp stp" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="stp-summary-line">
        <span>{line}</span> <span className="stp-toggle">{open ? "hide steps" : "show steps"}</span>
      </summary>
      {children}
    </details>
  );
}

/**
 * The agent pipeline for one finished run as a compact stepper. `collapsed` (the Ask chat default) folds the whole
 * pipeline into a one-line summary; otherwise it shows one line per agent with details on click.
 */
export function AgentPipeline({
  run,
  collapsed = true,
  title,
}: {
  run: RecordedRun;
  /** Back-compat: the Ask chat passed `compact`. */
  compact?: boolean;
  collapsed?: boolean;
  title?: string;
}) {
  const model = buildPipeline(run);
  const rows: StepRow[] = model.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    state: node.status,
    durationMs: node.latencyMs,
    chip: node.status === "skipped" || node.id === "approval" ? null : modelChip(node.modelId, node.lane, node.provider ?? run.provider ?? null),
    summary: node.summary,
    runs: node.runs,
    badges: node.badges.filter((b) => b.kind !== "world"),
    loop:
      node.id === "skeptic" && model.reviseRounds > 0
        ? `revise ×${model.reviseRounds}`
        : node.id === "judge" && model.repairRounds > 0
          ? `repair ×${model.repairRounds}`
          : null,
  }));
  const body = (
    <>
      <StepList rows={rows} />
      <EscalationLine summary={escalationOf(run)} />
      <LoopChips revise={model.reviseRounds} repair={model.repairRounds} />
      <BoardChips board={model.board} />
    </>
  );
  const label = title ?? "Agent pipeline";
  if (collapsed) {
    return (
      <Collapsible key={run.runId} line={pipelineSummary(run)}>
        {body}
      </Collapsible>
    );
  }
  return (
    <section className="agp stp" aria-label={label} key={run.runId}>
      <header className="agp-head">
        <p className="agp-title">{label}</p>
        <p className="agp-meta">{pipelineSummary(run)}</p>
      </header>
      {body}
    </section>
  );
}

/** The same stepper while a run streams: each agent lights up on `started`, then shows ✓, duration and model chip. */
export function LiveAgentPipeline({ state, collapsed = false }: { state: LiveRunState; collapsed?: boolean }) {
  const rows: StepRow[] = state.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    state: node.state,
    durationMs: node.runs > 0 ? node.durationMs : null,
    chip: node.runs > 0 && node.id !== "approval" ? modelChip(node.modelId, node.lane) : null,
    summary: node.summary,
    runs: node.runs,
    badges: [],
    loop:
      node.id === "skeptic" && state.reviseRounds > 0
        ? `revise ×${state.reviseRounds}`
        : node.id === "judge" && state.repairRounds > 0
          ? `repair ×${state.repairRounds}`
          : null,
  }));
  const done = state.nodes.filter((n) => n.state === "done").length;
  const body = (
    <>
      <StepList rows={rows} />
      <EscalationLine summary={state.escalated} />
      <LoopChips revise={state.reviseRounds} repair={state.repairRounds} />
    </>
  );
  if (collapsed) {
    return (
      <Collapsible line={`${done} of ${state.nodes.length} agents finished · run ${state.runId}`}>
        {body}
      </Collapsible>
    );
  }
  return (
    <section className="agp stp agp-live" aria-label="Live agent pipeline">
      <header className="agp-head">
        <p className="agp-title">Agents working</p>
        <p className="agp-meta">
          {done} of {state.nodes.length} done · run {state.runId}
        </p>
      </header>
      {body}
    </section>
  );
}
