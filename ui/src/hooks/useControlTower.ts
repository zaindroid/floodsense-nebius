import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWatchEvents, fetchWatchStatus, postAutoAssess, postScan, subscribeWatch } from "../api/watch";
import demo from "../fixtures/watchDemo.json";
import { useConsole } from "../context/ConsoleContext";
import { announcement, asWatchStatus, mergeEvents, parseEvents, type WatchEvent, type WatchStatus } from "../lib/controlTower";

const STATUS_POLL_MS = 10_000;
const EVENTS_POLL_MS = 8_000;

export interface DemoFeed {
  recordedAt: string;
  note: string;
}

export interface ControlTowerState {
  /** null until the first answer; false when the status route does not answer. */
  reachable: boolean | null;
  status: WatchStatus | null;
  /** Oldest first. */
  events: WatchEvent[];
  /** Ids that arrived after the first load: they animate in. */
  fresh: ReadonlySet<string>;
  streaming: boolean;
  scanning: boolean;
  /** One line about the last press of Scan now (or why it was refused). */
  scanNote: string | null;
  switching: boolean;
  /** Polite, rare announcement for a screen reader; "" when none. */
  announce: string;
  mode: "demo" | "live";
  /** Demo mode only: the live agents service did not answer a one-off probe. */
  liveDown: boolean;
  /** Recorded demo data is shown instead of a live feed. */
  demo: DemoFeed | null;
  showDemo: () => void;
  scanNow: () => void;
  setAutoAssess: (enabled: boolean) => void;
  reload: () => void;
}

