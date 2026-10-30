import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadForecast, type ForecastLoad } from "../api/operatorForecast";
import { useConsole } from "../context/ConsoleContext";
import { useLiveWatch } from "../hooks/useLiveWatch";
import type { WatchSource } from "../lib/euWatch";
import { onTrackedRuns, runForKey, startAssessment, trackedLine, trackedRuns, type AssessOutcome, type TrackedRun } from "../lib/assessRuns";
import { relativeTime } from "../lib/now";
import {
  LANG_LABEL,
  badgeText,
  buildBrief,
  buildCallScript,
  buildRiverGroups,
  defaultGroup,
  escalationQuestion,
  focusSource,
  groupCountries,
  languagesFor,
  operatorContext,
  operatorRunKey,
  orderLine,
  sameRiverElsewhere,
  scriptSources,
  screeningView,
  splitForecastClaims,
  coverageOf,
  readingTime,
  type CallScript,
  type Coverage,
  type Lang,
  type ScriptLine,
  type ScriptSrc,
} from "../lib/operatorDesk";
import { basisLabel, calmSentence, countryName, headlineCounts, headlineText, plainOf } from "../lib/places";
import { numberRunReferences } from "../lib/references";
import { routeHref } from "../lib/route";
import { evidenceFor, StatusChip, timeText } from "./PlacesToWatch";
import { LiveSourceBadge } from "./LiveSources";
import { RefMarks } from "./RefMarks";
import "../styles/operator.css";

/*
 * TODO(#90, feat/mode-toggle-coherence): the global Live | Past mode and the Demo switch are not on main yet.
 * When merging #90: hide its ModeSwitch on the operator desk (or show "Live only"), and keep the operator early
 * return in screenContextFor, the operator branch in greetingFor and the operator filter in Approvals.
 * When ConsoleContext exposes the mode, show "Switch to Live to see this" here in Past mode (or the replay of the
 * chosen flood where one exists). Until then this desk is Live only: it reads the live views and the forecast lane.
 */

const FORECAST_TTL_MS = 10 * 60_000;
const forecastCache = new Map<string, ForecastLoad>();

type Outlook = { state: "idle" } | { state: "loading" } | ForecastLoad;

/** The forecast lane for the focused place: a deterministic run of about 1-2 s, cached for ten minutes per place. */
function useOutlook(source: WatchSource | null): { outlook: Outlook; refresh: () => void } {
  const [outlook, setOutlook] = useState<Outlook>({ state: "idle" });
  const [tick, setTick] = useState(0);
  const forced = useRef(0);
  const id = source?.id ?? null;
  useEffect(() => {
    if (!source || !id) {
      setOutlook({ state: "idle" });
      return;
    }
    const force = forced.current !== tick;
    forced.current = tick;
    const hit = forecastCache.get(id);
    if (!force && hit && hit.state === "ready" && Date.now() - hit.at < FORECAST_TTL_MS) {
      setOutlook(hit);
      return;
    }
    const controller = new AbortController();
    setOutlook({ state: "loading" });
    void loadForecast(source, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.state === "ready") forecastCache.set(id, result);
      setOutlook(result);
    });
    return () => controller.abort();
    // `source` is keyed by id: a refreshed reading of the same place must not restart the run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tick]);
  return { outlook, refresh: useCallback(() => setTick((t) => t + 1), []) };
}

function useTracked(): TrackedRun[] {
  const [runs, setRuns] = useState<TrackedRun[]>(() => trackedRuns());
  useEffect(() => onTrackedRuns(setRuns), []);
  return runs;
}

