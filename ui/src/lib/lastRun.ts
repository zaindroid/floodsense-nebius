/** The newest live run that reached human review, shared between Ask FloodSense and the Approvals page. */
const KEY = "floodsense.awaitingRunId";
type Listener = (runId: string | null) => void;
const listeners = new Set<Listener>();

export function getAwaitingRunId(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setAwaitingRunId(runId: string | null): void {
  try {
    if (runId) window.sessionStorage.setItem(KEY, runId);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: listeners still hear it */
  }
  for (const l of listeners) l(runId);
}

export function onAwaitingRunId(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
