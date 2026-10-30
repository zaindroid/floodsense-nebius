import type { Chip } from "../lib/impact";

/** Goal and impact: the desk goal, KPI chips from live data ("no data yet" when missing), and one cited fact. */
export function ImpactStrip({ goal, chips, fact }: { goal: string; chips: Chip[]; fact?: { text: string; source: string } }) {
  return (
    <section className="impact-strip card" aria-label="Goal and impact">
      <p className="eyebrow">Goal and impact</p>
      <p className="impact-goal">{goal}</p>
      <ul className="impact-chips">
        {chips.map((c) => (
          <li key={c.label}>
            <strong>{c.value ?? "no data yet"}</strong> <span className="muted small">{c.label}</span>
          </li>
        ))}
      </ul>
      {fact && (
        <p className="muted small impact-why" title={fact.source}>
          Why it matters: {fact.text} (Source: {fact.source})
        </p>
      )}
    </section>
  );
}
