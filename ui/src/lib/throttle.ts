/**
 * Throttle with leading and trailing edge: the first value goes out at once, later ones at most once per `gap` ms,
 * always the latest. Returns push and cancel.
 */
export function createThrottle<T>(emit: (v: T) => void, gap: number): { push: (v: T) => void; cancel: () => void } {
  let last = -Infinity;
  let pending: { v: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (v: T) => {
    last = Date.now();
    emit(v);
  };
  return {
    push(v) {
      const wait = last + gap - Date.now();
      if (wait <= 0 && timer === undefined) return fire(v);
      pending = { v };
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          const p = pending;
          pending = null;
          if (p) fire(p.v);
        }, Math.max(0, wait));
      }
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = null;
    },
  };
}
