import type { SystemStatus } from "../../lib/system";
import type { DataKind, RecalledMemory } from "../../lib/stack";
import { CountUp, Empty, StackCard } from "./StackBits";

const LOOP = ["Run answers", "Judge scores", "Human approves", "H-MEM remembers", "Next run recalls"] as const;

export function EnginesCard({
  system,
  recalled,
  recalledKind,
}: {
  system: SystemStatus | null;
  recalled: RecalledMemory[];
  /** Where `recalled` came from: the shown run (replay/live/sample). */
  recalledKind: DataKind;
}) {
  const counts: [string, number | null][] = [
    ["Memories (H-MEM)", system?.memory.count ?? null],
    ["Events (World Model)", system?.engines.wmEvents ?? null],
    ["Hypotheses", system ? system.world.hypotheses : null],
  ];
  return (
    <StackCard
      id="stk-engines"
      title="Meterless engines: H-MEM + World Model"
      role="H-MEM keeps findings a person approved. The World Model tracks which hypotheses the evidence still supports."
      kind={system ? "live" : recalled.length ? recalledKind : "none"}
    >
      <dl className="stk-kv stk-kv--3">
        {counts.map(([label, n]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{n === null ? "n/a" : <CountUp value={n} />}</dd>
          </div>
        ))}
      </dl>
      {system && !system.engines.ok && <p className="stk-note">Engines report: {system.engines.error ?? "not reachable"}. Counts may be missing.</p>}
      <h3 className="stk-sub">Recalled in the shown run</h3>
      {recalled.length === 0 ? (
        <Empty>The shown run recalled no memory.</Empty>
      ) : (
        <ul className="stk-recall">
          {recalled.slice(0, 4).map((m, i) => (
            <li key={m.id} style={{ animationDelay: `${i * 0.25}s` }}>
              <span className="stk-mono">{m.id}</span> {m.text}
            </li>
          ))}
        </ul>
      )}
      <h3 className="stk-sub">Approve, then remember</h3>
      <ol className="stk-loop" aria-label="Approve then remember loop">
        {LOOP.map((s, i) => (
          <li key={s} className={i === 2 ? "is-gate" : undefined}>
            {s}
          </li>
        ))}
      </ol>
      <p className="stk-note">Nothing is stored until a person approves. A rejected run teaches the memory nothing.</p>
    </StackCard>
  );
}
