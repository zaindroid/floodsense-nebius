import { LatestRunTechTrace, TechTrace } from "./TechTrace";
import { useEffect, useState } from "react";
import { runBadge } from "../api/ask";
import { fetchPastRuns } from "../api/pastRuns";
import { useConsole } from "../context/ConsoleContext";
import { completedFullRuns, eventLabel, preferJudgePass } from "../lib/approvalQueue";
import { adoptRunBody, fetchRecordedRun, replayRunId, type RecordedRun } from "../api/replay";
import sampleRun from "../fixtures/run_f16733274f1c.json";
import { AgentPipeline } from "./AgentPipeline";
import { RetrievalPanel } from "./RetrievalPanel";
import { ReviewColumn } from "./ReviewColumn";
import { plainLanguage } from "../lib/plain";
import { routeHref } from "../lib/route";

export const SAMPLE_RUN_ID = "f16733274f1c";

/** The bundled recorded run (f16733274f1c, one revise and one repair round). Always a replay. */
export function sampleRecordedRun(): RecordedRun | null {
  return adoptRunBody(sampleRun as unknown as Record<string, unknown>, SAMPLE_RUN_ID);
}

export type Source = { kind: "bundled" } | { kind: "newest"; id: string; label: string; question: string | null } | { kind: "none"; label: string } | { kind: "configured"; id: string } | { kind: "failed"; id: string } | { kind: "loading"; id: string };

/** Pure: the note under the header for where the run came from. Null for a configured run that loaded. */
export function causalChainNote(source: Source): string | null {
  switch (source.kind) {
    case "newest":
      return `Newest completed full run for ${source.label}${source.question ? `: “${source.question}”` : ""} (${source.id}).`;
    case "none":
      return `No completed full-lane run for ${source.label} yet. Showing the bundled recording of run ${SAMPLE_RUN_ID} instead, a Valencia 2024 example. Not live.`;
    case "bundled":
      return `Bundled recording of run ${SAMPLE_RUN_ID}, shipped with the UI. Not this session's run, not live.`;
    case "failed":
      return `Could not load recorded run ${source.id} (VITE_REPLAY_RUN_ID). Showing the bundled recording of run ${SAMPLE_RUN_ID} instead. Not live.`;
    case "loading":
      return `Loading recorded run ${source.id}… showing the bundled recording of run ${SAMPLE_RUN_ID} until then.`;
    case "configured":
      return null;
  }
}

/**
 * The reviewed run: VITE_REPLAY_RUN_ID wins; else the newest completed full-lane run for the current mode's event
 * (GET /runs/past); else the bundled recording of run f16733274f1c, said so.
 */
export function useReviewRun(): { run: RecordedRun | null; source: Source } {
  const { mode, eventId } = useConsole();
  const [run, setRun] = useState<RecordedRun | null>(() => sampleRecordedRun());
  const [source, setSource] = useState<Source>(() => {
    const id = replayRunId();
    return id ? { kind: "loading", id } : { kind: "bundled" };
  });
  useEffect(() => {
    const controller = new AbortController();
    const configured = replayRunId();
    const label = mode === "past" ? eventLabel(eventId) : "live data";
    setRun(sampleRecordedRun());
    if (configured) {
      setSource({ kind: "loading", id: configured });
      void fetchRecordedRun(configured, undefined, controller.signal).then((r) => {
        if (controller.signal.aborted) return;
        if (r) {
          setRun(r);
          setSource({ kind: "configured", id: configured });
        } else setSource({ kind: "failed", id: configured });
      });
      return () => controller.abort();
    }
    setSource({ kind: "none", label });
    void fetchPastRuns(50, controller.signal).then(async (list) => {
      if (controller.signal.aborted || !list.ok) return;
      // The newest run that passed the Judge (looking at the latest few); else the newest. The row list carries no verdict.
      const candidates = completedFullRuns(list.rows, mode, eventId).slice(0, 6);
      const loaded: Record<string, RecordedRun> = {};
      const verdicts: Record<string, boolean | null> = {};
      for (const c of candidates) {
        const r = await fetchRecordedRun(c.runId, undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (!r) continue;
        loaded[c.runId] = r;
        verdicts[c.runId] = r.judgePasses;
        if (r.judgePasses === true) break;
      }
      const row = preferJudgePass(candidates.filter((c) => loaded[c.runId]), verdicts);
      if (!row) return;
      setRun(loaded[row.runId]);
      setSource({ kind: "newest", id: row.runId, label, question: row.question });
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
      <details className="disclosure">
        <summary>Document retrieval and Judge verdicts</summary>
        <RetrievalPanel run={run} />
      </details>
    </section>
  );
}
