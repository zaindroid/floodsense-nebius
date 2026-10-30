/**
 * Hand-checked TypeScript mirror of contracts/schemas/floodsense.schema.json.
 *
 * Wire format is snake_case, the same JSON the API will return. The mock UI
 * on spike/mock-ui uses camelCase and is not this contract. Do not edit that
 * branch from here.
 */

export type CitationLayer = "a" | "b" | "c";
export type Storage = "full_text" | "pointer";
export type Grounding = "supported" | "partial" | "unsupported";
export type ServedFrom = "live" | "cache" | "replay";
/** Router lane. reply: front-door reply; quick: live watcher, template claims; forecast: forecast data, history, template claims; full: deep run. */
export type Lane = "reply" | "quick" | "forecast" | "full";

/** Forecast lane only: a FloodSense screening status and a template lead, never an official warning. */
export interface Forecast {
  status: "Normal" | "Watch" | "Elevated";
  /** Status plus its driver, e.g. "Elevated (river model)". */
  status_label?: string;
  status_reason?: string;
  places?: string[];
  horizon_h?: number;
  /** Template status line built from the claims; no model writes it. */
  lead?: string;
  screening?: string;
  gaps?: string[];
  disclaimer: string;
  attribution?: string;
}
/** Quick and forecast lanes: the calm, plain-language answer. Fixed rules, no model; the claims stay the cited detail. */
export interface Plain {
  headline: string;
  /** One plain sentence. A number appears only when a cited claim states it. */
  one_line: string;
  /** "7d" only when the question asked for the week and the 7-day river forecast covers it. */
  horizon: "48h" | "7d";
  status: "normal" | "watch" | "elevated" | "unknown";
  basis?: "gauge" | "model";
  places?: string[];
  /** ISO alpha-2 of the first asked place; picks the official warning links. */
  country?: string | null;
  /** ISO alpha-2 of every asked place's country; the UI shows each country's official links. */
  countries?: string[];
  service?: string;
  /** A history item framed as history, cut at a sentence boundary. */
  context?: string | null;
  next_step: string;
  disclaimer: string;
  /** claim_id of every claim that is the cited detail. */
  details: string[];
}
export type ApprovalStatus = "pending" | "approved" | "edited" | "rejected";
export type ModelId =
  | "meterless/fast"
  | "meterless/deep"
  | "nvidia/nemotron-3.5-super-vl-120b-a12b"
  | "nvidia/nemotron-3.5-lightning-30b-a3b"
  | "nvidia/Nemotron-3.5-Super-VL"
  | "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
  | "deterministic";

export interface Locator {
  section?: string;
  /**
   * Optional on layers a and b. Required on layer c and never null there.
   * A section-structured source still sets a page-like id (1 for the whole
   * document, or one id per section). Section does not replace page.
   */
  page?: number;
  paragraph?: number;
  /** Line range inside the paragraph, for example 3-5. */
  lines?: string;
}

export interface Citation {
  citation_id: string;
  claim_id: string;
  layer: CitationLayer;
  source_url: string;
  title: string;
  publisher: string;
  /** ISO 8601 date-time. */
  accessed_at: string;
  licence: string;
  attribution: string;
  /** When quote is present, SHA-256 hex of that quote as UTF-8 (what the Judge compares). A layer c chunk row keeps a separate hash of the full passage; that hash is not this field. */
  content_sha256: string;
  storage: Storage;
  locator?: Locator;
  /** One or two sentences. Required when layer is c. */
  quote?: string;
  /** Zetaris query id. Required when layer is c. */
  query_id?: string;
  /** pgvector chunk id. Optional on layer c. Layers a and b omit it. */
  chunk_id?: string;
}

export interface Evidence {
  query_id: string;
  view: string;
  sql: string;
  /** At most 20 rows. Column names depend on the view. */
  rows_sample: Record<string, unknown>[];
  /** Full result size. May be larger than rows_sample. */
  row_count: number;
  /** ISO 8601 date-time. */
  executed_at_utc: string;
}

/** A number set aside as not a result: date part, named line, or query filter. */
export interface DroppedNumber {
  value: number;
  reason: string;
}

export interface Claim {
  claim_id: string;
  text: string;
  numbers_dropped?: DroppedNumber[];
}

export interface JudgeClaim {
  claim_id: string;
  grounding: Grounding;
  citation_faithful: boolean;
  numbers_match: boolean;
  /** 0 to 1. */
  score: number;
  rationale: string;
  model_id: ModelId;
  numbers_dropped?: DroppedNumber[];
}

export interface Judge {
  claims: JudgeClaim[];
  /** 0 to 1. */
  overall_score: number;
}

