// FloodSense adapter over the Meterless reference engines.
//
// H-MEM keeps what humans approved (write-on-approval) and recalls it for the
// next run, with a trust-ledger trace for every memory. World Model keeps the
// hypothesis board and the observations behind it as an append-only event log.
// The vendored engines under ../vendor are used unchanged; this file only maps
// FloodSense shapes onto their public APIs.
//
// Vocabulary: wire names are snake_case and follow the agents' models
// (agents/floodsense_agents/models.py: Claim, Citation, Hypothesis, Anomaly,
// Approval) and contracts/schemas/floodsense.schema.json, so the agents can
// post their pydantic objects as they are. Unknown fields are ignored.
//
// Writes validate the whole request before touching an engine, and repeat
// calls are no-ops: a memory is keyed by (run_id, claim_id), a hypothesis by
// (run_id, id), and an unchanged hypothesis, status or concern writes nothing.

import fs from "node:fs";
import path from "node:path";
import { HMEM } from "../vendor/hmem/reference/src/index.ts";
import type { FeedbackKind, LedgerEntry } from "../vendor/hmem/reference/src/index.ts";
import { WorldModel, canonicalJson, externalId, normalizeName } from "../vendor/world-model/reference/src/index.ts";
import type { Entity, IngestObservation, IngestReport, Provenance } from "../vendor/world-model/reference/src/index.ts";

