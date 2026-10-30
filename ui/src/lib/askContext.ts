/**
 * Screen context sent with an Ask request as RunRequest.context.
 * The agents' RunRequest is a pydantic BaseModel with the default extra="ignore",
 * so an older agents build drops the field instead of refusing it.
 * Set VITE_ASK_CONTEXT=off to stop sending it at all: this is the one switch.
 */
export interface AskContext {
  role?: string;
  page?: string;
  point_id?: string;
  place?: string;
  /** PEGELONLINE station shortname (agents RunContext.station). */
  station?: string;
  event_id?: string;
  /** ISO instant the disaster replay was scrubbed to. */
  replay_date?: string;
}

export function askContextEnabled(): boolean {
  return (import.meta.env.VITE_ASK_CONTEXT ?? "").trim().toLowerCase() !== "off";
}

/** Pure: drop empty fields; null when nothing is left. */
export function cleanContext(ctx: AskContext | null | undefined): AskContext | null {
  if (!ctx) return null;
  const out: AskContext = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === "string" && v.trim()) out[k as keyof AskContext] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

/** Pure: the run body with `context` added, or unchanged when disabled or empty. */
export function withAskContext<T extends Record<string, unknown>>(
  body: T,
  ctx: AskContext | null | undefined,
  enabled = askContextEnabled(),
): T & { context?: AskContext } {
  const clean = enabled ? cleanContext(ctx) : null;
  return clean ? { ...body, context: clean } : body;
}

/** Pure: page context merged over the general screen context (the page wins). */
export function mergeContext(screen: AskContext | null, extra: AskContext | null): AskContext | null {
  return cleanContext({ ...(screen ?? {}), ...(extra ?? {}) });
}
