import "../../styles/sponsors.css";
import type { PlatformStatus } from "../../api/platform";
import { WEB_NOT_WARNING } from "../../lib/sponsors";
import { CountUp, Empty, StackCard, ms } from "./StackBits";

const LAST: Record<string, string> = { ok: "ok", empty: "no results", unavailable: "unavailable" };

/** Tavily: live web evidence for the Skeptic. All numbers are /platform/status counters; the dots move only when that status is LIVE and Tavily is on. */
export function TavilyCard({ platform }: { platform: PlatformStatus | null }) {
  const t = platform?.tavilyStatus ?? null;
  const live = !!platform && !!t?.enabled;
  return (
    <StackCard
      id="stk-tavily"
      title="Tavily"
      role="Live web evidence. The Skeptic checks the main statement against a web search; complementary to Zetaris, which runs SQL on sensor and portfolio data."
      kind={platform ? "live" : "none"}
    >
      <div className="stk-flow" aria-hidden="true">
        <span className="stk-node">Skeptic</span>
        <span className={`stk-wire${live ? " stk-wire--on" : ""}`}>
          <i />
          <i />
        </span>
        <span className={`stk-node${live ? " is-lit" : ""}`}>Web search</span>
      </div>
      {!platform ? (
        <Empty>Platform status not reachable, so no Tavily numbers.</Empty>
      ) : !t ? (
        <Empty>This agents build reports no Tavily counters.</Empty>
      ) : (
        <>
          <p className="stk-fact">
            {t.enabled ? "Switched on" : t.keyConfigured ? "Switched off (a key is set)" : "Switched off (no key set)"}
            {live && (
              <span className="stk-search" role="img" aria-label="web search active">
                <i />
                <i />
                <i />
              </span>
            )}
          </p>
          <dl className="stk-kv stk-kv--3">
            <div>
              <dt>Calls</dt>
              <dd>
                <CountUp value={t.calls} />
              </dd>
            </div>
            <div>
              <dt>Cache hits</dt>
              <dd>
                <CountUp value={t.cacheHits} />
              </dd>
            </div>
            <div>
              <dt>Avg latency</dt>
              <dd>{ms(t.avgLatencyMs)}</dd>
            </div>
            <div>
              <dt>Last status</dt>
              <dd>{t.lastStatus ? LAST[t.lastStatus] : "n/a"}</dd>
            </div>
          </dl>
          {t.lastError && <p className="stk-note stk-warn">Last error: {t.lastError}</p>}
        </>
      )}
      <p className="stk-note">{WEB_NOT_WARNING}.</p>
    </StackCard>
  );
}