export const NAMESPACE = "floodsense";
/** Hypothesis.status in the agents' models. */
export const HYPOTHESIS_STATUSES = ["proposed", "supported", "not_supported"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];
/** Hypothesis.link in the agents' models. */
export const HYPOTHESIS_LINKS = ["rain->catchment", "catchment->river", "river->site", "site->exposure"] as const;
/** Approval.status in the agents' models (the run-level approval). */
export const APPROVAL_STATUSES = ["not_reached", "awaiting", "approved", "edited", "rejected", "auto"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
/** Only a human yes is remembered. "auto" is not a human decision. */
export const REMEMBERED_STATUSES: readonly ApprovalStatus[] = ["approved", "edited"];
/** Anomaly.kind in the agents' models. */
export const ANOMALY_KINDS = ["rain", "discharge", "warning"] as const;
export const FEEDBACK_KINDS: readonly FeedbackKind[] = ["helpful", "not_helpful", "wrong"];
export const TOP_N_MAX = 50;
export const TIMELINE_MAX = 1000;
const DEFAULT_CONFIDENCE = 0.8;
const DEFAULT_HYPOTHESIS_CONFIDENCE = 0.5;
const QUERY_REF = "zetaris:query_id:";

export class InputError extends Error {}

// ------------------------------------------------------------------ shapes

export interface CitationInput {
  citation_id?: string | null;
  query_id?: string | null;
  layer?: string | null;
  source_url?: string | null;
}

export interface ClaimInput {
  claim_id: string;
  text: string;
  kind?: string | null;
  hypothesis_id?: string | null;
  citations?: CitationInput[] | null;
  /** extra: defaults to 0.8 */
  confidence?: number | null;
  /** extra: names that help recall, stored as entity:<name> tags */
  entities?: string[] | null;
}

export interface ApprovalInput {
  status: ApprovalStatus;
  reviewer?: string | null;
  reviewer_note?: string | null;
  decided_at_utc?: string | null;
}

export interface StoreRunInput {
  run_id: string;
  question: string;
  event_id?: string | null;
  approval: ApprovalInput;
  claims: ClaimInput[];
}

export interface StoredRef {
  claim_id: string;
  memory_id: string;
}

export interface StoreResult {
  /** written by this call */
  stored: StoredRef[];
  /** already remembered from an earlier call for the same run: not written again */
  already_stored: StoredRef[];
  /** claims not written because the run was not approved */
  skipped: number;
  reason?: string;
}

export interface RecalledMemory {
  memory_id: string;
  content: string;
  relevance: number;
  confidence: number;
  source: string;
  layer: string;
  run_id: string | null;
  claim_id: string | null;
  query_ids: string[];
  tags: string[];
  provenance: { origin: string; learned_at: string; label: string; refs: string[] };
}

export interface RecallOptions {
  top_n?: number | null;
  threshold?: number | null;
}

export interface ObservationInput {
  external_id: string;
  title: string;
  at: string;
  source: { kind: string; by?: string | null; url?: string | null; run_id?: string | null };
  type?: string | null;
  text?: string | null;
  entities?: { type: string; name: string }[] | null;
}

export interface AnomalyInput {
  id: string;
  kind: (typeof ANOMALY_KINDS)[number];
  point_id: string;
  ts_utc: string;
  value?: number | null;
  unit?: string | null;
  why: string;
  query_id: string;
}

export interface ObserveInput {
  observations?: ObservationInput[] | null;
  anomalies?: AnomalyInput[] | null;
}

export interface HypothesisInput {
  id: string;
  statement: string;
  status: HypothesisStatus;
  link?: (typeof HYPOTHESIS_LINKS)[number] | null;
  evidence?: string[] | null;
  citations?: string[] | null;
  rounds?: number | null;
  rationale?: string | null;
  /** extra: defaults to 0.5 */
  confidence?: number | null;
  /** extra: entities the link is about, related as World Model "concerns" edges */
  concerns?: { type: string; name: string }[] | null;
}

export interface HypothesesInput {
  run_id: string;
  /** the scenario clock (replay time), not the wall clock */
  at: string;
  by?: string | null;
  hypotheses: HypothesisInput[];
}

export interface BoardItem {
  entity_id: string;
  run_id: string;
  hypothesis_id: string;
  link: string | null;
  statement: string;
  status: string;
  confidence: number | null;
  rounds: number;
  evidence: string[];
  citations: string[];
  rationale: string;
  concerns: string[];
  updated_at: string;
}

export interface EnginesOptions {
  /** Directory for JSON persistence. Omit to keep everything in memory. */
  dataDir?: string;
  /** Injectable clock for H-MEM and World Model operator actions. */
  clock?: () => number;
}

// ----------------------------------------------------------------- engines

export class FloodsenseEngines {
  readonly hmem: HMEM;
  readonly world: WorldModel;

  constructor(opts: EnginesOptions = {}) {
    const clock = opts.clock ?? Date.now;
    let hmemDir: string | undefined;
    if (opts.dataDir) {
      hmemDir = path.join(opts.dataDir, "hmem");
      fs.mkdirSync(hmemDir, { recursive: true });
    }
    this.hmem = new HMEM({ clock, persistDir: hmemDir, actor: "floodsense" });
    this.world = new WorldModel({
      namespace: NAMESPACE,
      storage: opts.dataDir ? "local" : "memory",
      directory: opts.dataDir,
      clock: () => new Date(clock()),
    });
  }

  // ------------------------------------------------------------------ H-MEM

  /** Write-on-approval. Approved or edited runs become memories; anything else writes nothing. */
  storeRun(input: StoreRunInput): StoreResult {
    const body = record(input, "body");
    const runId = text(body.run_id, "run_id");
    text(body.question, "question");
    const eventId = optionalText(body.event_id, "event_id");
    const approval = record(body.approval, "approval");
    const status = oneOf(approval.status, APPROVAL_STATUSES, "approval.status");
    const reviewer = optionalText(approval.reviewer, "approval.reviewer");
    optionalText(approval.reviewer_note, "approval.reviewer_note");
    const claims = list(body.claims, "claims").map((raw, i) => readClaim(raw, `claims[${i}]`));
    const ids = new Set<string>();
    for (const c of claims) {
      if (ids.has(c.claim_id)) throw new InputError(`claim_id ${c.claim_id} appears twice`);
      ids.add(c.claim_id);
    }

    if (!REMEMBERED_STATUSES.includes(status)) {
      return {
        stored: [],
        already_stored: [],
        skipped: claims.length,
        reason: `approval.status is ${status}; only approved or edited runs are remembered`,
      };
    }

    const existing = this.memoriesOfRun(runId);
    const stored: StoredRef[] = [];
    const alreadyStored: StoredRef[] = [];
    for (const c of claims) {
      const known = existing.get(c.claim_id);
      if (known) {
        alreadyStored.push({ claim_id: c.claim_id, memory_id: known });
        continue;
      }
      const queryIds = c.citations.map((x) => x.query_id).filter((q): q is string => !!q);
      const memory = this.hmem.add({
        content: c.text,
        type: "factual",
        layer: "long_term",
        confidence: c.confidence ?? DEFAULT_CONFIDENCE,
        source: `floodsense:run:${runId}`,
        missionId: runId,
        tags: [
          "floodsense",
          `run:${runId}`,
          `claim:${c.claim_id}`,
          ...(eventId ? [`event:${eventId}`] : []),
          ...(c.hypothesis_id ? [`hypothesis:${c.hypothesis_id}`] : []),
          ...c.entities.map((e) => `entity:${e}`),
        ],
        provenance: {
          origin: "plan_completion",
          learnedAt: this.hmem.clock(),
          label: `run ${runId} ${status} by ${reviewer ?? "an analyst"}`,
          refs: [...new Set(queryIds)].map((q) => QUERY_REF + q),
        },
      });
      stored.push({ claim_id: c.claim_id, memory_id: memory.id });
    }
    return { stored, already_stored: alreadyStored, skipped: 0 };
  }

  recall(query: unknown, opts: RecallOptions = {}): { memories: RecalledMemory[]; trace: Record<string, unknown> } {
    const q = text(query, "query");
    const topN = opts.top_n == null ? undefined : integer(opts.top_n, "top_n", 1, TOP_N_MAX);
    const threshold = opts.threshold == null ? undefined : unit(opts.threshold, "threshold");
    const result = this.hmem.query(q, { topN, threshold });
    return {
      memories: result.memories.map(({ memory, relevance }) => {
        const refs = memory.provenance?.refs ?? [];
        return {
          memory_id: memory.id,
          content: memory.content,
          relevance: Number(relevance.toFixed(4)),
          confidence: memory.confidence,
          source: memory.source,
          layer: memory.layer,
          run_id: tagValue(memory.tags, "run:"),
          claim_id: tagValue(memory.tags, "claim:"),
          query_ids: refs.filter((r) => r.startsWith(QUERY_REF)).map((r) => r.slice(QUERY_REF.length)),
          tags: memory.tags,
          provenance: {
            origin: memory.provenance?.origin ?? "",
            learned_at: new Date(memory.provenance?.learnedAt ?? memory.timestamp).toISOString(),
            label: memory.provenance?.label ?? "",
            refs,
          },
        };
      }),
      trace: snakeKeys(result.trace) as Record<string, unknown>,
    };
  }

  /**
   * The newest memories, newest first. Read-only: unlike recall, it does not
   * query H-MEM, so listing changes no access counts and writes no ledger entry.
   */
  memories(limit: unknown = 5): { total: number; memories: Record<string, unknown>[] } {
    const n = integer(limit, "limit", 1, TOP_N_MAX);
    const all = this.hmem.store.all();
    const learned = (m: (typeof all)[number]) => m.provenance?.learnedAt ?? m.timestamp;
    const newest = [...all].sort((a, b) => learned(b) - learned(a)).slice(0, n);
    return {
      total: all.length,
      memories: newest.map((m) => ({
        memory_id: m.id,
        content: m.content,
        confidence: m.confidence,
        run_id: tagValue(m.tags, "run:"),
        claim_id: tagValue(m.tags, "claim:"),
        event_id: tagValue(m.tags, "event:"),
        tags: m.tags,
        provenance: {
          origin: m.provenance?.origin ?? "",
          learned_at: new Date(learned(m)).toISOString(),
          label: m.provenance?.label ?? "",
        },
      })),
    };
  }

  feedback(memoryId: unknown, kind: unknown): { memory_id: string; confidence: number } {
    const id = text(memoryId, "memory_id");
    const k = oneOf(kind, FEEDBACK_KINDS, "kind");
    if (!this.hmem.store.get(id)) throw new InputError(`unknown memory ${id}`);
    this.hmem.feedback(id, k);
    return { memory_id: id, confidence: this.hmem.store.get(id)!.confidence };
  }

  /** The trust-ledger trace that answers "why does the agent remember this?". */
  ledger(memoryId: unknown): Record<string, unknown>[] {
    const id = text(memoryId, "memory_id");
    return this.hmem.ledger.history(id).map((entry: LedgerEntry) => {
      const { timestamp, ...rest } = entry;
      return { ...(snakeKeys(rest) as Record<string, unknown>), at: new Date(timestamp).toISOString() };
    });
  }

  private memoriesOfRun(runId: string): Map<string, string> {
    const byClaim = new Map<string, string>();
    for (const m of this.hmem.store.all()) {
      if (!m.tags.includes(`run:${runId}`)) continue;
      const claimId = tagValue(m.tags, "claim:");
      if (claimId && !byClaim.has(claimId)) byClaim.set(claimId, m.id);
    }
    return byClaim;
  }

  // ------------------------------------------------------------ World Model

  /**
   * Readings, warnings and sources as idempotent observations: re-ingesting
   * the same ones changes nothing. Accepts the Watchers' anomalies as they are.
   */
  async observe(input: ObserveInput): Promise<Record<string, unknown>> {
    const body = record(input, "body");
    const observations = body.observations == null ? [] : list(body.observations, "observations");
    const anomalies = body.anomalies == null ? [] : list(body.anomalies, "anomalies");
    if (observations.length + anomalies.length === 0) {
      throw new InputError("send a non-empty observations or anomalies list");
    }
    const batch: IngestObservation[] = [
      ...observations.map((o, i) => readObservation(o, `observations[${i}]`)),
      ...anomalies.map((a, i) => readAnomaly(a, `anomalies[${i}]`)),
    ];
    const report: IngestReport = await this.world.ingest(batch);
    return snakeKeys(report) as Record<string, unknown>;
  }

  /** Upsert a run's hypotheses and record each status change as a fact. */
  async upsertHypotheses(input: HypothesesInput): Promise<BoardItem[]> {
    const body = record(input, "body");
    const runId = text(body.run_id, "run_id");
    const at = timestamp(body.at, "at");
    const by = optionalText(body.by, "by") ?? "floodsense-agents";
    const hypotheses = list(body.hypotheses, "hypotheses").map((raw, i) => readHypothesis(raw, `hypotheses[${i}]`));
    if (hypotheses.length === 0) throw new InputError("hypotheses must be a non-empty list");
    const ids = new Set<string>();
    for (const h of hypotheses) {
      if (ids.has(h.id)) throw new InputError(`hypothesis ${h.id} appears twice`);
      ids.add(h.id);
    }

    const source: Provenance = { kind: "agent", by, at, runId };
    for (const h of hypotheses) {
      const key = `${runId}:${h.id}`;
      const entityId = externalId("hypothesis", NAMESPACE, key);
      const attrs = {
        run_id: runId,
        hypothesis_id: h.id,
        link: h.link,
        statement: h.statement,
        evidence: h.evidence,
        citations: h.citations,
        rounds: h.rounds,
        rationale: h.rationale,
      };
      const existing = this.world.view("graph").entity(entityId);
      if (!existing || canonicalJson(pick(existing.attrs, Object.keys(attrs))) !== canonicalJson(attrs)) {
        await this.world.upsertEntity({
          type: "hypothesis",
          externalKey: { system: NAMESPACE, id: key },
          attrs,
          source,
        });
      }
      const current = this.currentStatus(entityId);
      if (!current || current.value !== h.status || current.confidence !== h.confidence) {
        await this.world.assertFact({
          about: entityId,
          predicate: "status",
          value: h.status,
          confidence: h.confidence,
          source,
        });
      }
      for (const c of h.concerns) {
        const already = this.world
          .view("graph")
          .neighborsOf(entityId, { via: "concerns" })
          .some((n: Entity) => n.type === c.type && normalizeName(n.name ?? "") === normalizeName(c.name));
        if (already) continue;
        const target = await this.world.upsertEntity({ type: c.type, name: c.name, source });
        await this.world.relate({ from: entityId, type: "concerns", to: target.id, validFrom: at, source });
      }
    }
    return this.board(runId);
  }

  board(runId?: string | null): BoardItem[] {
    const graph = this.world.view("graph");
    const hypotheses = graph.query({
      type: "hypothesis",
      where: (e: Entity) => runId == null || e.attrs.run_id === runId,
    });
    return hypotheses
      .map((e) => {
        const current = this.currentStatus(e.id);
        const a = e.attrs;
        return {
          entity_id: e.id,
          run_id: String(a.run_id ?? ""),
          hypothesis_id: String(a.hypothesis_id ?? ""),
          link: typeof a.link === "string" ? a.link : null,
          statement: String(a.statement ?? ""),
          status: current ? String(current.value) : "proposed",
          confidence: current ? current.confidence : null,
          rounds: typeof a.rounds === "number" ? a.rounds : 0,
          evidence: stringList(a.evidence),
          citations: stringList(a.citations),
          rationale: String(a.rationale ?? ""),
          concerns: graph.neighborsOf(e.id, { via: "concerns" }).map((n) => n.name ?? n.id),
          updated_at: e.updatedAt,
        };
      })
      .sort((x, y) => x.run_id.localeCompare(y.run_id) || x.hypothesis_id.localeCompare(y.hypothesis_id));
  }

  timeline(limit: unknown = 100): { seq: number; kind: string; at: string; id: string }[] {
    const n = integer(limit, "limit", 1, TIMELINE_MAX);
    const events = this.world.events();
    return events.slice(Math.max(0, events.length - n)).map((e) => ({ seq: e.seq, kind: e.kind, at: e.at, id: e.id }));
  }

  stats(): Record<string, unknown> {
    return {
      hmem: { memories: this.hmem.store.all().length, ledger_entries: this.hmem.ledger.all().length },
      world_model: {
        events: this.world.events().length,
        hypotheses: this.world.view("graph").query({ type: "hypothesis" }).length,
      },
    };
  }

  /**
   * The current status fact. The reference sets supersededBy in memory only,
   * so a reload replays the facts without saying which is current; re-derive
   * it with the engine's default policy (most-recent-wins: later assertedAt
   * wins, and a tie goes to the later write).
   */
  private currentStatus(entityId: string): { value: unknown; confidence: number } | undefined {
    const seqOf = new Map<string, number>();
    for (const ev of this.world.events()) {
      if (ev.kind === "assertFact") seqOf.set((ev.payload as { id: string }).id, ev.seq);
    }
    const latest = this.world
      .view("facts")
      .about(entityId)
      .filter((f) => f.predicate === "status")
      .sort((a, b) => b.assertedAt.localeCompare(a.assertedAt) || (seqOf.get(b.id) ?? 0) - (seqOf.get(a.id) ?? 0))[0];
    return latest ? { value: latest.value, confidence: latest.confidence } : undefined;
  }
}

// -------------------------------------------------------------- input readers

interface Claim {
  claim_id: string;
  text: string;
  hypothesis_id: string | null;
  citations: { query_id: string | null }[];
  confidence: number | null;
  entities: string[];
}

function readClaim(raw: unknown, at: string): Claim {
  const c = record(raw, at);
  return {
    claim_id: text(c.claim_id, `${at}.claim_id`),
    text: text(c.text, `${at}.text`).trim(),
    hypothesis_id: optionalText(c.hypothesis_id, `${at}.hypothesis_id`),
    citations: (c.citations == null ? [] : list(c.citations, `${at}.citations`)).map((x, j) => {
      const cit = record(x, `${at}.citations[${j}]`);
      return { query_id: optionalText(cit.query_id, `${at}.citations[${j}].query_id`) };
    }),
    confidence: c.confidence == null ? null : unit(c.confidence, `${at}.confidence`),
    entities: (c.entities == null ? [] : list(c.entities, `${at}.entities`)).map((e, j) =>
      text(e, `${at}.entities[${j}]`).trim(),
    ),
  };
}

interface Hypothesis {
  id: string;
  statement: string;
  status: HypothesisStatus;
  link: string | null;
  evidence: string[];
  citations: string[];
  rounds: number;
  rationale: string;
  confidence: number;
  concerns: { type: string; name: string }[];
}

function readHypothesis(raw: unknown, at: string): Hypothesis {
  const h = record(raw, at);
  return {
    id: text(h.id, `${at}.id`),
    statement: text(h.statement, `${at}.statement`),
    status: oneOf(h.status, HYPOTHESIS_STATUSES, `${at}.status`),
    link: h.link == null ? null : oneOf(h.link, HYPOTHESIS_LINKS, `${at}.link`),
    evidence: textList(h.evidence, `${at}.evidence`),
    citations: textList(h.citations, `${at}.citations`),
    rounds: h.rounds == null ? 0 : integer(h.rounds, `${at}.rounds`, 0, 1000),
    rationale: optionalText(h.rationale, `${at}.rationale`, true) ?? "",
    confidence: h.confidence == null ? DEFAULT_HYPOTHESIS_CONFIDENCE : unit(h.confidence, `${at}.confidence`),
    concerns: (h.concerns == null ? [] : list(h.concerns, `${at}.concerns`)).map((x, j) => readEntityRef(x, `${at}.concerns[${j}]`)),
  };
}

function readEntityRef(raw: unknown, at: string): { type: string; name: string } {
  const e = record(raw, at);
  return { type: text(e.type, `${at}.type`), name: text(e.name, `${at}.name`) };
}

function readObservation(raw: unknown, at: string): IngestObservation {
  const o = record(raw, at);
  const src = record(o.source, `${at}.source`);
  const when = timestamp(o.at, `${at}.at`);
  const source: Provenance = { kind: text(src.kind, `${at}.source.kind`), at: when };
  const by = optionalText(src.by, `${at}.source.by`);
  const url = optionalText(src.url, `${at}.source.url`);
  const runId = optionalText(src.run_id, `${at}.source.run_id`);
  if (by) source.by = by;
  if (url) source.url = url;
  if (runId) source.runId = runId;
  const obs: IngestObservation = {
    externalId: text(o.external_id, `${at}.external_id`),
    title: text(o.title, `${at}.title`),
    at: when,
    source,
  };
  const type = optionalText(o.type, `${at}.type`);
  const body = optionalText(o.text, `${at}.text`);
  if (type) obs.type = type;
  if (body) obs.text = body;
  if (o.entities != null) obs.entities = list(o.entities, `${at}.entities`).map((x, j) => readEntityRef(x, `${at}.entities[${j}]`));
  return obs;
}

/** The Watchers' Anomaly, keyed by what was measured so the same reading from another run is the same observation. */
function readAnomaly(raw: unknown, at: string): IngestObservation {
  const a = record(raw, at);
  const kind = oneOf(a.kind, ANOMALY_KINDS, `${at}.kind`);
  const pointId = text(a.point_id, `${at}.point_id`);
  const when = timestamp(a.ts_utc, `${at}.ts_utc`);
  const queryId = text(a.query_id, `${at}.query_id`);
  text(a.id, `${at}.id`);
  const why = text(a.why, `${at}.why`);
  const value = a.value == null ? null : finite(a.value, `${at}.value`);
  const unitLabel = optionalText(a.unit, `${at}.unit`);
  const reading = value == null ? "" : ` ${value}${unitLabel ? ` ${unitLabel}` : ""}`;
  return {
    externalId: `anomaly:${kind}:${pointId}:${when}`,
    type: "anomaly",
    title: `${kind} at ${pointId}${reading}`,
    text: why,
    at: when,
    source: { kind: "pipeline", by: "floodsense-watchers", at: when, url: QUERY_REF + queryId },
    entities: [{ type: "point", name: pointId }],
  };
}

// ------------------------------------------------------------------ checks

type Obj = Record<string, unknown>;

function record(value: unknown, name: string): Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(`${name} must be an object`);
  }
  return value as Obj;
}

