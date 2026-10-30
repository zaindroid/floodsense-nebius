import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { adoptView, markBatchSeed } from "../api/adopt";
import { loadLiveViews } from "../api/client";
import {
  DEFAULT_DATE,
  DEFAULT_POINT_ID,
  FIXTURE_DETAILS,
  SIM_PLAY_INTERVAL_MS,
  SIM_WINDOW_END,
  SIM_WINDOW_START,
  SIMULATED_ALERT_M3S,
} from "../config/scenario";
import { loadFixtures, type FixtureBundle } from "../fixtures/load";
import { datesOf, isModelledGlofasSource, pointById, pointsCrossing, rowAt } from "../lib/series";
import { formatDay } from "../lib/format";
import type { AskContext } from "../lib/askContext";
import { setDemoFlag } from "../lib/demo";
import { parseModeSearch, writeModeToUrl, type LiveHealth, type Mode, type ModeState } from "../lib/mode";
import { parseHash, routeHref, type DeskRoute, type PageId } from "../lib/route";
import { AHR_DEFAULT_DATE, screenContextFor, DEFAULT_EVENT_ID, type EventId } from "../lib/events";
import type { Answer, Approval, ApprovalStatus } from "../types/contract";
import type { EvidenceTopic, Notice, RouteId } from "../types/ui";
import type { Reference } from "../lib/references";
import type { LiveEvidence } from "../lib/liveEvidence";
import type {
  DataOrigin,
  DischargeDailyRow,
  ExposureJoinRow,
  HazardTimelineRow,
  ProvenanceRow,
  ValenciaPoint,
} from "../types/views";

interface ViewSlice<T> {
  rows: T;
  origin: DataOrigin;
  detail: string;
}

export interface ConsoleValue {
  route: RouteId;
  page: PageId;
  /** Same as route and page, as one union so a page switch can narrow it. */
  deskRoute: DeskRoute;
  healthOk: boolean;
  healthDetail: string;
  discharge: ViewSlice<DischargeDailyRow[]>;
  hazard: ViewSlice<HazardTimelineRow[]>;
  exposure: ViewSlice<ExposureJoinRow[]>;
  provenance: ViewSlice<ProvenanceRow[]>;
  points: ValenciaPoint[];
  answer: Answer;
  dates: string[];
  date: string;
  setDate: (date: string) => void;
  pointId: string;
  setPointId: (pointId: string) => void;
  /** The global mode: "live" (the live watch) or "past" (the replay of `eventId`). Every page obeys it. */
  mode: Mode;
  /** The past flood chosen for Past mode (header picker). Kept in Live so switching back remembers it. */
  eventId: EventId;
  /** Choose the past flood; in Live this also switches to Past mode. */
  setEventId: (eventId: EventId) => void;
  setMode: (mode: Mode) => void;
  /** mode + eventId + demo, as written to the URL query. */
  modeState: ModeState;
  /** Demo data: the live fetchers read the bundled snapshot instead. A "DEMO DATA" chip shows wherever it is on. */
  demo: boolean;
  setDemo: (on: boolean) => void;
  /** True once the API health probe answered or failed (not while it is still running). */
  healthChecked: boolean;
  /** Oldest fetch time of the live views on screen (ms), for "Live data · checked HH:MM". Null until loaded. */
  liveCheckedAt: number | null;
  reportChecked: (ms: number) => void;
  /** How much of the live watch loaded, and which views failed. Drives the strip, the partial-outage note and the demo offer. */
  liveHealth: LiveHealth | null;
  reportLiveHealth: (health: LiveHealth) => void;
  /** Ahr (EMSR517) map date and point, kept here so they survive a remount of Sites / map. */
  ahrDate: string;
  setAhrDate: (date: string) => void;
  ahrPointId: string;
  setAhrPointId: (pointId: string) => void;
  evidenceOpen: boolean;
  evidenceTopic: EvidenceTopic;
  openEvidence: (topic: EvidenceTopic) => void;
  /** One numbered source shown in full in the Evidence drawer; null when the drawer shows the topic view. */
  evidenceSource: Reference | null;
  openSource: (ref: Reference) => void;
  closeEvidence: () => void;
  /** Evidence for one live data point; null when the drawer shows the replay evidence. */
  liveEvidence: LiveEvidence | null;
  openLiveEvidence: (evidence: LiveEvidence) => void;
  /** Citizen place (lib/places.ts id); null is "Right now, anywhere in our watch". */
  placeId: string | null;
  setPlaceId: (placeId: string | null) => void;
  /** Ask FloodSense popup. Closed at start. A route change never opens it. */
  askOpen: boolean;
  /** Opens the popup. A string pre-fills the composer; it is never sent on its own. */
  openAsk: (prefill?: unknown, context?: AskContext) => void;
  /** Page context the last openAsk carried (e.g. the disaster replay moment). Merged over screenContext(). */
  askContext: AskContext | null;
  /** Role, page and selected point, for the `context` of an Ask request. */
  screenContext: () => AskContext;
  /** Text waiting to be put in the composer, then cleared by the popup. */
  askPrefill: string | null;
  clearAskPrefill: () => void;
  closeAsk: () => void;
  approval: Approval;
  decide: (status: ApprovalStatus, note: string) => void;
  resetApproval: () => void;
  notices: Notice[];
  markNotificationsRead: () => void;
  playing: boolean;
  playSimulation: () => void;
  stopSimulation: () => void;
}

