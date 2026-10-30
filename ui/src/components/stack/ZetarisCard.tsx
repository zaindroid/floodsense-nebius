import type { DataKind, ViewRead } from "../../lib/stack";
import { Empty, StackCard } from "./StackBits";

const SOURCES = ["PEGELONLINE", "Open-Meteo", "Copernicus EMS", "Seed CSVs"] as const;

export function ZetarisCard({ reads, kind, runId }: { reads: ViewRead[]; kind: DataKind; runId: string | null }) {
  const lit = new Set(reads.map((r) => r.source));
  const queryCount = new Set(reads.map((r) => r.queryId)).size;
  return (
    <StackCard
      id="stk-zetaris"
      title="Zetaris"
      role="The only SQL path to data. Agents never call a source directly; they query a Zetaris view and cite its query id."
      kind={reads.length ? kind : "none"}
    >
      <div className="stk-zflow" aria-hidden="true">
        <span className="stk-node">Agents</span>
        <span className={`stk-wire stk-wire--v${reads.length ? " stk-wire--on" : ""}`}>
          <i />
          <i />
        </span>
        <span className={`stk-node stk-node--zet${reads.length ? " is-lit" : ""}`}>Zetaris SQL</span>
        <span className={`stk-wire stk-wire--v${reads.length ? " stk-wire--on" : ""}`}>
          <i />
          <i />
        </span>
        <span className="stk-srcs">
          {SOURCES.map((s) => (
            <span key={s} className={`stk-node stk-node--src${lit.has(s) ? " is-lit" : ""}`}>
              {s}
            </span>
          ))}
        </span>
      </div>
      {reads.length === 0 ? (
        <Empty>The shown run recorded no Zetaris queries.</Empty>
      ) : (
        <>
          <p className="stk-note">
            {queryCount} {queryCount === 1 ? "query" : "queries"} in run {runId ?? "n/a"}. Highlighted sources are the ones behind these views.
          </p>
          <div className="stk-table-wrap">
            <table className="stk-table">
              <thead>
                <tr>
                  <th scope="col">View</th>
                  <th scope="col">Rows</th>
                  <th scope="col">Query id</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {reads.map((r) => (
                  <tr key={r.queryId}>
                    <td className="stk-mono">{r.view}</td>
                    <td>{r.failed ? "failed" : r.rows ?? "n/a"}</td>
                    <td className="stk-mono">{r.queryId}</td>
                    <td>{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </StackCard>
  );
}
