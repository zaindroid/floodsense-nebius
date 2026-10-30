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
  "nvidia/nvidia-nemotron-3-nano-30b-a3b": "answered by Nemotron 3 Nano 30B A3B",
  "nvidia/nemotron-3.5-super-vl": "answered by Nemotron 3.5 Super VL",
};

const PROVIDER_NAMES: Record<string, string> = { nightshift: "Nightshift", nebius: "Nebius Token Factory" };

/** The backends that serve the agents' lanes. Any other provider is the test switch. */
export const MODEL_BACKENDS: ReadonlySet<string> = new Set(Object.values(PROVIDER_NAMES));

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
  return ANSWERED_BY[modelId.toLowerCase()] ?? modelId;
}
