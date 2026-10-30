import { Fragment, useId } from "react";
import "../../styles/stack.css";
import "../../styles/agentsLive.css";
import { useAgentsLive, useAgentsLiveFrom, type AgentsLiveModel } from "../../hooks/useAgentsLive";
import type { WatchEvent } from "../../lib/controlTower";
import type { StackData } from "../../hooks/useStackData";
import { backendName, cacheLine, laneRows, rateView, servedBadge, watchLines, wireOn } from "../../lib/agentsLive";
import { CORE_NODES } from "../../lib/stack";
import { modelDisplay } from "../../lib/techTrace";
import { DataBadge, ms } from "../stack/StackBits";

const modelText = (id: string | null): string =>
  id ? id.split(",").map((m) => (m.trim() === "deterministic" ? "rules" : modelDisplay(m.trim()))).join(" + ") : "no model call";

/**
 * The agent pool at work: status, duration, handoffs, loops, tool calls, cache, rate limit and models.
 * Shows a running run when there is one; otherwise replays the newest recorded run, badged REPLAY (never LIVE).
 * `stack`: pass a page's own useStackData() result to avoid a second poll. `compact`: nodes, badges and one status line only.
 */
type WatchIn = { events: WatchEvent[]; open: boolean };

export function AgentsLive({ stack, compact = false, plain = false, watch }: { stack?: StackData; compact?: boolean; plain?: boolean; watch?: WatchIn }) {
  return stack ? <Given stack={stack} compact={compact} plain={plain} watch={watch} /> : <Own compact={compact} plain={plain} watch={watch} />;
}

function Own({ compact, plain, watch }: { compact: boolean; plain: boolean; watch?: WatchIn }) {
  const { model, stack } = useAgentsLive(watch);
  return plain ? <PlainAgents model={model} /> : <View model={model} stack={stack} compact={compact} />;
}

function Given({ stack, compact, plain, watch }: { stack: StackData; compact: boolean; plain: boolean; watch?: WatchIn }) {
  const model = useAgentsLiveFrom(stack, watch);
  return plain ? <PlainAgents model={model} /> : <View model={model} stack={stack} compact={compact} />;
}

