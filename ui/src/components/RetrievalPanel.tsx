import { useMemo, type CSSProperties } from "react";
import type { RecordedRun } from "../api/replay";
import { useConsole } from "../context/ConsoleContext";
import { numberRunReferences, refById } from "../lib/references";
import { buildRetrieval } from "../lib/retrieval";
import { RefMarks } from "./RefMarks";
import { plainLanguage } from "../lib/plain";

/**
 * Layer (c) retrieval: query → passages → Zetaris query id → Judge verdict per claim. Nothing when no layer (c).
 * Every passage carries its [n] and an anchor; the [n] after each claim sentence opens that passage in the drawer.
 */
export function RetrievalPanel({ run, scope }: { run: RecordedRun; scope?: string }) {
  const { openSource } = useConsole();
  const model = buildRetrieval(run);
  const refs = useMemo(
    () => numberRunReferences(run.claims, { scope: scope ?? `rag-${run.runId}`, eventId: run.eventId, layers: ["c"] }),
    [run.claims, run.runId, run.eventId, scope],
  );
  if (!model.groups.length) return null;
  return (
    <section className="rag" aria-label="Document retrieval">
      <header className="rag-head">
        <p className="agp-title">Document retrieval (layer c)</p>
        <p className="agp-meta">
          <span className="agp-badge agp-badge-rag">pgvector + Zetaris JDBC</span> {model.passageCount} passage
          {model.passageCount === 1 ? "" : "s"}
        </p>
      </header>
      {model.query && (
        <p className="rag-query">
          <span className="rag-k">Query</span> “{model.query}”
        </p>
      )}
      {model.groups.map((g) => {
        const nums = refs.claims.find((c) => c.id === g.claimId)?.refs ?? [];
        return (
          <div key={g.claimId} className={`rag-group${g.flagged ? " rag-flagged" : ""}`}>
            <p className="rag-claim">
              <span className="rag-k">{g.claimId}</span> {plainLanguage(g.claimText)} <RefMarks nums={nums} refs={refs.refs} />
            </p>
            <ol className="rag-passages">
              {g.passages.map((p, i) => {
                const ref = refById(refs, p.id);
                return (
                  <li key={p.id} id={ref?.anchor} className="rag-passage" style={{ "--i": i } as CSSProperties}>
                    <p className="rag-title">
                      {ref ? (
                        <button type="button" className="ref-mark ref-mark--document" onClick={() => openSource(ref)} aria-label={`Open source ${ref.n}: ${p.title}`}>
                          [{ref.n}]
                        </button>
                      ) : (
                        `${i + 1}.`
                      )}{" "}
                      {p.title}
                      {p.page !== null && <span className="rag-page"> · p. {p.page}</span>}
                    </p>
                    <p className="rag-src">
                      {p.publisher ?? "Unknown publisher"}
                      {p.licence ? ` · ${p.licence}` : ""}
                    </p>
                    {p.quote ? <blockquote className="rag-quote">“{p.quote}”</blockquote> : <p className="rag-src">Map page, no text quote.</p>}
                    {p.attribution && <p className="rag-attr">{p.attribution}</p>}
                  </li>
                );
              })}
            </ol>
            <p className="rag-foot">
              {g.queryIds.length > 0 ? (
                <>
                  Hydrated by Zetaris query <code>{g.queryIds.join(", ")}</code>
                </>
              ) : (
                "No Zetaris query id recorded for these passages."
              )}
            </p>
            <p className={`rag-verdict${g.flagged ? " rag-verdict-flag" : ""}`}>
              {g.flagged && <strong>Flagged by Judge · </strong>}
              {g.verdict ? (
                <>
                  Judge: {g.verdict.grounding ?? "no grounding"}
                  {g.verdict.score !== null ? ` · score ${g.verdict.score.toFixed(2)}` : ""}
                  {g.verdict.rationale ? ` · ${g.verdict.rationale}` : ""}
                  {g.verdict.modelId ? ` (${g.verdict.modelId})` : ""}
                </>
              ) : (
                "No per-claim Judge verdict in this run."
              )}
            </p>
          </div>
        );
      })}
    </section>
  );
}
