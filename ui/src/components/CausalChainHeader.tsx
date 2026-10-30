import { LatestRunTechTrace, TechTrace } from "./TechTrace";
import { useEffect, useState } from "react";
import { runBadge } from "../api/ask";
import { fetchPastRuns } from "../api/pastRuns";
import { useConsole } from "../context/ConsoleContext";
import { completedFullRuns, eventLabel, type QueueRow } from "../lib/approvalQueue";
import { adoptRunBody, fetchRecordedRun, replayRunId, type RecordedRun } from "../api/replay";
import sampleRun from "../fixtures/run_f16733274f1c.json";
import { AgentPipeline } from "./AgentPipeline";
import { RetrievalPanel } from "./RetrievalPanel";
import { ReviewColumn } from "./ReviewColumn";
import { RunWalkthrough } from "./RunWalkthrough";
import { plainLanguage } from "../lib/plain";
import { routeHref } from "../lib/route";

/** Id of the bundled recording (fixtures/run_f16733274f1c.json). The API may list the same id; Review never picks it as a "real" run. */
export const SAMPLE_RUN_ID = "f16733274f1c";

/** The bundled recorded run (f16733274f1c, one revise and one repair round). Always a replay. */
export function sampleRecordedRun(): RecordedRun | null {
  return adoptRunBody(sampleRun as unknown as Record<string, unknown>, SAMPLE_RUN_ID);
}

export type Source = { kind: "bundled" } | { kind: "newest"; id: string; label: string; question: string | null } | { kind: "none"; label: string } | { kind: "looking"; label: string } | { kind: "configured"; id: string } | { kind: "failed"; id: string } | { kind: "loading"; id: string };

/** Pure: the note under the header for where the run came from. Null for a configured run that loaded. */
export function causalChainNote(source: Source): string | null {
  switch (source.kind) {
    case "newest":
      return `Newest completed full run for ${source.label}${source.question ? `: “${source.question}”` : ""} (${source.id}).`;
    case "looking":
      return `Looking for the newest completed full run for ${source.label}…`;
    case "none":
      return `Sample, not a real run: No completed full-lane run for ${source.label} yet. Showing the bundled recording of run ${SAMPLE_RUN_ID} instead, a Valencia 2024 example. Not live.`;
    case "bundled":
      return `Bundled recording of run ${SAMPLE_RUN_ID}, shipped with the UI. Not this session's run, not live.`;
    case "failed":
      return `Could not load run ${source.id}. Showing the bundled recording of run ${SAMPLE_RUN_ID} instead, a sample and not a real run. Not live.`;
    case "loading":
      return `Loading recorded run ${source.id}… showing the bundled recording of run ${SAMPLE_RUN_ID} until then.`;
    case "configured":
      return `Pinned recording ${source.id} (VITE_REPLAY_RUN_ID), shown because no completed full run exists yet. Not live.`;
  }
}

/** Pure: the first of the newest candidates that loads. `failedId` is set when candidates existed but none loaded (never a silent fallback). */
export async function loadNewestRun(
  rows: readonly QueueRow[],
  mode: "live" | "past",
  eventId: string,
  fetchRun: (runId: string) => Promise<RecordedRun | null>,
  isAborted: () => boolean = () => false,
): Promise<{ run: RecordedRun; row: QueueRow } | { run: null; failedId: string | null }> {
  const candidates = completedFullRuns(rows, mode, eventId, SAMPLE_RUN_ID).slice(0, 3);
  for (const row of candidates) {
    const run = await fetchRun(row.runId);
    if (isAborted()) break;
    if (run) return { run, row };
  }
  return { run: null, failedId: candidates[0]?.runId ?? null };
}

/**
 * The reviewed run: the newest completed full-lane run for the current mode (GET /runs/past). VITE_REPLAY_RUN_ID is only
 * the fallback when no real run exists (it used to override the newest run, which pinned an old recording); then the
 * bundled recording. Every fallback is labelled.
 */
export function useReviewRun(): { run: RecordedRun | null; source: Source } {
  const { mode, eventId } = useConsole();
  const lookLabel = () => (mode === "past" ? eventLabel(eventId) : "live data");
  // No sample while the newest real run is being looked up: it would be shown as if it were the answer.
  const [run, setRun] = useState<RecordedRun | null>(null);
  const [source, setSource] = useState<Source>(() => ({ kind: "looking", label: lookLabel() }));
  useEffect(() => {
    const controller = new AbortController();
    const label = lookLabel();
    setRun(null);
    setSource({ kind: "looking", label });
    const fallback = async (failedId: string | null) => {
      const configured = replayRunId();
      const r = configured ? await fetchRecordedRun(configured, undefined, controller.signal) : null;
      if (controller.signal.aborted) return;
      if (r && configured) {
        setRun(r);
        setSource({ kind: "configured", id: configured });
      } else {
        setRun(sampleRecordedRun());
        setSource(failedId ? { kind: "failed", id: failedId } : { kind: "none", label });
      }
    };
    void fetchPastRuns(50, controller.signal).then(async (list) => {
      if (controller.signal.aborted) return;
      if (!list.ok) return fallback(null);
      const got = await loadNewestRun(list.rows, mode, eventId, (id) => fetchRecordedRun(id, undefined, controller.signal), () => controller.signal.aborted);
      if (controller.signal.aborted) return;
      if (!got.run) return fallback(got.failedId);
      setRun(got.run);
      setSource({ kind: "newest", id: got.row.runId, label, question: got.row.question });
    });
    return () => controller.abort();
  }, [mode, eventId]);
  return { run, source };
}

