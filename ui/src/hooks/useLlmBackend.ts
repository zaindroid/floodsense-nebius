import { useEffect, useSyncExternalStore } from "react";
import { fetchPlatformStatus } from "../api/platform";
import { getLanePricing, getLlmBackend, setLanePricing, setLlmBackend, subscribeLlmBackend } from "../lib/lanes";

/** The live LLM backend ("nebius", "nightshift", ...) or null while unknown. Re-renders when it arrives. */
export const useLlmBackend = (): string | null => useSyncExternalStore(subscribeLlmBackend, getLlmBackend, getLlmBackend);

/** Per-lane Token Factory pricing (null until /platform/status carries it). */
export const useLanePricing = () => useSyncExternalStore(subscribeLlmBackend, getLanePricing, getLanePricing);

let inflight: Promise<void> | null = null;

/** The one GET /platform/status for the shell (shared across the dev StrictMode double mount). A failure leaves the backend unknown. */
export function useLoadLlmBackend(): void {
  useEffect(() => {
    inflight ??= fetchPlatformStatus().then((r) => {
      setLlmBackend(r.status?.llmBackend);
      setLanePricing(r.status?.llmUsage?.pricing);
    });
  }, []);
}
