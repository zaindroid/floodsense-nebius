import { useId, useState } from "react";
import { SafeLink } from "./SafeLink";
import { SOURCE_LEGEND, type SourceDetail } from "../lib/sources";

export interface NumberedSource {
  n: number;
  detail: SourceDetail;
}

/**
 * Numbered source badges after one sentence. Each badge opens that source's evidence inline, under the
 * sentence (no popover, so nothing overflows at 375 px): view and query id for Zetaris data, title,
 * publisher, page and quote for a document, and a real link to the upstream source.
 */
export function SourceBadges({ items }: { items: NumberedSource[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const baseId = useId();
  if (items.length === 0) return <span className="uncited">uncited</span>;
  const shown = items.find((item) => item.n === open) ?? null;
  return (
    <>
      <span className="citation-markers">
        {items.map((item) => (
          <button
            key={item.n}
            type="button"
            className={`citation-marker src-badge src-badge-${item.detail.kind}`}
            aria-expanded={open === item.n}
            aria-controls={open === item.n ? `${baseId}-${item.n}` : undefined}
            aria-label={`Source ${item.n}: ${item.detail.heading}, ${item.detail.title}`}
            title={`${item.detail.heading} · ${item.detail.title}`}
            onClick={() => setOpen((cur) => (cur === item.n ? null : item.n))}
          >
            {item.n}
          </button>
        ))}
      </span>
      {shown && <SourceCard id={`${baseId}-${shown.n}`} n={shown.n} detail={shown.detail} />}
    </>
  );
}

export function SourceCard({ id, n, detail }: { id?: string; n?: number; detail: SourceDetail }) {
  return (
    <span className={`src-card src-card-${detail.kind}`} id={id} role="note">
      <span className="src-card-head">
        {n !== undefined && <span className="src-card-n">[{n}]</span>} <strong>{detail.heading}</strong>
      </span>
      <span className="src-card-title">{detail.title}</span>
      {detail.facts.length > 0 && <span className="src-card-facts">{detail.facts.join(" · ")}</span>}
      {detail.quote && <span className="src-card-quote">“{detail.quote}”</span>}
      {detail.link && (
        <span className="src-card-link">
          <SafeLink href={detail.link.href}>{detail.link.label} ↗</SafeLink>
        </span>
      )}
    </span>
  );
}

export function SourceLegend() {
  return <p className="src-legend note">{SOURCE_LEGEND}</p>;
}