export function useControlTower(): ControlTowerState {
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [streaming, setStreaming] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [demoFeed, setDemoFeed] = useState<DemoFeed | null>(null);
  const [liveDown, setLiveDown] = useState(false);
  const [tick, setTick] = useState(0);
  const loaded = useRef(false);
  const known = useRef<Set<string>>(new Set());
  const latest = useRef<string | null>(null);
  const lastAnnounce = useRef(0);
  // The global Demo data switch decides; the page no longer reads its own ?mode=demo.
  const { demo: demoOn } = useConsole();
  const mode: "demo" | "live" = demoOn ? "demo" : "live";

  const take = useCallback((incoming: WatchEvent[]) => {
    if (!incoming.length) return;
    const added = incoming.filter((e) => !known.current.has(e.id));
    for (const e of incoming) known.current.add(e.id);
    setEvents((prev) => {
      const next = mergeEvents(prev, incoming);
      latest.current = next.length ? next[next.length - 1].id : latest.current;
      return next;
    });
    if (loaded.current && added.length) {
      setFresh((prev) => new Set([...prev, ...added.map((e) => e.id)]));
      const now = Date.now();
      const said = announcement(added, lastAnnounce.current, now);
      if (said) {
        lastAnnounce.current = now;
        setAnnounce(said);
      }
    }
  }, []);

  // First load: status and the newest events.
  useEffect(() => {
    if (demoOn) return undefined;
    const ctrl = new AbortController();
    void (async () => {
      const [s, ev] = await Promise.all([fetchWatchStatus(ctrl.signal), fetchWatchEvents(null, 200, ctrl.signal)]);
      if (ctrl.signal.aborted) return;
      if (s.ok) {
        setStatus(s.value);
        setReachable(true);
      } else if (!ev.ok) {
        setReachable(false);
      }
      if (ev.ok) {
        setReachable(true);
        take(ev.value);
      }
      loaded.current = true;
    })();
    return () => ctrl.abort();
  }, [take, tick, demoOn]);

  // The agents came back after being down: load the feed again.
  const wasDown = useRef(false);
  useEffect(() => {
    if (reachable === false) wasDown.current = true;
    else if (reachable === true && wasDown.current) {
      wasDown.current = false;
      // Back from an outage (or from recorded demo data): start from nothing, then load the live feed.
      known.current = new Set();
      latest.current = null;
      loaded.current = false;
      setEvents([]);
      setFresh(new Set());
      setDemoFeed(null);
      setTick((t) => t + 1);
    }
  }, [reachable]);

  // Live stream; polling stands in while it is not open.
  useEffect(() => {
    if (reachable !== true || demoOn) return undefined;
    return subscribeWatch(latest.current, (e) => take([e]), setStreaming);
  }, [reachable, take, demoOn]);

  useEffect(() => {
    if (reachable === null || demoOn) return undefined;
    const ctrl = new AbortController();
    const poll = async () => {
      const s = await fetchWatchStatus(ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (s.ok) {
        setStatus(s.value);
        setReachable(true);
      } else if (s.error !== "aborted") {
        setReachable((prev) => (prev === true && s.status === null ? false : prev));
      }
    };
    const timer = window.setInterval(() => void poll(), STATUS_POLL_MS);
    return () => {
      ctrl.abort();
      window.clearInterval(timer);
    };
  }, [reachable, demoOn]);

  useEffect(() => {
    if (reachable !== true || streaming || demoOn) return undefined;
    const ctrl = new AbortController();
    const timer = window.setInterval(async () => {
      const ev = await fetchWatchEvents(latest.current, 100, ctrl.signal);
      if (ev.ok) take(ev.value);
    }, EVENTS_POLL_MS);
    return () => {
      ctrl.abort();
      window.clearInterval(timer);
    };
  }, [reachable, streaming, take, demoOn]);

  const scanNow = useCallback(() => {
    setScanning(true);
    setScanNote(null);
    void postScan().then(async (r) => {
      if (r.ok) {
        // 202: the scan runs on the agents. Follow its status until it ends (at most a minute).
        setStatus(r.value);
        setScanNote(null);
        for (let i = 0; i < 60; i += 1) {
          await new Promise((done) => setTimeout(done, 1000));
          const s = await fetchWatchStatus();
          if (s.ok) setStatus(s.value);
          const ev = await fetchWatchEvents(latest.current, 100);
          if (ev.ok) take(ev.value);
          if (s.ok && !s.value.scanning) break;
        }
      } else if (r.status === 429) {
        setScanNote(`Please wait ${r.retryAfterS ?? 5} s before scanning again.`);
      } else {
        setScanNote("The scan could not be started. The agents service did not answer.");
      }
      setScanning(false);
    });
  }, [take]);

  const setAutoAssess = useCallback(
    (enabled: boolean) => {
      setSwitching(true);
      void postAutoAssess(enabled).then(async (r) => {
        if (r.ok) {
          setStatus(r.value);
          const ev = await fetchWatchEvents(latest.current, 100);
          if (ev.ok) take(ev.value);
        } else {
          setScanNote(r.status === 429 ? `Please wait ${r.retryAfterS ?? 10} s before changing it again.` : "The switch could not be changed.");
        }
        setSwitching(false);
      });
    },
    [take],
  );

  const showDemo = useCallback(() => {
    const recorded = demo as { recorded_at: string; note: string; events: unknown; status: unknown };
    const evs = parseEvents({ events: recorded.events });
    known.current = new Set(evs.map((e) => e.id));
    latest.current = null;
    setFresh(new Set());
    setEvents(evs);
    setStatus(asWatchStatus(recorded.status));
    setDemoFeed({ recordedAt: recorded.recorded_at, note: recorded.note });
  }, []);

  // Demo data on: show the recorded feed (the agents are not asked); off again: start from nothing and load live.
  const wasDemo = useRef(false);
  useEffect(() => {
    if (demoOn) {
      wasDemo.current = true;
      setReachable(false);
      showDemo();
      const ctrl = new AbortController();
      void fetchWatchStatus(ctrl.signal).then((r) => {
        if (!ctrl.signal.aborted) setLiveDown(!r.ok);
      });
      return () => ctrl.abort();
    } else if (wasDemo.current) {
      wasDemo.current = false;
      known.current = new Set();
      latest.current = null;
      loaded.current = false;
      setEvents([]);
      setFresh(new Set());
      setDemoFeed(null);
      setStatus(null);
      setReachable(null);
      setTick((t) => t + 1);
    }
    return undefined;
  }, [demoOn, showDemo]);

  return {
    reachable,
    status,
    events,
    fresh,
    streaming,
    scanning,
    scanNote,
    switching,
    announce,
    mode,
    liveDown,
    demo: demoFeed,
    showDemo,
    scanNow,
    setAutoAssess,
    reload: () => {
      known.current = new Set();
      loaded.current = false;
      latest.current = null;
      setEvents([]);
      setReachable(null);
      setTick((t) => t + 1);
    },
  };
}