const ConsoleContext = createContext<ConsoleValue | null>(null);

/** Reads the hash and rewrites it to the canonical href, so `#/insurer` and #36 hashes settle on one page. */
function readRoute(approvalPending: boolean): DeskRoute {
  const route = parseHash(window.location.hash, approvalPending);
  const href = routeHref(route.role, route.page);
  if (window.location.hash !== href) window.history.replaceState(null, "", href);
  return route;
}

function initialApproval(answer: Answer): Approval {
  const action = answer.playbook_actions?.[0];
  return {
    approval_id: "apr_fixture_valencia",
    run_id: answer.run_id,
    action_id: action?.action_id ?? "act_fixture_review_footprint",
    status: "pending",
    judge: answer.judge,
  };
}

function slice<T>(rows: T, detail: string): ViewSlice<T> {
  return { rows, origin: "fixture", detail };
}

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const bundle = useMemo<FixtureBundle | { error: string }>(() => {
    try {
      return loadFixtures();
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Fixtures failed to load." };
    }
  }, []);

  if ("error" in bundle) {
    return (
      <p className="boot-error" role="alert">
        {bundle.error}
      </p>
    );
  }

  return <ReadyConsole bundle={bundle}>{children}</ReadyConsole>;
}

function ReadyConsole({ bundle, children }: { bundle: FixtureBundle; children: ReactNode }) {
  const [deskRoute, setDeskRoute] = useState<DeskRoute>(() => parseHash(window.location.hash));
  const [healthOk, setHealthOk] = useState(false);
  const [healthDetail, setHealthDetail] = useState("Checking API health. Rows on screen are fixtures until a view route answers.");
  const [discharge, setDischarge] = useState<ViewSlice<DischargeDailyRow[]>>(
    slice(bundle.discharge, FIXTURE_DETAILS.discharge_daily),
  );
  const [hazard, setHazard] = useState<ViewSlice<HazardTimelineRow[]>>(
    slice(bundle.hazard, FIXTURE_DETAILS.hazard_timeline),
  );
  const [exposure, setExposure] = useState<ViewSlice<ExposureJoinRow[]>>(
    slice(bundle.exposure, FIXTURE_DETAILS.exposure_join),
  );
  const [provenance, setProvenance] = useState<ViewSlice<ProvenanceRow[]>>(
    slice(bundle.provenance, FIXTURE_DETAILS.provenance),
  );
  const dates = useMemo(() => datesOf(discharge.rows), [discharge.rows]);
  const [date, setDateState] = useState(DEFAULT_DATE);
  const [pointId, setPointId] = useState(DEFAULT_POINT_ID);
  const [modeInit] = useState(() => {
    const initial = parseModeSearch(window.location.search);
    setDemoFlag(initial.demo);
    return initial;
  });
  const [mode, setModeState] = useState<Mode>(modeInit.mode);
  const [demo, setDemoState] = useState(modeInit.demo);
  const [eventId, setEventIdState] = useState<EventId>(modeInit.eventId ?? DEFAULT_EVENT_ID);
  const [healthChecked, setHealthChecked] = useState(false);
  const [liveCheckedAt, setLiveCheckedAt] = useState<number | null>(null);
  const [liveHealth, setLiveHealth] = useState<LiveHealth | null>(null);
  const [ahrDate, setAhrDate] = useState(AHR_DEFAULT_DATE);
  const [ahrPointId, setAhrPointId] = useState("AHR01");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceTopic, setEvidenceTopic] = useState<EvidenceTopic>("discharge");
  const [evidenceSource, setEvidenceSource] = useState<Reference | null>(null);
  const [liveEvidence, setLiveEvidence] = useState<LiveEvidence | null>(null);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askPrefill, setAskPrefill] = useState<string | null>(null);
  const [approval, setApproval] = useState<Approval>(() => initialApproval(bundle.answer));
  const approvalPendingRef = useRef(true);
  approvalPendingRef.current = approval.status === "pending";
  const [notices, setNotices] = useState<Notice[]>([]);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const playUntilRef = useRef(SIM_WINDOW_END);
  const raisedFor = useRef(new Set<string>());
  const previousDate = useRef(date);
  const setDate = useCallback((next: string) => {
    setDateState(next);
  }, []);

  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    setPlaceId(null);
  }, []);
  const setEventId = useCallback((next: EventId) => {
    setEventIdState(next);
    setModeState("past");
    setPlaceId(null);
  }, []);
  const setDemo = useCallback((on: boolean) => {
    // The module flag flips first, so the fetchers that run after this render already read the snapshot.
    setDemoFlag(on);
    setDemoState(on);
    setLiveCheckedAt(null);
  }, []);
  const reportChecked = useCallback((ms: number) => setLiveCheckedAt((prev) => (prev === ms ? prev : ms)), []);
  const reportLiveHealth = useCallback((h: LiveHealth) => setLiveHealth(h), []);
  const modeState = useMemo<ModeState>(() => ({ mode, eventId, demo }), [mode, eventId, demo]);
  useEffect(() => {
    writeModeToUrl(modeState);
  }, [modeState]);

  useEffect(() => {
    const onHash = () => setDeskRoute(readRoute(approvalPendingRef.current));
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Back / Forward: an entry can differ in the query (mode) as well as the hash (page), and Chrome fires only
  // popstate for that, so re-read both from the URL.
  useEffect(() => {
    const onPop = () => {
      const m = parseModeSearch(window.location.search);
      setDemoFlag(m.demo);
      setDemoState(m.demo);
      setModeState(m.mode);
      setEventIdState(m.eventId);
      setPlaceId(null);
      setDeskRoute(readRoute(approvalPendingRef.current));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    setEvidenceOpen(false);
  }, [deskRoute]);

  useEffect(() => {
    if (dates.length > 0 && !dates.includes(date)) setDateState(dates[0]);
  }, [dates, date]);

  useEffect(() => {
    let cancelled = false;
    if (demo) {
      // Demo data: the replay views stay on the bundled fixtures too, so nothing is read from the API.
      setHealthOk(false);
      setHealthChecked(true);
      setHealthDetail("Demo data is on. Rows on screen are bundled fixtures.");
      setDischarge(slice(bundle.discharge, FIXTURE_DETAILS.discharge_daily));
      setHazard(slice(bundle.hazard, FIXTURE_DETAILS.hazard_timeline));
      setExposure(slice(bundle.exposure, FIXTURE_DETAILS.exposure_join));
      setProvenance(slice(bundle.provenance, FIXTURE_DETAILS.provenance));
      return () => {
        cancelled = true;
      };
    }
    setHealthChecked(false);
    loadLiveViews().then((live) => {
      if (cancelled) return;
      setHealthChecked(true);
      setHealthOk(live.health.ok);
      setHealthDetail(live.health.detail);
      const take = <T,>(parsed: T[] | null, miss: string, fixtureRows: T[], fixtureDetail: string) =>
        adoptView({
          healthOk: live.health.ok,
          parsed,
          fixtureRows,
          fixtureDetail,
          missDetail: miss,
        });
      const dischargeSlice = take(
        live.discharge_daily,
        live.details.discharge_daily,
        bundle.discharge,
        FIXTURE_DETAILS.discharge_daily,
      );
      setDischarge(dischargeSlice);
      setHazard(
        markBatchSeed(
          dischargeSlice,
          take(live.hazard_timeline, live.details.hazard_timeline, bundle.hazard, FIXTURE_DETAILS.hazard_timeline),
        ),
      );
      setExposure(
        markBatchSeed(
          dischargeSlice,
          take(live.exposure_join, live.details.exposure_join, bundle.exposure, FIXTURE_DETAILS.exposure_join),
        ),
      );
      setProvenance(
        markBatchSeed(
          dischargeSlice,
          take(live.provenance, live.details.provenance, bundle.provenance, FIXTURE_DETAILS.provenance),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [demo]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setDateState((current) => {
        if (current >= playUntilRef.current) return current;
        const index = dates.indexOf(current);
        return dates[index + 1] ?? current;
      });
    }, SIM_PLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, dates]);

  useEffect(() => {
    const before = previousDate.current;
    previousDate.current = date;
    if (!playingRef.current) return;
    if (before < date) {
      const ids = pointsCrossing(discharge.rows, before, date, SIMULATED_ALERT_M3S);
      const key = `${date}:${ids.join(",")}`;
      if (ids.length > 0 && !raisedFor.current.has(key)) {
        raisedFor.current.add(key);
        const names = ids.map((id) => {
          const point = pointById(bundle.points, id);
          return point ? `${id} ${point.name}` : id;
        });
        const sources = ids.map((id) => rowAt(discharge.rows, id, date)?.source ?? "");
        const modelled = sources.length > 0 && sources.every((source) => isModelledGlofasSource(source));
        const what = modelled ? "Modelled GloFAS discharge" : "Discharge";
        setNotices((list) => [
          {
            id: `sim-${key}`,
            tone: "sim",
            read: false,
            title: "Simulated alert",
            body: `${what} crossed ${SIMULATED_ALERT_M3S} m³/s on ${formatDay(date)} at ${names.join(", ")}. Simulation only. Not an official warning.`,
          },
          ...list,
        ]);
      }
    }
    if (date >= playUntilRef.current) setPlaying(false);
  }, [date, discharge.rows, bundle.points]);

  const openEvidence = useCallback((topic: EvidenceTopic) => {
    setEvidenceTopic(topic);
    setEvidenceSource(null);
    setLiveEvidence(null);
    setEvidenceOpen(true);
  }, []);

  const openSource = useCallback((ref: Reference) => {
    setLiveEvidence(null);
    setEvidenceSource(ref);
    setEvidenceOpen(true);
  }, []);

  const openLiveEvidence = useCallback((evidence: LiveEvidence) => {
    setEvidenceSource(null);
    setLiveEvidence(evidence);
    setEvidenceOpen(true);
  }, []);

  const closeEvidence = useCallback(() => setEvidenceOpen(false), []);

  // onClick handlers pass the click event; only a string is a pre-fill.
  const [askContext, setAskContext] = useState<AskContext | null>(null);
  const openAsk = useCallback((prefill?: unknown, context?: AskContext) => {
    if (typeof prefill === "string" && prefill.trim()) setAskPrefill(prefill);
    // Only a call that names a context sets it; a plain open clears a stale replay moment.
    setAskContext(context && typeof context === "object" && !("nativeEvent" in context) ? context : null);
    setAskOpen(true);
  }, []);
  const clearAskPrefill = useCallback(() => setAskPrefill(null), []);

  const closeAsk = useCallback(() => setAskOpen(false), []);

  const screenContext = useCallback((): AskContext => {
    return screenContextFor(deskRoute, eventId, { date, pointId, points: bundle.points }, { date: ahrDate, pointId: ahrPointId }, mode);
  }, [bundle.points, pointId, deskRoute, eventId, date, ahrDate, ahrPointId, mode]);

  const decide = useCallback((status: ApprovalStatus, note: string) => {
    setApproval((current) => ({ ...current, status, note }));
  }, []);

  const resetApproval = useCallback(() => {
    setApproval(initialApproval(bundle.answer));
  }, [bundle.answer]);

  const markNotificationsRead = useCallback(() => {
    setNotices((list) => (list.some((notice) => !notice.read) ? list.map((notice) => ({ ...notice, read: true })) : list));
  }, []);

  const stopSimulation = useCallback(() => setPlaying(false), []);

  const playSimulation = useCallback(() => {
    if (playingRef.current) {
      setPlaying(false);
      return;
    }
    if (dates.length < 2) return;
    setNotices((list) => list.filter((notice) => notice.tone !== "sim"));
    raisedFor.current.clear();
    const end = dates.includes(SIM_WINDOW_END) ? SIM_WINDOW_END : dates[dates.length - 1];
    playUntilRef.current = end;
    const start = dates.find((item) => item >= SIM_WINDOW_START && item < end) ?? dates[0];
    setDateState(start);
    setPlaying(true);
  }, [dates]);

  const value = useMemo<ConsoleValue>(
    () => ({
      route: deskRoute.role,
      page: deskRoute.page,
      deskRoute,
      healthOk,
      healthDetail,
      discharge,
      hazard,
      exposure,
      provenance,
      points: bundle.points,
      answer: bundle.answer,
      dates,
      date,
      setDate,
      pointId,
      setPointId,
      mode,
      eventId,
      setEventId,
      setMode,
      modeState,
      demo,
      setDemo,
      healthChecked,
      liveCheckedAt,
      reportChecked,
      liveHealth,
      reportLiveHealth,
      ahrDate,
      setAhrDate,
      ahrPointId,
      setAhrPointId,
      evidenceOpen,
      evidenceTopic,
      openEvidence,
      evidenceSource,
      openSource,
      closeEvidence,
      liveEvidence,
      openLiveEvidence,
      placeId,
      setPlaceId,
      askOpen,
      openAsk,
      askContext,
      screenContext,
      askPrefill,
      clearAskPrefill,
      closeAsk,
      approval,
      decide,
      resetApproval,
      notices,
      markNotificationsRead,
      playing,
      playSimulation,
      stopSimulation,
    }),
    [
      deskRoute,
      healthOk,
      healthDetail,
      discharge,
      hazard,
      exposure,
      provenance,
      bundle.points,
      bundle.answer,
      dates,
      date,
      setDate,
      pointId,
      mode,
      eventId,
      setEventId,
      setMode,
      modeState,
      demo,
      setDemo,
      healthChecked,
      liveCheckedAt,
      reportChecked,
      liveHealth,
      reportLiveHealth,
      ahrDate,
      ahrPointId,
      evidenceOpen,
      evidenceTopic,
      openEvidence,
      evidenceSource,
      openSource,
      closeEvidence,
      liveEvidence,
      openLiveEvidence,
      placeId,
      setPlaceId,
      askOpen,
      openAsk,
      askContext,
      screenContext,
      askPrefill,
      clearAskPrefill,
      closeAsk,
      approval,
      decide,
      resetApproval,
      notices,
      markNotificationsRead,
      playing,
      playSimulation,
      stopSimulation,
    ],
  );

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

/** The console, or null outside the provider (components that also render standalone). */
export function useConsoleMaybe(): ConsoleValue | null {
  return useContext(ConsoleContext);
}

export function useConsole(): ConsoleValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("useConsole must be used inside ConsoleProvider");
  return value;
}