function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new InputError(`${name} must be a list`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError(`${name} is required`);
  return value;
}

function optionalText(value: unknown, name: string, allowEmpty = false): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new InputError(`${name} must be text`);
  if (!value.trim() && !allowEmpty) return null;
  return value;
}

function textList(value: unknown, name: string): string[] {
  if (value == null) return [];
  return list(value, name).map((x, i) => text(x, `${name}[${i}]`));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new InputError(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InputError(`${name} must be a number`);
  return value;
}

function unit(value: unknown, name: string): number {
  const n = finite(value, name);
  if (n < 0 || n > 1) throw new InputError(`${name} must be between 0 and 1`);
  return n;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  const n = finite(value, name);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new InputError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function timestamp(value: unknown, name: string): string {
  const s = text(value, name);
  if (Number.isNaN(Date.parse(s))) throw new InputError(`${name} must be an ISO timestamp`);
  return s;
}

// ----------------------------------------------------------------- helpers

function tagValue(tags: string[], prefix: string): string | null {
  const tag = tags.find((t) => t.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function pick(attrs: Obj, keys: string[]): Obj {
  return Object.fromEntries(keys.map((k) => [k, attrs[k] ?? null]));
}

/** camelCase keys from the vendored engines to snake_case on the wire. Embeddings are dropped. */
export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Obj)
      .filter(([k]) => k !== "embedding")
      .map(([k, v]) => [k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(), snakeKeys(v)]),
  );
}
