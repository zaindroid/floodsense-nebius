import demo from "../fixtures/demo_live.json";

/**
 * Demo data: the three live fetchers (gauge_levels, eu_watch, hazard_now) read this bundled snapshot instead of
 * the API. The flag is module state so the plain fetch functions can read it; ConsoleContext owns it (from the
 * URL) and every screen shows a "DEMO DATA" chip while it is on. Nothing else is mocked: chat and the
 * approvals queue still talk to the API.
 */
let demoOn = false;

export function isDemo(): boolean {
  return demoOn;
}

export function setDemoFlag(on: boolean): void {
  demoOn = on;
}

export const DEMO_SNAPSHOT_AT: string = demo.snapshot_at;
export const DEMO_CHIP_TEXT = "DEMO DATA";

const BODIES: Record<string, unknown> = {
  "/views/gauge_levels": demo.gauge_levels,
  "/views/eu_watch": demo.eu_watch,
  "/views/hazard_now": demo.hazard_now,
};

/** A fetch() stand-in that answers the three live views from the bundled snapshot. Same headers the API sends. */
export function demoFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = Object.keys(BODIES).find((p) => url.includes(p));
  if (!path) return Promise.resolve(new Response("not in the demo snapshot", { status: 404 }));
  return Promise.resolve(
    new Response(JSON.stringify(BODIES[path]), {
      status: 200,
      headers: { "content-type": "application/json", "x-query-id": "demo-snapshot", "x-executed-at": DEMO_SNAPSHOT_AT },
    }),
  );
}

/** "27 Oct 12:40 UTC", for the chip tooltip and notes. */
export function demoSnapshotText(): string {
  const d = new Date(DEMO_SNAPSHOT_AT);
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}
