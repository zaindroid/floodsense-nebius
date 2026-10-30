/**
 * Display labels for judge model ids on the contract.
 *
 * Routing names and `deterministic` are shown as stored. A concrete
 * Nightshift id is "answered by" that model. Which model answers a routing
 * name today is the table at the top of docs/architecture/c4.md. Super VL
 * answers both lanes, so this label does not assign it to fast or deep.
 * Lightning is not shown as meterless/fast.
 */
const ANSWERED_BY: Record<string, string> = {
  "nvidia/nemotron-3.5-super-vl-120b-a12b": "answered by Nemotron 3.5 Super VL 120B A12B",
  "nvidia/nemotron-3.5-lightning-30b-a3b": "answered by Nemotron 3.5 Lightning 30B A3B",
};

export const NEBIUS_NAME = "Nebius Token Factory";
const PROVIDER_NAMES: Record<string, string> = { nightshift: "Nightshift", nebius: NEBIUS_NAME };

let llmBackend: string | null = null;
const listeners = new Set<() => void>();
/** Set from GET /platform/status (llm_backend). null = not known (loading, or the fetch failed). */
export function setLlmBackend(b: string | null | undefined): void {
  const next = b ? b.toLowerCase() : null;
  if (next === llmBackend) return;
  llmBackend = next;
  listeners.forEach((l) => l());
}
export const getLlmBackend = (): string | null => llmBackend;
export function subscribeLlmBackend(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/**
 * Provider label for a model. Only the run's own stated provider names one; a recorded run without it stays
 * neutral (null). `liveBackend` is passed only for a run happening now, which the current backend did serve.
 */
export function providerLabel(modelId: string, explicit?: string | null, liveBackend?: string | null): string | null {
  if ((explicit ?? "").trim()) return providerOf(modelId, explicit);
  const b = (liveBackend ?? "").toLowerCase();
  return b === "nebius" ? NEBIUS_NAME : b === "nightshift" ? "Nightshift" : null;
}

/** Title of the language-model box: names the backend only when known, else neutral. */
export function llmBoxTitle(backend: string | null | undefined): string {
  const b = (backend ?? "").toLowerCase();
  return b === "nebius" ? `${NEBIUS_NAME} · NVIDIA Nemotron` : b === "nightshift" ? "Nightshift · NVIDIA Nemotron" : "Model backend · NVIDIA Nemotron";
}

/**
 * The one provider rule for model chips, pipeline badges and the live model line. The trace's explicit
 * provider wins when present; only without one does the id decide: an nvidia/...nemotron... id is
 * Nightshift, anything else is not guessed.
 */
export function providerOf(modelId: string, explicit?: string | null): string | null {
  const stated = (explicit ?? "").trim();
  if (stated) return PROVIDER_NAMES[stated.toLowerCase()] ?? stated;
  const id = modelId.toLowerCase();
  if (id.startsWith("nvidia/") && id.includes("nemotron")) return "Nightshift";
  return null;
}

export function laneLabel(modelId: string): string {
  return ANSWERED_BY[modelId] ?? modelId;
}
