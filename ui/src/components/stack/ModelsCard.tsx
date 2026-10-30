import type { PlatformStatus } from "../../api/platform";
import { modelDisplay } from "../../lib/techTrace";
import { perM, regionBadge, usd } from "../../lib/sponsors";
import "../../styles/sponsors.css";
import type { DataKind, UsageView } from "../../lib/stack";
import { CountUp, DataBadge, Empty, StackCard, ms } from "./StackBits";

export const BACKEND_NAMES: Record<string, string> = {
  nebius: "Nebius Token Factory",
  nightshift: "Meterless Nightshift gateway",
};

const LANE_NOTE: Record<string, string> = {
  fast: "Fast lane: quick answers, Skeptic, Judge checks",
  deep: "Deep lane: long reasoning over the evidence",
};

/** Lanes to draw: fast and deep first, then any other lane named by the data. */
export function laneKeys(platform: PlatformStatus | null, usage: UsageView | null): string[] {
  const seen = new Set<string>(["fast", "deep"]);
  for (const k of Object.keys(platform?.lanes ?? {})) seen.add(k);
  for (const l of usage?.lanes ?? []) seen.add(l.lane);
  return [...seen];
}

export function ModelsCard({
  platform,
  runUsage,
  runKind,
  platformKind,
}: {
  platform: PlatformStatus | null;
  /** usage of the shown run, when its body carries it. */
  runUsage: UsageView | null;
  runKind: DataKind;
  /** What the platform status is: live when fetched, none when the API did not answer. */
  platformKind: DataKind;
}) {
  const poolUsage = runUsage;
  // Card badge: the live platform status when reachable, else what the counters came from. Values carry their own badge below.
  const kind: DataKind = platform ? "live" : poolUsage ? runKind : platformKind;
  const usage = poolUsage;
  const processUsage = !poolUsage && platform?.llmUsage ? platform.llmUsage : null;
  const backend = platform?.llmBackend ?? null;
  return (
    <StackCard
      id="stk-models"
      title="Nebius Token Factory + NVIDIA Nemotron"
      role="Every agent sentence is written by a Nemotron model. The backend hosts the models; two lanes trade speed for depth."
      kind={kind}
    >
      <div className="stk-flow" aria-hidden="true">
        <span className="stk-node">Agents</span>
        <span className={`stk-wire${usage || processUsage ? " stk-wire--on" : ""}`}>
          <i />
          <i />
          <i />
        </span>
        <span className="stk-node stk-node--accent">{backend ? BACKEND_NAMES[backend] ?? backend : "backend n/a"}</span>
      </div>
      <p className="stk-fact">
        Backend:{" "}
        <strong>{backend ? BACKEND_NAMES[backend] ?? backend : "not reported (API not reached)"}</strong>
        {platform?.llmCheck && <> · last lane check {platform.llmCheck.ok ? "passed" : "failed"}</>}
      </p>
      <div className="stk-lanes">
        {laneKeys(platform, usage).map((lane) => {
          const u = usage?.lanes.find((l) => l.lane === lane) ?? null;
          const pu = processUsage?.lanes[lane] ?? null;
          const modelId = u?.modelIds[0] ?? platform?.lanes[lane] ?? platform?.llmCheck?.lanes[lane]?.modelId ?? null;
          const lat = platform?.latency[lane];
          const price = platform?.llmUsage?.pricing?.[lane] ?? null;
          const region = regionBadge(price);
          const modelFromRun = !!u?.modelIds[0];
          const countKind: DataKind = u ? runKind : pu ? "live" : "none";
          const calls = u?.calls ?? pu?.calls ?? null;
          const tokens = u?.totalTokens ?? pu?.totalTokens ?? null;
          const avg = u?.avgLatencyMs ?? pu?.avgLatencyMs ?? null;
          return (
            <article key={lane} className={`stk-lane stk-lane--${lane}`} aria-label={`${lane} lane`}>
              <h3 className="stk-lane-h">{lane} lane</h3>
              <p className="stk-model" title={modelId ?? undefined}>
                {modelId ? modelDisplay(modelId) : "model not reported"}
              </p>
              <p className="stk-mono">
                {modelId ?? ""} {modelId && <DataBadge kind={modelFromRun ? runKind : "live"} />}
              </p>
              <p className="stk-note">{LANE_NOTE[lane] ?? "Extra lane"}</p>
              {price && (
                <p className="stk-note" data-pricing={lane}>
                  {perM(price.pricePerMInput)} in / {perM(price.pricePerMOutput)} out per 1M tokens
                  {price.rpmLimit !== null && <> · {price.rpmLimit} req/min</>}
                  {price.tpmLimit !== null && <> · {price.tpmLimit.toLocaleString("en")} tokens/min</>}
                  {region && <span className="stk-region" title="Region from the official model list">{region}</span>}
                </p>
              )}
              <p className="stk-note">
                Counters: <DataBadge kind={countKind} />
              </p>
              <dl className="stk-kv">
                <div>
                  <dt>Calls</dt>
                  <dd>{calls === null ? "n/a" : <CountUp value={calls} />}</dd>
                </div>
                <div>
                  <dt>Tokens</dt>
                  <dd>{tokens === null ? "n/a" : <CountUp value={tokens} />}</dd>
                </div>
                <div>
                  <dt>Avg latency</dt>
                  <dd>{ms(avg)}</dd>
                </div>
                <div>
                  <dt>p50 / p95</dt>
                  <dd>{lat && lat.n > 0 ? `${ms(lat.p50Ms)} / ${ms(lat.p95Ms)}` : "n/a"}</dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
      {usage ? (
        <p className="stk-note">
          Counters are this run's model calls ({usage.totalCalls} calls, {usage.totalTokens.toLocaleString("en")} tokens
          {usage.costUsd === null ? ", price not configured" : `, run cost ${usd(usage.costUsd)}`}).
          {platform?.llmUsage?.costPerAnswerUsd != null && <> Cost per answer so far: {usd(platform.llmUsage.costPerAnswerUsd)} over {platform.llmUsage.answers} answers.</>}
        </p>
      ) : processUsage ? (
        <p className="stk-note">
          Counters are all calls since the agents process started (the shown run carries no usage).
          {processUsage.costUsd !== null && <> Cost so far {usd(processUsage.costUsd)}</>}
          {processUsage.costPerAnswerUsd !== null && <>, {usd(processUsage.costPerAnswerUsd)} per answer over {processUsage.answers} answers</>}
          {processUsage.costUsd !== null && "."}
        </p>
      ) : (
        <Empty>No token counters yet. They appear once a run has called a model.</Empty>
      )}
    </StackCard>
  );
}
