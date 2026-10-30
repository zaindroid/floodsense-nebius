import type { PlatformStatus } from "../../api/platform";
import { hitRateOf, ringDash, type DataKind } from "../../lib/stack";
import type { SystemStatus } from "../../lib/system";
import { CountUp, Empty, StackCard } from "./StackBits";

const R = 42;

export function CacheCard({ platform, system }: { platform: PlatformStatus | null; system: SystemStatus | null }) {
  const hits = platform?.cache.hits ?? system?.cache.hits ?? null;
  const misses = platform?.cache.misses ?? system?.cache.misses ?? null;
  const rate = platform?.cache.hitRate ?? (hits !== null && misses !== null ? hitRateOf(hits, misses) : null);
  const kind: DataKind = platform || system ? "live" : "none";
  return (
    <StackCard
      id="stk-cache"
      title="Redis cache"
      role="A repeated question is answered from Redis instead of running the agents again. Such an answer is labelled cached."
      kind={kind}
    >
      {hits === null || misses === null ? (
        <Empty>Cache counters not reported (API not reached).</Empty>
      ) : (
        <div className="stk-cache">
          <svg viewBox="0 0 100 100" width="120" height="120" role="img" aria-label={rate === null ? "Hit rate: no lookups yet" : `Hit rate ${Math.round(rate * 100)} percent`}>
            <circle cx="50" cy="50" r={R} className="stk-ring-bg" />
            <circle cx="50" cy="50" r={R} className="stk-ring" strokeDasharray={ringDash(rate, R)} transform="rotate(-90 50 50)" />
            <text x="50" y="55" textAnchor="middle" className="stk-ring-t">
              {rate === null ? "n/a" : `${Math.round(rate * 100)}%`}
            </text>
          </svg>
          <dl className="stk-kv">
            <div>
              <dt>Hits</dt>
              <dd>
                <CountUp value={hits} />
              </dd>
            </div>
            <div>
              <dt>Misses</dt>
              <dd>
                <CountUp value={misses} />
              </dd>
            </div>
            <div>
              <dt>Answer keys</dt>
              <dd>{system?.cache.keys.cache ?? "n/a"}</dd>
            </div>
            <div>
              <dt>Replay keys</dt>
              <dd>{system?.cache.keys.replay ?? "n/a"}</dd>
            </div>
          </dl>
        </div>
      )}
      <p className="stk-note">
        Backend: {platform?.cache.backend ?? system?.cache.backend ?? "n/a"}. Replay cache: {system ? `${system.cache.replays} recorded runs served` : "n/a"}; a replay is a stored run
        shown again, never a new one.
      </p>
    </StackCard>
  );
}
