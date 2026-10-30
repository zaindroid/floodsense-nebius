import { useEffect, useState, useSyncExternalStore } from "react";
import { heartbeat } from "../lib/heartbeat";
import { getPlatformSnap, subscribePlatform } from "../lib/platformStore";

/** Header heartbeat: pulses only while the real status poll is fresh. Re-evaluates staleness every 30 s, nothing faster. */
export function AgentHeartbeat() {
  const snap = useSyncExternalStore(subscribePlatform, getPlatformSnap, getPlatformSnap);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const h = heartbeat(snap.status, snap.at, Math.max(now, snap.at));
  return (
    <p className={`beat beat--${h.state}`} data-heartbeat={h.state}>
      <span className="beat__dot" aria-hidden="true" />
      {h.text}
    </p>
  );
}
