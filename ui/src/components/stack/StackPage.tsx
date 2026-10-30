import "../../styles/stack.css";
import { useStackData } from "../../hooks/useStackData";
import { memoryRecall, readsFromCitations, usageOfRun, viewReads, type DataKind } from "../../lib/stack";
import { AgentsLive } from "../agents/AgentsLive";
import { CacheCard } from "./CacheCard";
import { EnginesCard } from "./EnginesCard";
import { ModelsCard } from "./ModelsCard";
import { PoolCard } from "./PoolCard";
import { RateLimitCard } from "./RateLimitCard";
import { TavilyCard } from "./TavilyCard";
import { ZetarisCard } from "./ZetarisCard";
import { WHY_SPONSOR } from "../../lib/sponsors";
import "../../styles/sponsors.css";

/** "Under the hood": one animated card per technology, each fed by real API data and labelled with where it came from. */
export function StackPage() {
  const stack = useStackData();
  const { platform, system, stackRun, live, runsError } = stack;
  const raw = (stackRun?.raw ?? {}) as Record<string, unknown>;
  const run = stackRun?.run ?? null;
  const runKind: DataKind = stackRun?.kind ?? "none";
  const evidenceReads = viewReads(raw.evidence);
  const reads = evidenceReads.length ? evidenceReads : readsFromCitations(run?.claims ?? []);
  const loading = platform.loading && system.loading;
  const rl = platform.data?.rateLimit ?? null;

  return (
    <div className="stk-page">
      <header className="card stk-intro">
        <h2 className="stk-title">Under the hood</h2>
        <p>
          Which technology does what, drawn from this system's own data. <span className="stk-badge stk-badge--live">LIVE</span> is read from the API now,{" "}
          <span className="stk-badge stk-badge--replay">REPLAY</span> from a recorded run, <span className="stk-badge stk-badge--sample">SAMPLE</span> from the bundled
          example. Nothing is invented: with no data a card says so.
        </p>
        {loading && <p className="stk-note" role="status">Loading platform data…</p>}
        {platform.error && <p className="stk-note stk-warn">{platform.error}. Cards that need it show no numbers.</p>}
        {runsError && <p className="stk-note stk-warn">{runsError}. The agent card shows the bundled sample run.</p>}
      </header>
      <section className="card stk-card" aria-labelledby="stk-why-h">
        <h2 id="stk-why-h" className="stk-title">
          Why each sponsor
        </h2>
        <ul className="stk-why">
          {WHY_SPONSOR.map(([name, why]) => (
            <li key={name}>
              <strong>{name}</strong>: {why}
            </li>
          ))}
        </ul>
      </section>
      <AgentsLive stack={stack} />
      <div className="stk-grid">
        <ModelsCard
          platform={platform.data}
          runUsage={usageOfRun(raw.usage)}
          runKind={runKind}
          platformKind={platform.data ? "live" : "none"}
        />
        <PoolCard
          run={run}
          kind={runKind}
          live={live}
          maxConcurrent={rl ? rl.maxConcurrent : null}
          inFlight={rl ? rl.inFlight : null}
        />
        <ZetarisCard reads={reads} kind={runKind} runId={run?.runId ?? null} />
        <TavilyCard platform={platform.data} />
        <EnginesCard system={system.data} recalled={memoryRecall(raw)} recalledKind={runKind} />
        <CacheCard platform={platform.data} system={system.data} />
        <RateLimitCard platform={platform.data} />
      </div>
    </div>
  );
}