/** Civil protection: Situation board, call script and escalation for one river or place. */
export function OperatorSituation() {
  const live = useLiveWatch();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  const groups = useMemo(() => buildRiverGroups(live.sources), [live.sources]);
  const countries = useMemo(() => groupCountries(groups), [groups]);
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>("en");
  const group = groups.find((g) => g.key === groupKey) ?? defaultGroup(groups, live.sources);
  const focus = focusSource(group, pickedId);
  const { outlook, refresh } = useOutlook(focus);

  const loading = live.gauges.state === "loading" || live.euWatch.state === "loading" || live.hazard.state === "loading";
  const coverage = coverageOf(live.sources.length, [
    { name: "gauge_levels", state: live.gauges.state },
    { name: "eu_watch", state: live.euWatch.state },
    { name: "hazard_now", state: live.hazard.state === "ready" ? "rows" : live.hazard.state },
  ]);
  const country = group?.country ?? countries[0] ?? "";
  const countryGroups = groups.filter((g) => g.country === country);
  const langs = languagesFor(focus?.country ?? "DE");
  const activeLang: Lang = langs.includes(lang) ? lang : "en";

  return (
    <div className="op-page now-page">
      <header className="now-head">
        <div>
          <p className="eyebrow">Civil protection</p>
          <h2 className="now-title">Situation board</h2>
          <p className="now-meta">
            <span className="now-live-tag">Live data · Zetaris</span>
            {live.updatedAt ? ` Updated ${relativeTime(live.updatedAt, clock)}` : ""}
          </p>
        </div>
        <button type="button" className="now-refresh" onClick={live.refresh}>
          Refresh
        </button>
      </header>

      {!group || !focus ? (
        <p className="now-status" role="status">
          {loading
            ? "Loading the watched places…"
            : "No watched place could be read: the live views did not answer. Nothing is shown in its place. Try Refresh in a few minutes."}
        </p>
      ) : (
        <>
          <section className="card op-picker" aria-label="Choose a country and river">
            <label className="field">
              Country
              <select
                value={country}
                onChange={(event) => {
                  const next = groups.find((g) => g.country === event.target.value);
                  setGroupKey(next?.key ?? null);
                  setPickedId(null);
                }}
              >
                {countries.map((c) => (
                  <option key={c} value={c}>
                    {countryName(c)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              River or area
              <select
                value={group.key}
                onChange={(event) => {
                  setGroupKey(event.target.value);
                  setPickedId(null);
                }}
              >
                {countryGroups.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
            <p className={`note op-picker__counts${coverage.partial ? " op-partial" : ""}`} role={coverage.partial ? "alert" : undefined}>
              {coverage.partial && <strong>Partial data. </strong>}
              {coverage.text} {coverage.loaded > 0 ? `Of those: ${headlineText(headlineCounts(live.sources))}.` : ""}
            </p>
          </section>

          <section className="card" aria-labelledby="op-river">
            <p className="section-label">Status on the river</p>
            <h3 id="op-river" className="op-h">
              {group.river} · {countryName(group.country)}
            </h3>
            <p className="note">{orderLine(group)}</p>
            {sameRiverElsewhere(groups, group).length > 0 && (
              <p className="note">The {group.river} is also watched in {sameRiverElsewhere(groups, group).join(", ")}.</p>
            )}
            <ol className="op-river-list" aria-label={`${group.river} places, ${group.ordered === "km" ? "upstream to downstream" : "watch-list order"}`}>
              {group.sources.map((s, i) => (
                <RiverRow
                  key={s.id}
                  s={s}
                  n={i + 1}
                  selected={s.id === focus.id}
                  last={i === group.sources.length - 1}
                  evidence={evidenceFor(live, s)}
                  onPick={() => setPickedId(s.id)}
                />
              ))}
            </ol>
          </section>

          <FocusBrief
            s={focus}
            group={group}
            outlook={outlook}
            onRefresh={refresh}
            lang={activeLang}
            langs={langs}
            onLang={setLang}
            evidence={evidenceFor(live, focus)}
            coverage={coverage}
          />
        </>
      )}
      <p className="now-source">
        Quelle: WSV, PEGELONLINE (DL-DE-Zero-2.0) · Weather data by Open-Meteo.com (GloFAS, CC BY 4.0) · via Zetaris. Model-based screening, not an
        official warning.
      </p>
    </div>
  );
}

function RiverRow({
  s,
  n,
  selected,
  last,
  evidence,
  onPick,
}: {
  s: WatchSource;
  n: number;
  selected: boolean;
  last: boolean;
  evidence: ReturnType<typeof evidenceFor>;
  onPick: () => void;
}) {
  const view = plainOf(s);
  return (
    <li className={`op-row op-row--${view.tone}${selected ? " is-selected" : ""}`}>
      <button type="button" className="op-row__pick" aria-pressed={selected} onClick={onPick}>
        <span className="op-row__n" aria-hidden="true">
          {n}
        </span>
        <span className="op-row__name">{s.name}</span>
        <StatusChip view={view} />
      </button>
      <p className="note op-row__line">
        {timeText(s.kind, s.measuredAt)} · {basisLabel(s.kind)}{" "}
        <LiveSourceBadge n={n} evidence={evidence} />
      </p>
      {!last && (
        <span className="op-row__flow" aria-hidden="true">
          ↓
        </span>
      )}
    </li>
  );
}

function FocusBrief({
  s,
  group,
  outlook,
  onRefresh,
  lang,
  langs,
  onLang,
  evidence,
  coverage,
}: {
  coverage: Coverage;
  s: WatchSource;
  group: ReturnType<typeof buildRiverGroups>[number];
  outlook: Outlook;
  onRefresh: () => void;
  lang: Lang;
  langs: Lang[];
  onLang: (lang: Lang) => void;
  evidence: ReturnType<typeof evidenceFor>;
}) {
  const view = plainOf(s);
  const script = useMemo(() => buildCallScript(s, lang), [s, lang]);
  const measured = timeText(s.kind, s.measuredAt);

  const run = outlook.state === "ready" ? outlook.run : null;
  const refs = useMemo(() => (run ? numberRunReferences(run.claims, { scope: `op-${run.runId}`, eventId: run.eventId }) : null), [run]);
  const split = useMemo(() => (run ? splitForecastClaims(run.claims) : null), [run]);
  const numbered = (id: string) => refs?.claims.find((c) => c.id === id)?.refs ?? [];
  const marks = (id: string) => numbered(id).map((n) => `[R${n}]`).join("");

  const [copied, setCopied] = useState<string | null>(null);
  const copyBrief = async () => {
    const text = buildBrief({
      now: new Date(),
      source: s,
      group,
      measuredText: measured,
      evidence,
      coverage,
      forecast: outlook.state === "ready" ? outlook.brief : null,
      outlookLines: (split?.outlook ?? []).map((c) => `- ${c.text} ${marks(c.id)}`.trim()),
      historyLines: (split?.history ?? []).map((h) => `- ${h.heading}: ${h.claim.text} ${marks(h.claim.id)}`.trim()),
      runRefs: (refs?.refs ?? []).map(
        (r) => `[R${r.n}] ${r.heading}: ${r.title}${r.page !== null ? `, p. ${r.page}` : ""}${r.queryId ? ` · query ${r.queryId}` : ""}${r.link ? ` · ${r.link.href}` : ""}`,
      ),
      runQueryIds: [...new Set((run?.claims ?? []).flatMap((c) => c.citations.map((x) => x.queryId).filter((q): q is string => !!q)))],
      script,
    });
    setCopied(await writeClipboard(text));
  };

  return (
    <>
      <section className="card op-focus" aria-labelledby="op-focus-title">
        <p className="section-label">Brief for</p>
        <h3 id="op-focus-title" className="op-h">
          {s.river ? `${s.river} · ${s.name}` : s.name} <span className="muted small">{countryName(s.country)}</span>
        </h3>
        <p>
          <StatusChip view={view} large />
        </p>
        {s.live ? (
          <p>
            {calmSentence(s.kind, s.status, s.river, s.name)} <LiveSourceBadge n={1} evidence={evidence} />
          </p>
        ) : (
          <p className="op-partial note" role="alert">
            This reading is from {readingTime(s.measuredAt)} and may be out of date. Do not read it out as the current situation.{" "}
            <LiveSourceBadge n={1} evidence={evidence} />
          </p>
        )}
        <p className="note">
          {measured} · {basisLabel(s.kind)} · {s.live ? "live" : "not live (stale or seed)"}
        </p>
        <div className="button-row op-actions">
          <button type="button" className="button primary" onClick={() => void copyBrief()}>
            Copy brief
          </button>
          <span className="note" role="status" aria-live="polite">
            {copied ?? "Plain text: time, sources and query ids."}
          </span>
        </div>
      </section>

      <section className="card" aria-labelledby="op-outlook">
        <div className="op-head">
          <div>
            <p className="section-label">Next 48 hours</p>
            <h3 id="op-outlook" className="op-h">
              Outlook
            </h3>
          </div>
          <button type="button" className="button ghost" onClick={onRefresh} disabled={outlook.state === "loading"}>
            {outlook.state === "loading" ? "Checking…" : "Check again"}
          </button>
        </div>
        {outlook.state === "idle" || outlook.state === "loading" ? (
          <p className="note" role="status">
            Reading the forecast lane for {s.name}… (deterministic, no model call, about two seconds)
          </p>
        ) : outlook.state === "unavailable" ? (
          <p className="note" role="status">
            The outlook is not available: {outlook.message}
          </p>
        ) : (
          <>
            <p>
              <StatusChip view={screeningView(outlook.brief.status, outlook.brief.statusLabel)} /> <span className="muted small">FloodSense screening, not an official warning</span>
            </p>
            <p>{outlook.brief.lead}</p>
            <ul className="op-claims">
              {(split?.outlook ?? []).map((c) => (
                <li key={c.id}>
                  {c.text} {refs && <RefMarks nums={numbered(c.id)} refs={refs.refs} />}
                </li>
              ))}
            </ul>
            {outlook.brief.gaps.map((gap) => (
              <p key={gap} className="note">
                Gap: {gap}
              </p>
            ))}
            {outlook.brief.screening && <p className="note">{outlook.brief.screening}</p>}
            <p className="note">
              Run {outlook.brief.runId}
              {outlook.brief.servedFrom ? ` · ${outlook.brief.servedFrom === "live" ? "live" : `${outlook.brief.servedFrom}, not live`}` : ""}
              {outlook.brief.attribution ? ` · ${outlook.brief.attribution}` : ""}
            </p>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="op-history">
        <p className="section-label">What has happened here before</p>
        <h3 id="op-history" className="op-h">
          The past, with its source
        </h3>
        {outlook.state !== "ready" ? (
          <p className="note">{outlook.state === "unavailable" ? "Not available while the outlook is not." : "Loading…"}</p>
        ) : (split?.history.length ?? 0) === 0 ? (
          <p className="note">No earlier event is stored for this place.</p>
        ) : (
          <ul className="op-claims">
            {split?.history.map((h) => (
              <li key={h.claim.id}>
                <span className="eyebrow">{h.heading}</span>
                <br />
                {h.claim.text.length > 320 ? `${h.claim.text.slice(0, 320)}…` : h.claim.text} {refs && <RefMarks nums={numbered(h.claim.id)} refs={refs.refs} />}
              </li>
            ))}
          </ul>
        )}
        <p className="note">This is what happened, not a prediction for today.</p>
      </section>

      <CallScriptCard s={s} script={script} lang={lang} langs={langs} onLang={onLang} evidence={evidence} measured={measured} />

      <EscalateCard s={s} status={view.word} />
    </>
  );
}

async function writeClipboard(text: string): Promise<string> {
  try {
    await navigator.clipboard.writeText(text);
    return "Brief copied.";
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok ? "Brief copied." : "Copy was blocked by the browser. Select the script text and copy it by hand.";
    } catch {
      return "Copy was blocked by the browser. Select the script text and copy it by hand.";
    }
  }
}

const SRC_HEADING: Record<ScriptSrc, string> = {
  reading: "Data via Zetaris",
  rule: "FloodSense status rule",
  official: "Official warning services",
  house: "Call-script template",
};

function Badges({ src, evidence }: { src: readonly ScriptSrc[]; evidence: ReturnType<typeof evidenceFor> }) {
  const { openLiveEvidence } = useConsole();
  return (
    <span className="op-badges">
      {[...src]
        .sort((a, b) => badgeText([a]).localeCompare(badgeText([b])))
        .map((x) => {
          const n = badgeText([x]).replace(/[[\]]/g, "");
          return x === "reading" ? (
            <button
              key={x}
              type="button"
              className="citation-marker src-badge src-badge-zetaris"
              aria-label={`Source ${n}: ${SRC_HEADING[x]}. Opens the evidence panel`}
              onClick={() => openLiveEvidence(evidence)}
            >
              {n}
            </button>
          ) : (
            <span key={x} className="citation-marker src-badge op-badge" title={SRC_HEADING[x]} role="img" aria-label={`Source ${n}: ${SRC_HEADING[x]}`}>
              {n}
            </span>
          );
        })}
    </span>
  );
}

function Lines({ lines, evidence }: { lines: readonly ScriptLine[]; evidence: ReturnType<typeof evidenceFor> }) {
  return (
    <>
      {lines.map((line) => (
        <li key={line.text}>
          {line.text} <Badges src={line.src} evidence={evidence} />
        </li>
      ))}
    </>
  );
}

function CallScriptCard({
  s,
  script,
  lang,
  langs,
  onLang,
  evidence,
  measured,
}: {
  s: WatchSource;
  script: CallScript;
  lang: Lang;
  langs: Lang[];
  onLang: (lang: Lang) => void;
  evidence: ReturnType<typeof evidenceFor>;
  measured: string;
}) {
  const sources = scriptSources(s, evidence, measured);
  return (
    <section className="card op-script" aria-labelledby="op-script-title">
      <div className="op-head">
        <div>
          <p className="section-label">For the hotline</p>
          <h3 id="op-script-title" className="op-h">
            Call script
          </h3>
        </div>
        <div className="segmented segmented--small" role="group" aria-label="Script language">
          {langs.map((l) => (
            <button key={l} type="button" className={`segmented__option${l === lang ? " is-active" : ""}`} aria-pressed={l === lang} lang={l} onClick={() => onLang(l)}>
              {l.toUpperCase()}
              <span className="sr-only"> {LANG_LABEL[l]}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="note">Fixed wording filled from the status. No model writes it and it adds no advice of its own.</p>

      <h4 className="op-h4">What to tell callers</h4>
      <ol className="op-script__say" lang={lang}>
        <Lines lines={script.say} evidence={evidence} />
      </ol>
      <p className="note">Official channels</p>
      <ul className="op-channels">
        {script.channels.flatMap((c) =>
          c.links.map((l) => (
            <li key={l.url}>
              <a href={l.url} target="_blank" rel="noopener noreferrer">
                {l.label}
              </a>{" "}
              <span className="muted small">{c.group}</span>
            </li>
          )),
        )}
      </ul>

      <div className="op-two">
        <div>
          <h4 className="op-h4 op-h4--ok">What you can say</h4>
          <ul lang={lang}>
            <Lines lines={script.canSay} evidence={evidence} />
          </ul>
        </div>
        <div>
          <h4 className="op-h4 op-h4--no">What you must not say</h4>
          <ul lang={lang}>
            <Lines lines={script.mustNot} evidence={evidence} />
          </ul>
        </div>
      </div>

      <ol className="op-sources" aria-label="Sources of the call script">
        {sources.map((x) => (
          <li key={x.n} value={x.n}>
            <strong>[{x.n}]</strong> {x.heading}: {x.text}
          </li>
        ))}
      </ol>
      <p className="op-footer">
        {script.footerLocal && (
          <>
            <span lang={lang}>{script.footerLocal}</span>
            <br />
          </>
        )}
        {script.footer}
      </p>
    </section>
  );
}

function EscalateCard({ s, status }: { s: WatchSource; status: string }) {
  const runs = useTracked();
  const key = operatorRunKey(s);
  const run = runForKey(runs, key);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AssessOutcome | null>(null);
  const active = run?.status === "running";
  const press = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(
        await startAssessment({
          key,
          question: escalationQuestion(s, plainOf(s)),
          context: operatorContext(s),
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="op-escalate">
      <p className="section-label">Need more than a screening?</p>
      <h3 id="op-escalate" className="op-h">
        Escalate to agents
      </h3>
      <p className="note">
        Starts one full agent run for {s.name} (status now: {status}). It takes a few minutes and uses several model calls, so it never starts on its own.
        The result is a set of proposed actions in your approval queue; nothing is sent until a person approves.
      </p>
      <div className="assess">
        <button type="button" className="button primary" disabled={busy || active} onClick={() => void press()}>
          {busy ? "Starting…" : active ? "Agents working…" : "Escalate to agents"}
        </button>
        <p className="assess__status small" role="status" aria-live="polite">
          {run ? (
            <>
              {trackedLine(run)} · <a href={routeHref("operator", "approvals")}>Open your approval queue</a>
            </>
          ) : outcome && outcome.kind !== "started" ? (
            outcome.message
          ) : (
            "Nothing runs until you press the button."
          )}
        </p>
      </div>
    </section>
  );
}
