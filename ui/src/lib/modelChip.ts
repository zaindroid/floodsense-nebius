import { shortModel } from "./liveRun";
import { providerLabel as providerOf, NEBIUS_NAME } from "./lanes";

/** Display names for the Nemotron ids the agents run. */
const MODEL_NAMES: Record<string, string> = {
  "nvidia/nemotron-3.5-lightning-30b-a3b": "Nemotron 3.5 Lightning 30B",
  "nvidia/nemotron-3.5-super-vl-120b-a12b": "Nemotron 3.5 Super VL 120B",
};

export function modelName(modelId: string): string {
  return MODEL_NAMES[modelId] ?? shortModel(modelId);
}

function llmIds(modelId: string | null | undefined): string[] {
  return (modelId ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && m !== "deterministic");
}

/**
 * The model chip for one agent step, from the trace `model_id` and `lane` (fast / deep / sql):
 * "Nemotron 3.5 Lightning 30B · Nebius Token Factory fast lane" (or Nightshift), "SQL · Zetaris", or "rules" for a deterministic step.
 */
export function modelChip(modelId: string | null | undefined, lane: string | null | undefined, provider?: string | null, liveBackend?: string | null): string {
  const ids = llmIds(modelId);
  const l = (lane ?? "").toLowerCase();
  if (ids.length) {
    const id = ids[ids.length - 1];
    const name = modelName(id);
    const p = providerOf(id, provider, liveBackend);
    if (p !== "Nightshift" && p !== NEBIUS_NAME) return p ? `${name} · ${p}` : name;
    const laneWord = l === "deep" ? "deep lane" : l === "fast" ? "fast lane" : null;
    return laneWord ? `${name} · ${p} ${laneWord}` : `${name} · ${p}`;
  }
  if (l === "sql") return "SQL · Zetaris";
  return "rules";
}

/** The run-level model: "Nemotron 3.5 Lightning 30B via Nebius Token Factory" (or Nightshift), or the bare id for any other model. */
export function runModelLine(modelIds: readonly string[], provider?: string | null, liveBackend?: string | null): string | null {
  const ids = modelIds.flatMap((m) => llmIds(m));
  if (!ids.length) return null;
  const id = ids[ids.length - 1];
  const p = providerOf(id, provider, liveBackend);
  return p ? `${modelName(id)} via ${p}` : modelName(id);
}
