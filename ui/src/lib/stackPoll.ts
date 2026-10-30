import { nextPollMs } from "./stack";

export interface PollerOptions {
  /** One poll. Resolves true when the API answered (resets the backoff). */
  run: (signal: AbortSignal) => Promise<boolean>;
  baseMs: number;
  isHidden: () => boolean;
  /** Subscribe to "tab became visible"; returns the unsubscribe. */
  onVisible: (cb: () => void) => () => void;
  controller?: AbortController;
}

/** Self-rescheduling poll: waits while the tab is hidden, backs off on failures, polls at once when visible again. */
export function createPoller(o: PollerOptions): { start: () => void; stop: () => void; signal: AbortSignal } {
  const ctl = o.controller ?? new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let busy = false;
  let unsubscribe: (() => void) | null = null;
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (!ctl.signal.aborted) timer = setTimeout(() => void tick(), nextPollMs(o.baseMs, failures, o.isHidden()));
  };
  const tick = async () => {
    if (busy || ctl.signal.aborted) return;
    if (o.isHidden()) return schedule();
    busy = true;
    let ok = false;
    try {
      ok = await o.run(ctl.signal);
    } finally {
      busy = false;
    }
    if (ctl.signal.aborted) return;
    failures = ok ? 0 : failures + 1;
    schedule();
  };
  return {
    signal: ctl.signal,
    start() {
      unsubscribe = o.onVisible(() => void tick());
      void tick();
    },
    stop() {
      ctl.abort();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