export interface PlaybookAction {
  action_id: string;
  run_id: string;
  title: string;
  detail: string;
  citation_ids: string[];
  /** Optional approval-card fields (v0.13). */
  action_type?: ActionType | null;
  target_region?: string | null;
  /** Distinct exposed sites; null when not knowable. */
  affected_site_count?: number | null;
  /** Exact text an outbound action would send, only after approval. */
  draft_message?: string | null;
  outbound?: boolean;
  released?: boolean;
}

export type ActionType =
  | "notify-policyholders"
  | "dispatch-loss-adjuster"
  | "flag-underwriting-review"
  | "inform-public";

export interface Approval {
  approval_id: string;
  run_id: string;
  action_id: string;
  status: ApprovalStatus;
  note?: string;
  /** Set when the Judge has scored the run. */
  judge?: Judge;
}

/** A past approved finding H-MEM recalled for the Investigator. Context, never evidence. */
export interface MemoryUsed {
  memory_id: string;
  run_id?: string | null;
  claim_id?: string | null;
  approved_at?: string | null;
  text: string;
  relevance?: number | null;
  reviewer?: string | null;
  /** True for items added by tasks.py demo-seed, not by an analyst. */
  seeded: boolean;
}

export interface Answer {
  run_id: string;
  question: string;
  claims: Claim[];
  citations: Citation[];
  evidence: Evidence[];
  served_from: ServedFrom;
  /**
   * Timestamp when served_from is cache or replay.
   * Null or omitted when served_from is live.
   */
  cached_at?: string | null;
  playbook_actions?: PlaybookAction[];
  judge?: Judge;
  /** Which agent path answered. Omitted by runs recorded before the router. */
  lane?: Exclude<Lane, "reply">;
  /** Why the router chose the lane, including any "escalated: ..." note. */
  router_reason?: string;
  /** Forecast lane only. */
  forecast?: Forecast;
  /** Quick and forecast lanes only. */
  plain?: Plain;
  memory_used?: MemoryUsed[];
}

export type ReplyIntent = "greeting" | "help" | "thanks" | "off_topic";

/** Front-door reply to POST /runs: no run_id, never a flood fact, never cached as a run. */
export interface ReplyResponse {
  kind: "reply";
  intent: ReplyIntent;
  answer: string;
  /** Up to three example questions. */
  suggestions: string[];
  /** The fast-lane model that classified the message, or "rules". */
  model_id: string;
  latency_ms: number;
  lane?: "reply";
}

/** What POST /runs returns. */
export type RunResponse = Answer | ReplyResponse;

export type WatchKind = "detected" | "checked" | "exposure" | "drafted" | "awaiting_approval" | "approved" | "info";
export type WatchAgent = "Watch" | "Forecast" | "Exposure" | "Playbook" | "Judge" | "Human";
/** Colour class of a plain status. Never red: a model band is not a warning. */
export type WatchTone = "normal" | "watch" | "elevated" | "neutral" | "unknown";

/** The contract view and the Zetaris query id behind an event. view is "runs" / "watch" for events about runs or the loop. */
export interface WatchSource {
  view: string;
  query_id: string | null;
}

/** One row of the control tower activity feed (GET /watch/events, SSE GET /watch/stream). Fixed-template text; no model writes it. */
export interface WatchEvent {
  /** "w" plus an 8-digit, strictly increasing sequence. */
  id: string;
  ts: string;
  kind: WatchKind;
  agent: WatchAgent;
  /** gauge:<station>, model:<EU point>, valencia:<VAL point>; null for the loop or a run with no place. */
  place_id: string | null;
  place: string;
  river: string;
  country: string;
  /** The plain status word at that moment, or empty. */
  status: string;
  tone: WatchTone;
  text: string;
  run_id: string | null;
  source: WatchSource;
  /** Technical detail (a raw upstream error), never in the plain text; the UI shows it collapsed. Optional. */
  detail?: string | null;
  /** The numbers behind the sentence (sites, insured_eur, rain_48h_mm, screening, ...). */
  data: Record<string, unknown>;
}

/** GET /watch/status: the loop, the last scan, counts and the auto-assess switch with its caps. */
export interface WatchStatus {
  note: string;
  loop: { enabled: boolean; alive: boolean; interval_s: number; next_cycle_at: string | null };
  scanning: boolean;
  started_at: string;
  last_cycle: Record<string, unknown> | null;
  counts: { sources: number; elevated: number; events: number; awaiting_approval: number };
  latest_event_id: string | null;
  awaiting_run_ids: string[];
  auto_assess: {
    enabled: boolean;
    per_hour: number;
    per_day: number;
    used_hour: number;
    used_day: number;
    next_allowed_at: string | null;
    uses_model_calls: true;
    /** Set when auto-assess cannot be switched on (the caps would not survive a restart). */
    blocked?: string | null;
  };
  persisted: boolean;
  /** Why nothing is saved between restarts (auto-assess then stays off), or null. */
  persisted_reason?: string | null;
  served_from: ServedFrom;
  cached_at: string | null;
}
