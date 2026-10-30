import { shortModel } from "./liveRun";
import { MODEL_BACKENDS, providerOf } from "./lanes";

/** Display names for the Nemotron ids the agents run. */
const MODEL_NAMES: Record<string, string> = {
  "nvidia/nemotron-3.5-lightning-30b-a3b": "Nemotron 3.5 Lightning 30B",
  "nvidia/nemotron-3.5-super-vl-120b-a12b": "Nemotron 3.5 Super VL 120B",
  "nvidia/nvidia-nemotron-3-nano-30b-a3b": "Nemotron 3 Nano 30B",
  "nvidia/nemotron-3.5-super-vl": "Nemotron 3.5 Super VL",
  "nvidia/nemotron-3-ultra-550b-a55b": "Nemotron 3 Ultra 550B",
};

export function modelName(modelId: string): string {
  return MODEL_NAMES[modelId.toLowerCase()] ?? shortModel(modelId);
}

function llmIds(modelId: string | null | undefined): string[] {
  return (modelId ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && m !== "deterministic");
}

/**
 * The model chip for one agent step, from the trace `model_id` and `lane` (fast / deep / sql):
 * "Nemotron 3.5 Lightning 30B · Nightshift fast lane", "SQL · Zetaris", or "rules" for a deterministic step.
 */
export function modelChip(modelId: string | null | undefined, lane: string | null | undefined, provider?: string | null): string {
  const ids = llmIds(modelId);
  const l = (lane ?? "").toLowerCase();
  if (ids.length) {
    const id = ids[ids.length - 1];
    const name = modelName(id);
    const p = providerOf(id, provider);
    if (!p) return name;
    // Lanes are the backends' routing; a test provider has none to name.
    if (!MODEL_BACKENDS.has(p)) return `${name} · ${p}`;
    const laneWord = l === "deep" ? "deep lane" : l === "fast" ? "fast lane" : null;
    return laneWord ? `${name} · ${p} ${laneWord}` : `${name} · ${p}`;
  }
  if (l === "sql") return "SQL · Zetaris";
  return "rules";
}

/** The run-level model: "Nemotron 3.5 Lightning 30B via Nightshift", or the bare id for any other model. */
export function runModelLine(modelIds: readonly string[], stated?: string | null): string | null {
  const ids = modelIds.flatMap((m) => llmIds(m));
  if (!ids.length) return null;
  const id = ids[ids.length - 1];
  const provider = providerOf(id, stated);
  return provider ? `${modelName(id)} via ${provider}` : modelName(id);
}

/**
 * Pure: the backend the trace says served the run's models, last stated wins. Takes raw body steps
 * (`provider`) or adopted ones alike. Null for a run recorded before the agents stamped it.
 */
export function traceProvider(trace: unknown): string | null {
  if (!Array.isArray(trace)) return null;
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const p = (trace[i] as { provider?: unknown } | null)?.provider;
    if (typeof p === "string" && p.trim()) return p.trim();
  }
  return null;
}
