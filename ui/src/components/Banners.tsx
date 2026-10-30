import { servingLabel, servingQualifier } from "../lib/format";
import { statusLabel } from "../lib/origin";
import { useConsole } from "../context/ConsoleContext";
import type { ProvenanceRow } from "../types/views";

/**
 * Answer serving line (ADR 0006: cached or replayed output is always labelled). It was the cache banner.
 * `inline` puts it above the answer on Approvals and Review, announced as a status. The chip menu repeats it.
 */
export function ServingLine({ inline = false }: { inline?: boolean }) {
  const { answer } = useConsole();
  const serving = servingLabel(answer);
  return (
    <p
      className={`serving serving-${serving.kind}${inline ? " serving-inline" : ""}`}
      data-serving={serving.servedFrom}
      role={inline ? "status" : undefined}
      title={`Original run ${serving.runId}`}
    >
      <strong>{serving.kind === "cached" ? `${serving.text} UTC` : serving.text}</strong>
      <span>
        {" "}
        · {servingQualifier(serving)}
        {serving.kind === "live" ? "" : " · not live"}
      </span>
    </p>
  );
}

/** Origin of each view. It was the origin banner. It now sits under the top-bar chip and on Portfolio. */
export function OriginList() {
  const desk = useConsole();
  const parts = [
    ["discharge_daily", desk.discharge],
    ["hazard_timeline", desk.hazard],
    ["exposure_join", desk.exposure],
    ["provenance", desk.provenance],
  ] as const;
  return (
    <div className="origin-list" data-origin={parts.map(([, slice]) => slice.origin).join(" ")}>
      <dl className="kv">
        {parts.map(([name, slice]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              {statusLabel(slice.origin)} · {slice.detail}
            </dd>
          </div>
        ))}
      </dl>
      <p className="note">{desk.healthDetail}</p>
    </div>
  );
}

function pick(rows: ProvenanceRow[], test: (dataset: string) => boolean): ProvenanceRow | undefined {
  return rows.find((row) => test(row.dataset.toLowerCase()));
}

export function Colophon() {
  const { provenance, route } = useConsole();
  const rows = provenance.rows;
  const chosen = [
    pick(rows, (name) => name.includes("glofas") || name.includes("open-meteo flood")),
    pick(rows, (name) => name.includes("emsr773")),
    pick(rows, (name) => name.includes("osm")),
    pick(rows, (name) => name.includes("synthetic")),
  ].filter((row): row is ProvenanceRow => Boolean(row));
  return (
    <footer className="colophon">
      <details>
        <summary>Sources and licences</summary>
      {chosen.map((row) => (
        <p key={row.dataset}>
          {row.attribution} ({row.licence})
        </p>
      ))}
      <p>Portfolio rows are synthetic. Modelled discharge is not an official warning.</p>
      <p>River gauges: PEGELONLINE (WSV), DL-DE-Zero-2.0, served through Zetaris. Map tiles: OpenStreetMap contributors (ODbL).</p>
      </details>
      {route === "citizen" && (
        <p>
          <a href="#/citizen/tower">How we watch</a>: the rule-based watch loop and what it found, read-only.
        </p>
      )}
    </footer>
  );
}
