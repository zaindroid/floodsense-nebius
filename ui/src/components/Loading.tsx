import { useEffect, useState } from "react";

/** Seconds since `active` last turned true, ticking once a second. 0 while inactive. */
export function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const start = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return seconds;
}

/** After this many seconds a source counts as slow. Live views normally answer in 2-5 s. */
export const SLOW_AFTER_S = 8;

/** Pure: the loading sentence, with the elapsed time and, when slow, what is happening. */
export function loadingText(what: string, seconds: number, partial: boolean): string {
  const base = `Loading ${what}…${seconds >= 1 ? ` ${seconds} s` : ""}`;
  if (seconds >= SLOW_AFTER_S) return `${base} A source is slow${partial ? ", showing what we have" : ""}.`;
  return base;
}

/** Skeleton lines plus "Loading live readings… 3 s". Never a blank panel. */
export function LoadingNote({ what = "live readings", partial = false, skeleton = true }: { what?: string; partial?: boolean; skeleton?: boolean }) {
  const seconds = useElapsed(true);
  return (
    <div role="status" aria-live="polite" className="loading-note">
      {skeleton && (
        <div className="skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
      <p className="status-slow">{loadingText(what, seconds, partial)}</p>
    </div>
  );
}

/** One line under a page title while some views have answered and others have not. */
export function SlowSourceNote({ pending, what }: { pending: boolean; what: string }) {
  const seconds = useElapsed(pending);
  if (!pending || seconds < 3) return null;
  return (
    <p className="status-slow" role="status">
      {seconds >= SLOW_AFTER_S ? `${what} is slow, showing what we have. ${seconds} s` : `Still loading ${what}… ${seconds} s`}
    </p>
  );
}