/** Citizen variant: agent names, simple status words and one sentence. No durations, tokens, cost, rates, cache or counts. */
export function PlainAgents({ model: m }: { model: AgentsLiveModel }) {
  const hid = useId();
  const word = (id: string, state: string) =>
    state === "idle" ? "watching" : state === "active" ? (id === "skeptic" || id === "judge" ? "double-checking" : "checking") : "ready";
  return (
    <section className="card agl agl--compact agl--plain" aria-labelledby={hid} data-agents-live={m.kind}>
      <header className="agl-head">
        <h2 id={hid} className="stk-title">
          Who checked this
        </h2>
        <DataBadge kind={m.kind} />
      </header>
      {m.kind === "none" ? (
        <p className="stk-empty">No answer has been checked yet.</p>
      ) : (
        <>
          <p className="stk-note">{m.kind === "live" ? "Working on it now." : "A recorded example, not happening now."}</p>
          <ul className="agl-pool" aria-label="Agents">
            {m.nodes.map((n) => (
              <li key={n.id} className={`agl-node agl-node--${n.state}`}>
                <strong>{n.label}</strong>
                <span className="agl-state">{word(n.id, n.state)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="stk-note">Several AI agents checked this answer; a human approves before anything goes out.</p>
    </section>
  );
}

function View({ model: m, stack, compact }: { model: AgentsLiveModel; stack: StackData; compact: boolean }) {
  const platform = stack.platform.data;
  const served = servedBadge(m.servedFrom, m.kind !== "live");
  const hid = useId();
  const rate = rateView(platform);
  const lanes = laneRows(platform);
  const backend = backendName(platform?.llmBackend);
  const counters = cacheLine(platform);
  const watching = watchLines(m.watch);
  const label = (id: string) => m.nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <section className={`card agl${compact ? " agl--compact" : ""}${m.still ? " agl--still" : ""}`} aria-labelledby={hid} data-agents-live={m.kind}>
      <header className="agl-head">
        <h2 id={hid} className="stk-title">
          Agents at work
        </h2>
        <DataBadge kind={m.kind} />
        {m.kind !== "none" && m.servedFrom && (
          <span className={`agl-cache agl-cache--${served.tone}`} title="How this run was answered (served_from)">
            {served.text}
          </span>
        )}
      </header>
      {m.kind === "live" && <p className="stk-note">Run {m.runId} is working now.</p>}
      {(m.kind === "replay" || m.kind === "sample") && (
        <p className="agl-replay" role="note">
          {m.kind === "replay" ? "REPLAY" : "SAMPLE"}: this is the recorded trace of {m.kind === "sample" ? "the bundled example run" : `run ${m.runId}`}, played back sped up. Nothing is running right now.
          {m.still ? " Motion is reduced, so the finished trace is shown." : ""}
        </p>
      )}
      {m.kind === "none" && <p className="stk-empty">No run with a trace yet. Ask a question and the agents show up here.</p>}
      <p className="sr-only" role="status" aria-live="polite">
        {m.announce}
      </p>

      <ol className="agl-pool" aria-label="Agent pool">
        {m.nodes.map((n, i) => (
          <Fragment key={n.id}>
            <li className={`agl-node agl-node--${n.state}`} aria-current={n.state === "active" ? "step" : undefined}>
              <strong>{n.label}</strong>
              <span className="agl-state">
                {n.state === "idle" ? "idle" : n.state === "active" ? "running" : "done"}
                {n.runs > 1 ? ` x${n.runs}` : ""}
              </span>
              {n.state !== "idle" && <span className="stk-mono">{ms(n.latencyMs)}</span>}
              {!compact && n.state !== "idle" && <span className="stk-mono">{modelText(n.modelId)}</span>}
              {!compact &&
                n.state !== "idle" &&
                m.chips[n.id].map((c) => (
                  <span key={c} className="agl-tool">
                    {c}
                  </span>
                ))}
            </li>
            {i < CORE_NODES.length - 1 && <li className={`agl-wire${wireOn(m.handoff, i) ? " agl-wire--on" : ""}`} aria-hidden="true" role="presentation"><i /></li>}
          </Fragment>
        ))}
      </ol>
      <p className="agl-loops">
        {m.handoff && (
          <span className="stk-chip stk-chip--on agl-handoff">
            Handoff: {label(m.handoff.from)} to {label(m.handoff.to)}
          </span>
        )}
        <span className={m.loops.revise > 0 ? "stk-chip stk-chip--on" : "stk-chip"}>Revise loop x{m.loops.revise}</span>
        <span className={m.loops.repair > 0 ? "stk-chip stk-chip--on" : "stk-chip"}>Repair loop x{m.loops.repair}</span>
        {m.kind !== "live" && m.total > 0 && (
          <span className="stk-chip">
            step {m.played} of {m.total}
          </span>
        )}
      </p>

      <div className="agl-rate" aria-label="Rate limit lane">
        {rate ? (
          <>
            <span className="agl-slots" role="img" aria-label={`${rate.inFlight} of ${rate.max} run slots in use`}>
              {rate.lights.map((on, i) => (
                <span key={i} className={`stk-slot agl-slot${on ? " is-on" : ""}`} />
              ))}
            </span>
            <span className="stk-note">
              {rate.inFlight}/{rate.max} slots · {rate.runsPerMin} runs/min · {rate.recent429} recent 429
            </span>
          </>
        ) : (
          <span className="stk-note">Rate limit not reported (API not reached).</span>
        )}
        {m.retryLeft !== null && (
          <span className="agl-wait" role="timer">
            Rate limited: retry in {m.retryLeft} s
          </span>
        )}
        {counters && <span className="stk-note">Cache: {counters}</span>}
      </div>

      {!compact && (
        <>
          <h3 className="stk-sub">Model lanes{backend ? ` · ${backend}` : ""}</h3>
          {lanes.length === 0 ? (
            <p className="stk-note">No lane data from /platform/status.</p>
          ) : (
            <ul className="agl-lanes">
              {lanes.map((l) => (
                <li key={l.lane}>
                  <strong>{l.lane}</strong>
                  <span className="stk-mono">{l.model ? modelDisplay(l.model) : "model not reported"}</span>
                  <span className="stk-note">
                    {l.calls ?? 0} calls · {(l.tokens ?? 0).toLocaleString("en")} tokens · avg {ms(l.avgMs)}
                    {l.p50Ms !== null ? ` · p50 ${ms(l.p50Ms)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="stk-note">
            Tools: Tavily {platform ? (platform.tavily ? "configured" : "not configured") : "unknown"} · data via {platform?.dataBackend ?? "unknown"}. Chips under an agent show only tools the recorded run used.
          </p>
          <h3 className="stk-sub">
            Watch loop <span className={`agl-dot${m.watchOpen ? " is-on" : ""}`} aria-hidden="true" /> {m.watchOpen ? "streaming" : "not streaming"}
          </h3>
          {watching.length === 0 ? (
            <p className="stk-note">No watch events yet.</p>
          ) : (
            <ul className="agl-watch">
              {watching.map((e) => (
                <li key={e.id}>
                  <span className="stk-mono">{e.time} {e.agent}</span> {e.text}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
