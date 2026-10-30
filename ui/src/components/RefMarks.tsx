import { useConsole } from "../context/ConsoleContext";
import type { Reference } from "../lib/references";
import "../styles/insurer.css";

/**
 * Inline numbered references after a claim sentence: [1] [2]. Each opens the Evidence drawer with that source in
 * full (document: title, publisher, page, quote, link, hydration query id; data: view, query id, upstream link).
 */
export function RefMarks({ nums, refs }: { nums: readonly number[]; refs: readonly Reference[] }) {
  const { openSource } = useConsole();
  if (nums.length === 0) return <span className="ref-none">uncited</span>;
  return (
    <span className="ref-marks">
      {nums.map((n) => {
        const ref = refs.find((r) => r.n === n);
        if (!ref) return null;
        return (
          <button
            key={n}
            type="button"
            className={`ref-mark ref-mark--${ref.kind}`}
            aria-label={`Source ${n}: ${ref.heading}, ${ref.title}`}
            title={`${ref.heading} · ${ref.title}`}
            onClick={() => openSource(ref)}
          >
            [{n}]
          </button>
        );
      })}
    </span>
  );
}

/** The numbered source list under a block, each item with its anchor id so a [n] has a place on the page. */
export function RefList({ refs, label = "References" }: { refs: readonly Reference[]; label?: string }) {
  const { openSource } = useConsole();
  if (refs.length === 0) return null;
  return (
    <section className="ref-list" aria-label={label}>
      <p className="section-label">{label}</p>
      <ol>
        {refs.map((r) => (
          <li key={r.n} id={r.anchor}>
            <button type="button" className="ref-list__open" onClick={() => openSource(r)}>
              <span className="ref-list__n">[{r.n}]</span> <span className="ref-list__kind">{r.heading}</span> · {r.title}
              {r.page !== null ? ` · p. ${r.page}` : ""}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
