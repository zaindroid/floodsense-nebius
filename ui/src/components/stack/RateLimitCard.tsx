import type { PlatformStatus } from "../../api/platform";
import { slotLights } from "../../lib/stack";
import { CountUp, Empty, StackCard } from "./StackBits";

export function RateLimitCard({ platform }: { platform: PlatformStatus | null }) {
  const rl = platform?.rateLimit ?? null;
  const slots = rl ? slotLights(rl.inFlight, rl.maxConcurrent) : [];
  return (
    <StackCard
      id="stk-limits"
      title="Rate limiting"
      role="Protects the models. Only a few full runs may work at once; extra ones get a 429 with a Retry-After wait."
      kind={rl ? "live" : "none"}
    >
      {!rl ? (
        <Empty>Limits not reported (API not reached).</Empty>
      ) : (
        <>
          <div className="stk-slots" role="img" aria-label={`${rl.inFlight} of ${rl.maxConcurrent} run slots in use`}>
            {slots.map((on, i) => (
              <span key={i} className={on ? "stk-slot is-on" : "stk-slot"} />
            ))}
          </div>
          <p className="stk-fact">
            <strong>
              {rl.inFlight} of {rl.maxConcurrent}
            </strong>{" "}
            run slots in use
          </p>
          <dl className="stk-kv">
            <div>
              <dt>Runs per minute (per client)</dt>
              <dd>{rl.runsPerMin}</dd>
            </div>
            <div>
              <dt>429 recently</dt>
              <dd>
                <CountUp value={rl.recent429} />
              </dd>
            </div>
            <div>
              <dt>429 in total</dt>
              <dd>
                <CountUp value={rl.total429} />
              </dd>
            </div>
          </dl>
          <p className="stk-note">After a 429 the page waits for the Retry-After seconds, then asks again (backoff). A cached answer never takes a slot.</p>
        </>
      )}
    </StackCard>
  );
}