/** Insurer Review: one run, top to bottom. A real run shows its own graph and answer; the bundled recording shows the example below it. */
export function ReviewPage() {
  const { run, source } = useReviewRun();
  const real = source.kind === "newest" || source.kind === "configured";
  const { mode, eventId } = useConsole();
  if (source.kind === "looking")
    return (
      <div className="page-stack">
        <p className="note" role="status">{causalChainNote(source)}</p>
      </div>
    );
  return (
    <div className="page-stack">
      {run && real ? <TechTrace run={run} /> : <LatestRunTechTrace mode={mode} eventId={eventId} />}
      <CausalChainHeader run={run} source={source} />
      {run && real ? (
        <RunReviewSummary run={run} />
      ) : (
        <>
          <p className="note">The answer, Skeptic and Judge below are the bundled Valencia 2024 example, the same recording as the graph above.</p>
          <ReviewColumn />
        </>
      )}
    </div>
  );
}

/** The selected run's own answer: its claims with the Judge's grounding per claim, and the decision link. */
function RunReviewSummary({ run }: { run: RecordedRun }) {
  const judgeFor = (id: string) => run.judgeClaims?.find((j) => j.claimId === id);
  return (
    <section className="card review" aria-label="Reviewed answer">
      <div className="card-head">
        <div>
          <p className="section-label">Reviewed answer · run {run.runId}</p>
          <h2>{run.question ?? run.label}</h2>
        </div>
      </div>
      <p className="status-line">
        Judge {run.judgeOverall !== null ? run.judgeOverall.toFixed(2) : "not scored"}
        {run.judgePasses === null ? "" : run.judgePasses ? " · passes" : " · does not pass"} ·{" "}
        <a href={routeHref("insurer", "approvals")}>Decide on Approvals</a>
      </p>
      {run.claims.length === 0 ? (
        <p className="note">This run states no claims.</p>
      ) : (
        <ol className="claims">
          {run.claims.map((claim) => {
            const j = judgeFor(claim.id);
            return (
              <li key={claim.id}>
                {plainLanguage(claim.text)}
                <span className="note">
                  {" "}
                  {claim.citations.length} {claim.citations.length === 1 ? "source" : "sources"}
                  {j?.grounding ? ` · ${j.grounding}` : ""}
                  {j?.score !== null && j?.score !== undefined ? ` · ${j.score.toFixed(2)}` : ""}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="note">Open the Judge verdicts and retrieved documents under the graph above. Nothing here is sent.</p>
    </section>
  );
}

export function CausalChainHeader({ run, source }: { run: RecordedRun | null; source: Source }) {
  const [walking, setWalking] = useState(false);
  if (!run) return null;
  const kind = run.servedFrom === "live" ? "live" : run.servedFrom === "cache" ? "cached" : "replay";
  const note = causalChainNote(source);
  return (
    <section className="card agp-card" aria-label="Causal chain">
      <div className="stp-card-head">
        <p className="section-label">Causal chain</p>
        <span className={`stp-run-label stp-run-${kind}`}>
          {run.servedFrom === "live" ? runBadge(run) : source.kind === "newest" ? `Past run · ${run.runId}` : `Recorded run · not live · ${run.runId}`}
        </span>
      </div>
      {note && (
        <p className={`note agp-source-note${source.kind === "failed" ? " is-failed" : ""}`} role="note">
          {note}
        </p>
      )}
      <AgentPipeline run={run} collapsed={false} title="How the agents reached this answer" />
      <div className="wt-open">
        <button type="button" className="button primary" onClick={() => setWalking(true)}>
          Walk through this run
        </button>
        <p className="note">
          {run.trace.length} recorded steps in the order they happened: the hypotheses, the loops back, the Judge, the
          human gate.
        </p>
      </div>
      {walking && <RunWalkthrough run={run} onClose={() => setWalking(false)} />}
      <details className="disclosure">
        <summary>Document retrieval and Judge verdicts</summary>
        <RetrievalPanel run={run} />
      </details>
    </section>
  );
}
