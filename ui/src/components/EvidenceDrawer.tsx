import { useEffect, useRef } from "react";
import { SafeLink } from "./SafeLink";
import { LiveEvidenceView } from "./LiveSources";
import { useConsole } from "../context/ConsoleContext";
import { useDismiss } from "../hooks/useDismiss";
import { numberedCitations, retrievedAt, WEB_LABEL, webCitations } from "../lib/citations";
import { drawerFields, type Reference } from "../lib/references";
import { formatCell, formatDay } from "../lib/format";
import { glofasDischargeNote, pointById, provenanceForSource, rowAt, sourceExplanation } from "../lib/series";
import type { Answer, Evidence } from "../types/contract";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const PREFERRED = [
  "point_id",
  "date",
  "ts_utc",
  "discharge_m3s",
  "rain_mm",
  "warning_level",
  "source",
  "policy_id",
  "site_id",
  "in_footprint",
  "sum_insured_eur",
  "segment",
  "dataset",
  "publisher",
  "licence",
];

function columnOrder(rows: Record<string, unknown>[]): string[] {
  const present = new Set(rows.flatMap((row) => Object.keys(row)));
  const first = PREFERRED.filter((key) => present.has(key));
  const rest = [...present].filter((key) => !first.includes(key));
  return [...first, ...rest];
}

function SampleTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return <p className="note">No sample rows.</p>;
  const keys = columnOrder(rows);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {keys.map((key) => (
              <th key={key}>{key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {keys.map((key) => (
                <td key={key}>{formatCell(row[key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvidenceBlock({ evidence }: { evidence: Evidence }) {
  return (
    <article className="evidence-block">
      <h3>{evidence.view}</h3>
      <dl className="kv">
        <div>
          <dt>query_id</dt>
          <dd>{evidence.query_id}</dd>
        </div>
        <div>
          <dt>row_count</dt>
          <dd>{evidence.row_count}</dd>
        </div>
        <div>
          <dt>executed_at_utc</dt>
          <dd>{evidence.executed_at_utc}</dd>
        </div>
      </dl>
      <p className="note">Fixture SQL, not sent to Zetaris from this screen. query_id is a fixture id.</p>
      <pre className="sql">{evidence.sql}</pre>
      <SampleTable rows={evidence.rows_sample} />
    </article>
  );
}

export function EvidenceDrawer() {
  const desk = useConsole();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const point = pointById(desk.points, desk.pointId);
  const row = rowAt(desk.discharge.rows, desk.pointId, desk.date);
  const dischargeProvenance = row ? provenanceForSource(row.source, desk.provenance.rows) : undefined;
  const modelled = row ? glofasDischargeNote(row.source) : null;
  const rainProvenance = provenanceForSource("open-meteo-rain", desk.provenance.rows);
  useDismiss(desk.evidenceOpen, desk.closeEvidence, panelRef);

  useEffect(() => {
    if (!desk.evidenceOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const root = panelRef.current;
    const onKey = (event: KeyboardEvent) => {
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
  }, [desk.evidenceOpen]);

  useEffect(() => {
    if (!desk.evidenceOpen || desk.evidenceSource || desk.liveEvidence) return;
    const target = document.getElementById(desk.evidenceTopic === "rain" ? "why-rain" : "why-discharge");
    target?.scrollIntoView({ block: "start" });
  }, [desk.evidenceOpen, desk.evidenceTopic, desk.evidenceSource, desk.liveEvidence]);

  if (!desk.evidenceOpen) return null;

  return (
    <div className="drawer-backdrop">
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-title" ref={panelRef}>
        <div className="drawer-head">
          <div>
            <p className="section-label">Evidence</p>
            <h2 id="evidence-title">{desk.evidenceSource ? `Source [${desk.evidenceSource.n}]` : desk.liveEvidence ? "Where this comes from" : "Why this source"}</h2>
          </div>
          <button ref={closeRef} type="button" className="button" onClick={desk.closeEvidence}>
            Close
          </button>
        </div>
        {desk.evidenceSource ? (
          <div className="drawer-body">
            <ReferenceDetail source={desk.evidenceSource} />
          </div>
        ) : desk.liveEvidence ? (
          <div className="drawer-body">
            <LiveEvidenceView evidence={desk.liveEvidence} />
          </div>
        ) : (
        <div className="drawer-body">
          <section id="why-discharge">
            <h3>discharge_daily.source</h3>
            {row ? (
              <>
                <p>
                  {point ? `${point.name} (${row.point_id})` : row.point_id} on {formatDay(row.date)}.{" "}
                  {sourceExplanation(row.source, desk.discharge.origin)}
                  {modelled ? ` ${modelled}` : ""}
                </p>
                <dl className="kv">
                  <div>
                    <dt>source</dt>
                    <dd>{row.source}</dd>
                  </div>
                  <div>
                    <dt>discharge_m3s</dt>
                    <dd>{row.discharge_m3s}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="note">No discharge row is selected.</p>
            )}
            {dischargeProvenance ? (
              <ProvenanceList row={dischargeProvenance} />
            ) : (
              <p className="note">No provenance row matched this source value.</p>
            )}
          </section>
          <section id="why-rain">
            <h3>Rain and warning_level</h3>
            <p>
              Hourly rain is hazard_timeline, joined to that day’s discharge. warning_level is null in the loaded
              hazard rows until another source fills it. This screen does not invent that column.
            </p>
            {rainProvenance ? (
              <ProvenanceList row={rainProvenance} />
            ) : (
              <p className="note">No rain provenance row in the loaded set.</p>
            )}
          </section>
          <section>
            <h3>Answer evidence</h3>
            <p className="note">
              These blocks follow the shared evidence contract. They were packed with the fixture answer.
            </p>
            {desk.answer.evidence.map((evidence) => (
              <EvidenceBlock key={evidence.query_id} evidence={evidence} />
            ))}
          </section>
          <section>
            <h3>Citations</h3>
            <CitationList answer={desk.answer} />
          </section>
          <WebCitations answer={desk.answer} />
          <section>
            <h3>provenance view</h3>
            <p className="note">
              Columns are dataset, source_url, publisher, licence, attribution, fetched_at. fetched_at is the prep
              accessed_at cast to midnight UTC. This console does not call the feeds. Listing a dataset does not
              assign an owner.
            </p>
            {desk.provenance.rows.map((item) => (
              <article key={item.dataset} className="evidence-block">
                <h3>{item.dataset}</h3>
                <ProvenanceList row={item} />
              </article>
            ))}
          </section>
        </div>
        )}
      </aside>
    </div>
  );
}

/** One numbered reference in full: what it is, where it is, the quote, and a real link. */
export function ReferenceDetail({ source }: { source: Reference }) {
  return (
    <section className={`ref-detail ref-detail--${source.kind}`} aria-label={`Source ${source.n}`}>
      <p className="section-label">{source.heading}</p>
      <h3>{source.title}</h3>
      <dl className="kv">
        {drawerFields(source).map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      {source.quote ? <blockquote className="ref-quote">“{source.quote}”</blockquote> : <p className="note">No text quote for this source.</p>}
      {source.attribution && <p className="note">{source.attribution}</p>}
      {source.link ? (
        <p>
          <SafeLink href={source.link.href}>{source.link.label} ↗</SafeLink>
        </p>
      ) : (
        <p className="note">No source link was recorded for this citation.</p>
      )}
    </section>
  );
}

/** Numbered in the answer's order, so [n] marks on a page match this list. */
export function CitationList({ answer }: { answer: Answer }) {
  return (
    <ol className="citation-list">
      {numberedCitations(answer).map(({ n, citation }) => (
        <li key={citation.citation_id}>
          <p className="menu-title">
            [{n}] Layer {citation.layer} · {citation.title}
          </p>
          <p className="menu-body">{citation.quote}</p>
          <p className="note">
            {citation.publisher} · {citation.licence}
            <br />
            {citation.attribution}
          </p>
          <p className="note">
            <SafeLink href={citation.source_url}>{citation.source_url}</SafeLink>
          </p>
        </li>
      ))}
    </ol>
  );
}

/** Tavily web snippets, if the run used them. Context only, never styled as a warning. */
export function WebCitations({ answer }: { answer: Answer }) {
  const items = webCitations(answer);
  if (items.length === 0) return null;
  return (
    <section aria-label="Web citations">
      <h3>Web citations</h3>
      <p className="note">{WEB_LABEL}.</p>
      <ul className="citation-list">
        {items.map(({ n, citation }) => (
          <li key={citation.citation_id}>
            <p className="menu-title">
              [{n}] {citation.title}
            </p>
            <p className="note">
              <SafeLink href={citation.source_url}>{citation.source_url}</SafeLink>
              {retrievedAt(citation) ? ` · retrieved ${retrievedAt(citation)}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ProvenanceList({
  row,
}: {
  row: {
    dataset: string;
    source_url: string;
    publisher: string;
    licence: string;
    attribution: string;
    fetched_at: string;
  };
}) {
  return (
    <dl className="kv">
      <div>
        <dt>dataset</dt>
        <dd>{row.dataset}</dd>
      </div>
      <div>
        <dt>publisher</dt>
        <dd>{row.publisher}</dd>
      </div>
      <div>
        <dt>licence</dt>
        <dd>{row.licence}</dd>
      </div>
      <div>
        <dt>attribution</dt>
        <dd>{row.attribution}</dd>
      </div>
      <div>
        <dt>source_url</dt>
        <dd>
          <SafeLink href={row.source_url}>{row.source_url}</SafeLink>
        </dd>
      </div>
      <div>
        <dt>fetched_at</dt>
        <dd>{row.fetched_at}</dd>
      </div>
    </dl>
  );
}
