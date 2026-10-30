import { useEffect, useRef, useState, type ReactNode } from "react";
import { countStart, easeCount, type DataKind } from "../../lib/stack";

const BADGE_TEXT: Record<DataKind, string> = { live: "LIVE", replay: "REPLAY", sample: "SAMPLE", none: "NO DATA" };
const BADGE_HELP: Record<DataKind, string> = {
  live: "Read from the running API just now.",
  replay: "Read from a recorded run stored by the API. Not happening now.",
  sample: "Bundled example, not your system's data.",
  none: "Nothing to show yet.",
};

export function DataBadge({ kind }: { kind: DataKind }) {
  return (
    <span className={`stk-badge stk-badge--${kind}`} title={BADGE_HELP[kind]}>
      {BADGE_TEXT[kind]}
      <span className="sr-only">: {BADGE_HELP[kind]}</span>
    </span>
  );
}

/** Shared frame: title, one-line role, data badge, body. */
export function StackCard({ id, title, role, kind, children }: { id: string; title: string; role: string; kind: DataKind; children: ReactNode }) {
  return (
    <section className="card stk-card" aria-labelledby={`${id}-h`} data-card={id}>
      <header className="stk-head">
        <h2 id={`${id}-h`} className="stk-title">
          {title}
        </h2>
        <DataBadge kind={kind} />
      </header>
      <p className="stk-role">{role}</p>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="stk-empty">{children}</p>;
}

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A number that counts up to `value` when it changes. Reduced motion: the final value at once. */
export function CountUp({ value, ms = 900 }: { value: number; ms?: number }) {
  const [shown, setShown] = useState(value);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    const from = countStart(prev.current, value);
    prev.current = value;
    if (reducedMotion() || from === value) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = (now - t0) / ms;
      setShown(easeCount(from, value, t));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <span className="stk-num">{shown.toLocaleString("en")}</span>;
}

export const ms = (v: number | null): string => (v === null ? "n/a" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
