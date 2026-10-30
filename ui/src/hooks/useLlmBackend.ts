import { useEffect, useSyncExternalStore } from "react";
import { fetchPlatformStatus } from "../api/platform";
import { getLlmBackend, setLlmBackend, subscribeLlmBackend } from "../lib/lanes";

/** The live LLM backend ("nebius", "nightshift", ...) or null while unknown. Re-renders when it arrives. */
export const useLlmBackend = (): string | null => useSyncExternalStore(subscribeLlmBackend, getLlmBackend, getLlmBackend);

let inflight: Promise<void> | null = null;

/** The one GET /platform/status for the shell (shared across the dev StrictMode double mount). A failure leaves the backend unknown. */
export function useLoadLlmBackend(): void {
  useEffect(() => {
    inflight ??= fetchPlatformStatus().then((r) => setLlmBackend(r.status?.llmBackend));
  }, []);
}
