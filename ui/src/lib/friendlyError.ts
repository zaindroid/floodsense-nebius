/** Friendly, role-aware error text for the Ask chat. Raw detail goes behind "Technical detail", with hosts and URLs removed. */

export type ErrorKind = "unavailable" | "timeout" | "unreadable" | "not_found" | "failed" | "other";

export interface FriendlyError {
  kind: ErrorKind;
  text: string;
  retry: boolean;
  /** Offer the latest recorded answer, labelled not live. */
  offerRecorded: boolean;
  /** Raw detail with URLs and internal hosts stripped. Empty when there is nothing left. */
  technical: string;
}

/** Compose service names. Stripped only in host-like contexts, never as ordinary words. */
const SERVICE_HOSTS = ["agents", "api", "engines", "pgvector", "redis"];
const SERVICE_RE = SERVICE_HOSTS.join("|");
/**
 * A quoted token that is a hostname: a service name, localhost, an IPv4 address, or a dotted name whose
 * last label starts with a letter (agents.internal). A version string such as 'v1.2' is not a host.
 */
const QUOTED_HOST = new RegExp(
  `^(?:${SERVICE_RE}|localhost|\\d{1,3}(?:\\.\\d{1,3}){3}|[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z][a-z0-9-]*)$`,
  "i",
);
const VERSION = /^v?\d+(?:\.\d+)+$/i;

/**
 * Remove URLs (http://agents), host:port pairs (agents:8100, 10.0.0.5:8000, localhost:18000), IPv6 with a
 * port ([::1]:6379), `//name` and `@name` hosts, and quoted hostnames ('redis', "agents.internal").
 * A service name used as an ordinary word ("our agents are busy", "the API") is kept.
 */
export function stripInternal(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>),;]+/gi, "[internal address]")
    .replace(/\[[0-9a-f:.%a-z]*:[0-9a-f:.%a-z]*\]:\d{1,5}\b/gi, "[internal address]")
    .replace(/\b(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\b/gi, "[internal address]")
    .replace(/(?:\/\/|@)[a-z0-9-]+(?:\.[a-z0-9-]+)*\b/gi, "[internal address]")
    .replace(/(["'`])([a-z0-9.-]+)\1/gi, (quoted, _q: string, host: string) =>
      !VERSION.test(host) && QUOTED_HOST.test(host) ? "[internal service]" : quoted,
    )
    .replace(/(?:\s*\bat\s+\[internal (?:address|service)\])+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Pure: classify from an HTTP status (if any) and the raw message. */
export function classifyError(status: number | null, raw: string): ErrorKind {
  const m = raw.toLowerCase();
  if (status === 422) return "unreadable";
  if (status === 404 || /not found/.test(m)) return "not_found";
  if (status === 504 || status === 408 || /timed? ?out|timeout|taking longer|lost contact/.test(m)) return "timeout";
  if (status === 502 || status === 503 || (status === null && /unreachable|could not reach|network|failed to fetch|remoteprotocolerror|connect/.test(m)) || /unreachable|remoteprotocolerror|connecterror/.test(m))
    return "unavailable";
  if (/failed/.test(m) || (status !== null && status >= 500)) return "failed";
  return "other";
}

/**
 * `hasRecorded`: a recorded answer is actually shown under the message. Only then does the text say
 * "Here is the latest recorded answer"; otherwise it never promises one.
 */
export function friendlyError(
  status: number | null,
  raw: string,
  role: "citizen" | "insurer" | string = "insurer",
  hasRecorded = false,
): FriendlyError {
  const kind = classifyError(status, raw);
  const citizen = role === "citizen";
  const here = hasRecorded ? " Here is the latest recorded answer while you wait." : " Please try again in a moment.";
  const technical = stripInternal(raw);
  switch (kind) {
    case "unavailable":
      return {
        kind,
        text: `Our agents are restarting or busy right now.${here}${citizen ? " For official warnings, follow your local authorities." : ""}`,
        retry: true,
        offerRecorded: true,
        technical,
      };
    case "timeout":
      return { kind, text: "This is taking longer than usual… The agents may still finish; you can retry in a moment.", retry: true, offerRecorded: true, technical };
    case "unreadable":
      return { kind, text: "I couldn't read that question — try rephrasing.", retry: false, offerRecorded: false, technical };
    case "not_found":
      return { kind, text: "That run stopped before it could start properly. Please try again.", retry: true, offerRecorded: false, technical };
    case "failed":
      return {
        kind,
        text: citizen ? "Something went wrong while preparing your answer. Please try again." : "The run did not finish. Nothing was sent. Please try again.",
        retry: true,
        offerRecorded: true,
        technical,
      };
    default:
      return { kind, text: "Something went wrong. Please try again.", retry: true, offerRecorded: false, technical };
  }
}

/** Pure: an HTTP status from a message like "The service failed (503): …", else null. */
export function statusFromMessage(raw: string): number | null {
  const m = /\((\d{3})\)/.exec(raw);
  return m ? Number(m[1]) : null;
}
