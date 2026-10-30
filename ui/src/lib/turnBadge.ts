import { runBadge } from "../api/ask";
import type { RecordedRun } from "../api/replay";

/** Badge for a finished turn. Anything the API did not run live (cache hit, replay) is labelled so. */
export function turnBadge(run: RecordedRun): string {
  return run.servedFrom === "live" ? runBadge(run) : "Recorded/cached · not live";
}
