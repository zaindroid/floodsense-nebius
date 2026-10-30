# UI

The console for FloodSense EU: the Citizen, Insurer and Civil protection desks. Vite, React, and TypeScript. This `ui/src` console is the product UI. `ui/app` and `ui/mock` are not part of it. The live pages read the API; the replay views start from fixtures shaped like the Zetaris seed views, and a row stays a fixture unless `VITE_API_URL` returns that view.

Owner: Zain. Mihir landed the console.

## Run

From the repo root, `python tasks.py init-env` copies `ui/.env.example` when `ui/.env` is missing. Or, in this directory:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

```bash
cp .env.example .env
npm install
npm run dev
```

`npm run build` typechecks, then builds. npm runs the `&&` in that script through `cmd.exe` on Windows, where `&&` works. Do not paste that script into PowerShell 5, which has no `&&`.

`npm run lint` is `tsc --noEmit`. `npm test` runs Vitest. `python tasks.py test` runs that suite from the repo root after the Python tests.

Compose publishes the dev server on host port 15173 (container port 5173). `VITE_API_URL` defaults to `http://localhost:18000`, which is the API as the browser sees it. `VITE_API_TIMEOUT_MS` is optional and defaults to 1500.

Do not put tokens in `ui/.env`. Vite exposes every `VITE_*` value to the browser. The NVIDIA provider key lives only in Nightshift's Providers tab. This package does not call Nightshift or Zetaris.

## Global mode (Live, Past flood, Demo data)

One mode for the whole console, in `ConsoleContext` (`mode`, `eventId`, `demo`; pure helpers in `src/lib/mode.ts`). The header switch has **Live | Past flood** (with an event picker: Ahr 2021, Valencia 2024) and a **Demo data** checkbox. The state is in the URL query, `?mode=past&event=EMSR773&demo=1` (Live with no demo writes nothing), so a refresh keeps it; the hash is still the page.

- **Live** (default): the live watch, all 45 sources (26 gauges, 11 GloFAS points, 8 Valencia points). The chat sends no `event_id` and no replay date (`screenContextFor(..., "live")`, plus `contextForMode` for a page's own context).
- **Past flood**: every page shows the replay of the chosen event, and the chat sends `event_id`, `replay_date`, `point_id` and `place`. Pages with only a live form (Now on both desks, the Alerts monitor, Portfolio's nearest-source table) say "Switch to Live to see this" (`SwitchToLive`); Alerts offers the rehearsal of the chosen flood instead. Replay in Live mode asks which flood to show (`ChoosePast`), which switches the whole console to Past flood. The per-page event chips (Replay, Sites / map, Alerts rehearsal) are gone; they follow the header.
- **Context strip** (every page, a polite live region, always a final state): "Live data · checked HH:MM UTC" (plus "· 26 of 45 sources" when a view failed), "Live data · unavailable", "Past flood: Ahr 2021 (replay)", or "Demo data · bundled snapshot, not live". On Approvals, Review, System and How it works, which demo mode does not touch, it reads "Live data (demo mode only affects the watch views)" and there is no DEMO chip; there is no DEMO chip in Past mode either.
- **Partial outage**: when any live view fails, Citizen Now, Overview, My area, Alerts, Sites and Portfolio show a visible "N of 45 sources loaded. Could not read: …" note with Retry and "Show demo data"; the offer banner also appears for a single failed view, and the watch retries once after about 20 s. Back and Forward re-read the mode and the page from the URL (`popstate`).
- **Bell**: the badge counts sources at their raised band right now (Live only) plus unread simulation notices; the menu says how many of the loaded sources are raised. There are no static fixture notices.
- **Demo data** swaps the three live fetchers (`gauge_levels`, `eu_watch`, `hazard_now`, via `src/lib/demo.ts` and `src/fixtures/demo_live.json`, a snapshot of the API taken 27 Oct 2026 12:40 UTC) and keeps the replay views on their bundled fixtures. A "DEMO DATA" chip shows in the header and the strip while it is on. If the API health probe fails, or every live view errors, a banner offers "Live data unavailable — show demo data?"; it never switches on by itself. Not mocked: chat, the approvals queue and `/system` still use the API.
- **Demo data control** is a labelled switch (`role="switch"`, `aria-checked`, Space or Enter toggles it).
- **Replay status** on the citizen pages is measured against the event's own replay line (100 m³/s for both events, FloodSense's Watchers line, never a 20/80 demo line): "Above the 100 m³/s FloodSense alert line" (amber) or "Below ...".
- **Review** shows the newest completed full-lane run for the mode's event from `GET /runs/past` (Live: live-data runs) in the agent graph; if there is none it falls back to the bundled recording of run f16733274f1c, labelled "No completed full-lane run for ... yet ... Not live". The Skeptic and Judge tabs are always the bundled Valencia 2024 example and say so.
- **Approvals** are mode-aware and curated (see Approvals under Insurer desk).
- **Loading**: skeleton lines with "Loading live readings… N s" and, after 8 s, "A source is slow, showing what we have" (`Loading.tsx`). Live views normally take 2-5 s.
- **Next steps**: every page with a place offers "Is the next 48 h safe here?" (opens the chat pre-filled with "Do the next 48 hours look safe at <place>?", never sent on its own) and "Ask FloodSense about <place>". Citizen Now, Overview, My area, What to do and Evidence all have the place search; the full list of 45 is under "All 45 places".

### Pages: purpose, data, Live and Past

| Desk | Page | Purpose | Data source | Live shows | Past flood shows |
| --- | --- | --- | --- | --- | --- |
| Citizen | Now | Is anything near me high right now? | gauge_levels, eu_watch, hazard_now | Most notable place, search, Europe map, places to watch (all 45) | Switch to Live to see this |
| Citizen | Replay | How did a past flood unfold? | hazard_timeline (floodsense_seed), bundled Ahr rows | Choose a flood (switches to Past) | Moments, hour scrubber, chart for the chosen flood |
| Citizen | Overview | Is my area at risk, and why? | all live views; replay rows in Past | Risk card, place picker, next 48 h and Ask buttons | Status of a place on the replay day |
| Citizen | My area | Show my place on a map | live views; discharge_daily and the Ahr seed in Past | Place map, same-river places, or the whole watch | Event map and the chosen point |
| Citizen | What to do | What do I do? | built-in safety guidance, official warning links | Warning links for the place's country | Same guidance, labelled as part of a replay |
| Citizen | Evidence | Where does this come from? | live view query ids; provenance and citations in Past | View, query id and fetch time per source | Replay provenance and the reviewed answer's citations |
| Citizen | How it works | How does FloodSense work? | /config, /system | Router, agents, data and human approval, with status dots | Same |
| Insurer | Control tower | Is the watch loop running, and what did it find? | /watch/status, /watch/events, live watch | Loop state, event feed, scan now, auto-assess switch | Switch to Live to see this |
| Insurer | Now | What is happening in the watch right now? | hazard_now, gauge_levels, eu_watch | Valencia cards, gauge map and list, Europe map | Switch to Live to see this |
| Insurer | Replay | How did a past flood unfold? | hazard_timeline (floodsense_seed), bundled Ahr rows | Choose a flood (switches to Past) | Scrubber, chart and table for the chosen flood |
| Insurer | Approvals | Which agent answers need a decision? | /runs/past, live-run handoff | Queue and the decision bar (same in both modes) | Same queue; each run carries its own event |
| Insurer | Portfolio | Which sites are exposed? | exposure_join, live watch; replay exposure in Past | Sites grouped by nearest watched source | Replay exposure (Valencia) or a note that Ahr has no book |
| Insurer | Sites / map | Where are the sites against the rivers? | live watch, exposure_join; discharge_daily and Ahr seed in Past | Europe map with every source and the insured sites | Event map with the replay date slider and drill-down |
| Insurer | Alerts | Which sources are raised, and what do we do? | gauge_levels, eu_watch | Live alert monitor, with an agent assessment per alert | Switch to Live for the monitor; rehearsal of the chosen flood |
| Insurer | Review | Is the evidence solid? | bundled recorded run (Valencia 2024) | Causal chain, Skeptic, Judge of the recorded run | Same recorded run |
| Insurer | System | Are memory, cache, limits and models healthy? | /system | Counters and status (same in both modes) | Same |
| Insurer | How it works | How does FloodSense work? | /config, /system | Router, agents, data and human approval, with status dots | Same |
| Operator | Situation board | Which places need a call, and what do we say? | gauge_levels, eu_watch, hazard_now, forecast lane | Situation board with N of 45 sources, a call script and Escalate to agents | Live only (no past form) |
| Operator | Approvals | Which of our escalated runs need a decision? | /runs/past (this desk's own runs) | Queue and decision bar for runs started here | Live only (no past form) |
| Operator | How it works | How does FloodSense work? | /config, /system | Router, agents, data and human approval, with status dots | Live only (no past form) |

(`src/lib/pagePurpose.ts` holds the same rows; `src/lib/mode.test.ts` fails when they drift.)

## What the screen does

**Live pipeline and HITL (v0.15).** Ask FloodSense starts runs with `POST /runs?wait=false` and follows `GET /runs/{id}/events` (SSE; it falls back to polling `GET /runs/{id}` if the stream drops). The pipeline Scope → Watchers → Memory → Investigator ⇄ Skeptic → Exposure → Playbook → Judge → Human review lights each node on `started` and shows ✓, duration, model (`nemotron-3.5-lightning · Nightshift`, `deterministic`, `SQL · Zetaris`) and a one-line summary on `trace`; Skeptic revise and Judge repair loops are listed. An mm:ss timer and a rotating tip keep a ~6 min run watchable; updates go to an `aria-live="polite"` region. Then the final run is fetched and rendered. A 200 cache/replay answer is labelled "Recorded/cached · not live"; a 429 shows a Retry-After countdown; `failed` and `not_found` show inline errors; a `{kind: "reply", answer}` body is a plain message. Each sentence shows source chips from `citations[].layer` (a = Zetaris query, b = Provenance, c = Document). "Memories used" lists `memory_used` at run level only, never per sentence. The Approvals page loads the newest live run waiting for review (`GET /runs/{id}/approval`, else the packed example) as mock-style cards: action-type chip, title, region, site count, Judge badge, status, draft message, Edit (sends `draft_messages`), reviewer note, Approve/Edit/Reject; 422s show inline. Nothing is sent. Logic: `src/lib/liveRun.ts`, `src/lib/hitl.ts`, `src/api/liveRun.ts`.

The header has the product name, Citizen and Insurer links (`#/citizen`, `#/insurer`), a light/dark control, a notification bell, and an account icon.

A collapsible left nav lists that desk's pages, one task per page. Citizen: Overview, My area, What to do, Evidence (`#/citizen`, `#/citizen/area`, `#/citizen/actions`, `#/citizen/evidence`). Insurer: Approvals, Portfolio, Sites / map, Alerts, Review (`#/insurer/approvals` and the same pattern). `#/insurer` and an empty hash open Approvals while the decision is pending, else Portfolio.

**Civil protection desk (`#/operator`, role `operator`).** The third header button. The customer on the public side: emergency hotline staff who take calls are not flood experts, and gauges are run state by state. Pages:

| Page | Hash | Purpose |
| --- | --- | --- |
| Situation board | `#/operator` | Pick a country and a river or area (45 watch sources). One screen: the plain status of every source on the river, upstream to downstream (by PEGELONLINE `river_km`, direction per water in `RIVER_KM_DIRECTION`; watch-list order, labelled, where the views give no km); the next-48 h outlook from the deterministic forecast lane (`POST /runs?wait=false` with context role operator, place or station, then `GET /runs/{id}`; no model call, about 1-2 s); "what has happened here before" (replay pattern, H-MEM memory, report passage), framed as past with its [R n] source; the Call script; Escalate to agents; Copy brief. |
| Approvals | `#/operator/approvals` | The Approvals component filtered to runs started from this desk (tracked key `operator:`), with authority wording (Inform public, Request support, Internal review). No packed insurer example. Nothing is sent. |
| How it works | `#/operator/how` | The shared diagram, with "Your approval" as the human step. |

The **Call script** card is a fixed template, not a model output (`buildCallScript` in `src/lib/operatorDesk.ts`). "What to tell callers" is three or four lines in DE or EN (ES for a Spanish place) that state only the status (gauge vs long-term mean high water; model bands in amber, never red), plus the official links of the place's country from `WARNING_LINKS` and "call 112". "What you can say / what you must not say" is fixed text (never a forecast of your own; refer to the Hochwassermeldedienst of your Land). Every line has a [n] badge for its source: [1] the live view and its query id, [2] the FloodSense status rule, [3] the official services, [4] the call-script template. The only digits in a spoken line are 112 and the "7 days" / "30 days" of the model band rules, and a test fails otherwise. The card ends with "Model-based screening, not an official warning". **Copy brief** puts a plain-text brief on the clipboard with the time, the river order, the outlook, the past, the script and its sources, and every query id. **Escalate to agents** starts one full run per press (it never starts by itself) through `startAssessment`; it is followed over SSE and lands in the desk's own queue. The agents accept `role: "operator"` in `RunContext`; the front door gives the operator its own reply text and suggestions. Past mode: the global Live | Past switch of #90 is not on main yet, so the desk is Live only (TODO in `OperatorSituation.tsx`).

Approve, Edit, and Reject live only on Approvals, in a sticky bar. Review has the Causal chain, Skeptic, and Judge tabs.

Citizen What to do lists the answer's suggested actions only after an insurer approves them, so a pending action is never shown to a citizen.

The #36 hashes still work: Place and Rain open My area, Map and Point open Sites / map, Overview and Book open Portfolio, and Sources opens Review. An unknown page opens that desk's home. The hash is rewritten in place (`history.replaceState`) to the page it resolved to, so an old link leaves no extra history entry.

The nav starts collapsed at 980px or narrower. The Evidence drawer is mounted once on the shell and closes on a page change. The context strip under the header states the global mode on every page (see "Global mode"); while the Valencia simulation plays it also shows "Simulation playing" and Stop. Alerts has no Simulate button any more; it is the live alert monitor below.

A quick or forecast answer that carries a `plain` object renders as a calm answer (`src/components/CalmAnswer.tsx`, model `src/lib/calmAnswer.ts`) instead of the analyst text: a status chip (the `statusView` words and tones; no red for model bands or mean high water), a big headline, one plain sentence, the one-line disclaimer, "▸ Why" (collapsed; the cited claims with their [n] source badges), a "For context" card (history, labelled as history), and a next-step row with the country's official links (the `WARNING_LINKS` allowlist) and "Ask about another place". The insurer role gets the detailed claims first, then the plain headline. Any other run, and a quick or forecast run without `plain` (an older cached answer), renders as before.

An Ask FloodSense launcher sits at the bottom right. Its popup is closed at start, is never opened by a route change, and does not push the page. Esc or the close button closes it. Focus goes back to the launcher when it was inside the popup. The popup header says the answer is a replay and when it was cached. It shows the reviewed answer with numbered citations, and the query trace is behind How I got this. It has no question box: it reads the fixture answer and does not call a model or `/runs`. Citizen Overview has See the reviewed answer, which opens the same popup.

The theme key is `floodsense-theme`, the same string in `index.html` and `src/lib/theme.ts`. The first visit follows the system preference and does not write `localStorage` until the control is used, so a later OS change still applies until then. The account control is a stub: it does not collect credentials.

Demo dates, the simulation window, map bounds, band cuts, the 8 km drill-down radius, fixture detail strings, and the optional view paths live in `src/config/scenario.ts`.

The insurer desk shows:

- a Leaflet + OpenStreetMap map (Sites / map, `src/components/MapPanel.tsx`) for the chosen past flood (Past flood mode; Live shows the Europe view instead): Valencia 2024 (EMSR773, VAL01-VAL08 from `valencia_points`) or Ahr 2021 (EMSR517, AHR01-AHR04 Altenahr, Bad Neuenahr-Ahrweiler, Schuld, Dernau, the `floodsense_seed` rows from `ingestion/prep/ahr_hazard.py`). Markers sit at the rows' lat/lon, are coloured by discharge band, carry a permanent place label (code and value in the popup), and fit the event's bounds. Exposed sites are a toggleable layer for EMSR773; Ahr has no insured book, so the toggle is off and Portfolio says so. There is no river line.
- a replay-date slider across the discharge dates
- a drill-down that names the `discharge_daily` columns and the hazard columns when that day is in the extract
- an evidence drawer, “Why this source”, opened from the drill-down
- a causal chain, Skeptic notes, Judge scores, and approve / edit / reject

Approve, edit, and reject stay in the browser. Nothing is sent.

The 100 m³/s line (`SIMULATED_ALERT_M3S` in `src/config/scenario.ts`) is the one alert line: the Sites map peak band, Replay and the Alerts rehearsal read it, and it equals `anomaly_discharge` in `agents/floodsense_agents/governance.py` (a test keeps them equal). `warning_level` in the hazard rows is null, and the notice is labelled a simulation.

The chosen past flood is `eventId` in `ConsoleContext` (default EMSR517 = Ahr 2021; the Ahr map date and point live there too), picked in the header and used only in Past flood mode by Replay, Sites / map, Portfolio, Alerts rehearsal and the citizen pages. The header subtitle is the product tagline "Explainable flood risk for Europe" (`headerSubtitle` in `src/lib/events.ts`). The context strip is described under "Global mode". Citizen Now has one Europe live-watch map, the place search and "Places to watch"; insurer Now keeps the dense page (see "Citizen live-first").

The citizen side is live-first (see "Citizen live-first" below). The Valencia points, dates and discharge series appear there only when a Valencia replay place is chosen, and on Replay.

### Citizen live-first

- **Places.** `src/lib/places.ts` builds the citizen place list from every live-watch source (26 PEGELONLINE gauges from `/views/gauge_levels`, 11 GloFAS points from `/views/eu_watch`, the 8 Valencia points from `/views/hazard_now`) plus the Valencia (VAL01-VAL08) and Ahr (AHR01-AHR04) replay places. Search folds case and accents and matches name, river, country or point id ("koln", "danube", "hungary", "paiporta"). The views are read once and shared for 5 minutes (`src/hooks/useLiveWatch.ts`). The chosen place is `placeId` in ConsoleContext; null means "Right now, anywhere in our watch", the default.
- **Plain status** (`statusView` in `src/lib/places.ts`). No status is red or says "Warning": a gauge at or above MHW reads "Above mean high water" (amber), the near band "Close to mean high water". MHW is described as the long-term mean high water (not a warning level), never as an official threshold. Gauge Watch follows `ingestion/feeds/pegel_poll.py`: the level is within 25 % of the MW..MHW span below MHW. GloFAS bands read "Watch (model)" or "Elevated (model)" (at least 2× the past-30-day median) in amber, never red. Valencia points read "Above its recent normal (model)" (neutral) or "Far above its recent normal (model)" (amber), against the point's own past three days (`valenciaCuts` in `src/lib/euWatch.ts`: 2x and 4x the median of its past rows, median floored at 5 m³/s), so a point whose base flow is about 30 m³/s is not permanently raised.ts`, labelled not official. Each place gets one calm sentence that keeps its name's casing (`calmSentence`), a "Measured" (gauge) or "Modelled" (model hour or day) time, and its number under Details. Headline counts keep "gauges above mean high water" apart from "model points elevated" (`headlineCounts`).
- **Overview.** The chosen place's "Risk right now" card comes first (or the whole watch, most notable three first), then the place picker (the current choice is always in its short list, `quickPlaces`), then "Elsewhere in our watch", What should I do, and a small "Learn from past floods" card that links to Replay. Ask FloodSense is pre-filled with the chosen place's question.
- **Now (citizen).** It leads with the chosen place, or the most notable one, as a plain status, one sentence and a `[1]` source. Then one Europe map with every source (circles = gauges, diamonds = GloFAS, squares = Valencia) and the legend inside a collapsed "How we colour the map". Then "Places to watch", most notable first. "Updated" shows the oldest fetch time of the loaded views, and Refresh reloads all three views, gauges included.
- **Now (insurer)** is the previous dense page, unchanged (`InsurerNowPage.tsx`): Valencia cards with rain, trend and sparkline, the gauge map and list with MHW bars, the dropped/truncated flags and query id, and the visibility-paused refresh.
- **Review copy.** Citizen answers are not held back. Only the agent-written playbook step of the bundled Valencia 2024 answer waits for a person, and it, with its review status, shows only for a Valencia replay place.
- **My area / What to do** follow the chosen place. Warning links follow its country (`warningCountriesForCountry` in `src/lib/safety.ts`): DE gives the Germany links, ES the Spain links, any other country only the EU-wide Meteoalarm link "Find your national warning service" (`https://meteoalarm.org/en/live/`). No place shows all three groups. The allowlist test pins every URL.
- **Numbered sources.** Every live data point (Overview risk card, Places to watch rows, replay story moments) has a `[n]` badge (`LiveSourceBadge`) that opens the right-side Evidence drawer on that point (`LiveEvidenceView`, model `src/lib/liveEvidence.ts`): the pipeline ("PEGELONLINE REST (WSV) → FloodSense poller every 10 min → Zetaris file store → view floodsense.gauge_levels", or "Open-Meteo Flood API → Zetaris REST table → view floodsense.eu_watch"), the Zetaris query id and `x-executed-at` from the view response headers, the measured time, licence and upstream link, and "Not an official warning". In Ask, "Memories used" opens the same drawer with the run's H-MEM memories.
- **Evidence** lists the live views behind the chosen place (query id, fetch time, place count) before the past-event evidence.
- **Replay (citizen)** opens on "What happened": 3-5 moments derived from the replay rows (`storyMoments` in `src/lib/story.ts`: the heaviest rain hour, the first crossings of the event's line and always the peak flow, merged into the crossing sentence when they fall on the same point and day), each with a `[n]` source. Daily GloFAS values read "By end of <day>" with no time and sort after any hourly moment that day. Chart, table and step buttons sit behind "Show the data". The chart has an axis line ("rain (mm/h), top ↓ / river flow (m³/s) ↑") and a legend. Insurers keep the full data view.
- **How it works** is role-aware (`humanBox`): citizens read "Insurer alerts are checked by a person before they're sent. Your answers aren't held back."; insurers keep "Human approval".
- **Context strip.** One strip on every page, driven by the global mode (see "Global mode"). A chosen place never changes it: in Live the place list holds live sources only, in Past flood the points of the chosen flood only.

### Insurer desk, live first

- **Approvals** (`src/components/Approvals.tsx`, logic `src/lib/approvalQueue.ts`) is two panes. Left: runs with something to decide, newest first, from `GET /runs/past` (polled every 20 s), the live-run handoff id and runs started from Alerts (shown as "Agents working" until they reach review), plus a labelled packed example. Right: a header with the run's own facts (live run id, started, lane, model, Judge, event; "not reported" when the list lacks one), the proposed actions as cards, one run-level decision bar, and the claims with Judge grounding and numbered sources. The list is curated (`curateQueue`): scoped to the global mode (Live: live-data runs; Past flood: the chosen event's runs), full-lane runs only, runs with at least one outbound action (looked up once per run through `GET /runs/{id}/approval`), duplicates of the same question and event folded into the newest with "+N earlier runs", and "Hide this run" (kept in `localStorage` key `floodsense-hidden-runs`, with "Show hidden"). Rows read "Why was Altenahr at risk on 14 Jul 2021? · Ahr 2021 · 12:28 UTC · Judge 1.00", never a raw event id. Site counts read "N insured sites in the affected area", "0 insured sites · the demo book covers Valencia only" outside EMSR773, or "Site count not reported by the Exposure step". Internal actions say "Internal note — nothing is sent".
- **Numbered references** (`src/lib/references.ts`, `src/components/RefMarks.tsx`). The reviewed answer on Review and the "Document retrieval (layer c)" block put [1] [2] after each claim sentence, numbered by first appearance. Each opens the Evidence drawer with that one source: a document shows title, publisher, page/paragraph, licence, the quote, the source URL and the Zetaris hydration query id; data shows view, query id and the upstream link (`lib/sources.ts`). Fixture query ids are called fixture ids. Every passage keeps its [n] and an anchor id (`ref-<scope>-<n>`).
- **Alerts** (`src/components/Alerts.tsx`, `src/lib/alertMonitor.ts`) is a live alert monitor: every live source at a raised band (near or above) from `/views/gauge_levels` (level vs the long-term MHW) and `/views/eu_watch` (GloFAS model band), in the shared `statusView` words and tones ("Above mean high water", "Close to mean high water", "Elevated (model)", "Watch (model)"; amber, never a red "Warning"), with the reading time and a [1] that opens the drawer's "Where this comes from" (`evidenceForSource`). The monitor also lists the Valencia `hazard_now` points against their own recent flow ("Far above its recent normal (model)"), so Alerts, Sites and Portfolio agree, and every count reads the live total (26 gauges, 11 GloFAS points) "+ 8 Valencia demo points" (`countsText`). Displayed claim text rounds float noise (`roundLongNumbers`, 140.89999999999998 → 140.9). Both read the shared `useLiveWatch` (via `src/hooks/useInsurerWatch.ts`). Stale and seed readings are never alerted (they are counted). Calm reads "All 37 watched sources are below watch level · checked HH:MM UTC"; the count comes from the views, and sources without a threshold or a view that could not be read are named instead of claiming "all". Each row has "Ask the agents to assess": one `POST /runs?wait=false` through the Ask live-run client with `context` {role: insurer, page: alerts, place, station} (station only when it fits the agents' RunContext pattern), followed over SSE (`src/lib/assessRuns.ts`); at review it becomes the Approvals handoff. Nothing starts without a press. "Rehearse with a past flood" steps Ahr 2021 or Valencia 2024 day by day; once a point crosses 100 m³/s it offers "Ask the agents about this moment", a real run with `event_id` and `replay_ts` (the crossing day).
- **Sites / map** opens on a live Europe view (`src/components/LiveSitesMap.tsx`): every watch source plus the insured sites layer, "Demo book: synthetic Valencia portfolio · connect your own book". Past flood mode (header) shows the replay map of the chosen event instead.
- **Portfolio** groups the insured sites by nearest watched source (`src/lib/nearest.ts`, haversine) with live status when within 25 km, else "too far to describe these sites", plus a per-site list. The EMSR773 exposure KPIs follow as "Replay exposure … not live".
- The answer serving line ("cached at HH:MM UTC · replay · not live") no longer rides in the context strip; Review labels the reviewed fixture answer on its own card.

### Control tower

`#/insurer/tower`, first in the insurer nav, and `#/citizen/tower` ("How we watch", read-only, linked from the citizen footer). Files: `components/ControlTower.tsx`, `hooks/useControlTower.ts`, `api/watch.ts`, `lib/controlTower.ts`, `styles/controlTower.css`. It shows what the agents' rule-based watch loop does on its own (`agents/README.md` "Control tower"), under the fixed line "Rule-based watchers: no model calls. Model-written work only appears when a full investigation is started."

- **Top row:** sources watched, elevated, last scan (UTC), runs awaiting approval, auto-assess OFF/ON, and the same as one sentence for a screen reader. The scan's own counts win; before the first scan the live views stand in.
- **Left:** the Europe map of the 45 sources (`EuWatchMap`, same colours and words as everywhere; nothing red).
- **Right:** the Activity feed, newest first. Each row has the agent icon and name, a plain sentence (fixed templates from the service), the place, the status chip, the time and, on data events, a `[n]` badge (n is the event's own sequence number) that opens the Evidence drawer with the view and the Zetaris query id the service recorded. New rows animate in (not under reduced motion). Filters by agent and by place. "Ask the agents" opens Ask pre-filled for the place; "Open in Approvals" appears on a Judge row whose run still waits. A `role="status" aria-live="polite"` region announces at most one summary per 30 s, only for detected, awaiting-approval and approved events; the list itself is not live.
- **Insurer only:** "Scan now" (`POST /watch/cycle` answers 202 and the page follows `scanning` in the status; a 429 says how long to wait) and the switch "Auto-assess the worst new source (uses model calls, capped)" with its caps and use from `/watch/status`; when the service cannot keep the caps across a restart the switch is disabled and says why. `VITE_WATCH_ADMIN_TOKEN`, when set, is sent as `x-watch-admin-token` (it ships to the browser: a speed bump, not a secret); without it the switch works as before in dev. Citizens see the feed and map only.
- **States:** "Connecting…"; "First scan running… mm:ss elapsed"; a loop switched off; unreachable agents, said plainly, and, with the header Demo data switch on, the recorded feed (the page follows the global mode; see "Global mode"). The demo feed is a real recording (`fixtures/watchDemo.json`, from a scan of the real Zetaris on 27 Oct 2026), labelled "Demo data, not live". The feed streams over SSE and polls every 8 s when the stream is down; status polls every 10 s.
- 375 px: no horizontal scroll (checked). Local check against a host agents service: `VITE_API_URL=/api` with a Vite proxy of `/api` to it.

### Look and citizen Overview

Colours, type, and cards follow the team's mock UI (`Hackathon-Monorepo-mock-ui`); the tokens are at the top of `src/styles/global.css`. Citizen Overview asks "Is my area at risk right now?" and is described under "Citizen live-first". Table and column names in claim text are reworded by `src/lib/plain.ts` on citizen and insurer pages; the original sentence stays under Technical detail or in the hover text. The answer serving line appears once, in the replay strip. Sources and licences are one collapsed footer. Under 760px the nav is a drawer (backdrop, Escape, closes after a pick) and the header is two rows.

### Clarity pass (judge-ready)

- No global Preview badge. The citizen Risk right now card leads with a plain status ("Elevated — higher than normal river flow"), then the m³/s figure, then "Checked: 0.89" (the Judge, tooltip "Score from our independent checker agent"). No cache chip on the citizen card.
- What should I do: official guidance, 112 and warning links first; the approval gate is a neutral note ("Personalised advice from our agents is reviewed by a person before it's shown."), then Ask.
- Grounded sources per claim (`src/components/SourceBadges.tsx`, model `src/lib/sources.ts`). Every number badge, on Overview and in the Ask chat, opens that source inline: Zetaris data shows the view, query id and the upstream feed link (Open-Meteo GloFAS; eu_watch as "model, not an official warning"; Open-Meteo weather; PEGELONLINE; exposure_join as "Synthetic insurer portfolio (demo data) · OSM sites"; Copernicus EMS only for footprint fields, using the answer's or run's own event id; seed views say "Seed data"); a document shows title, publisher, page and paragraph, the quote and the source URL from the citation (the manifest URL the agents already copy into `source_url`). Memories read "H-MEM · approved run <id>" or "H-MEM · Demo seed", with the World Model board where present. A legend says "Every sentence links to its source: data via Zetaris, documents, or approved memory."
- How it works (`src/components/HowItWorks.tsx`, page `how` on both desks): router and lanes, the agents, Zetaris data, Nightshift / Nemotron lanes, H-MEM + World Model, RAG (pgvector + NIM nemotron-embed), Redis, human approval. Each box has a status dot from `GET /config` and `GET /system` (`src/api/system.ts`, `src/lib/howItWorks.ts`); a 404 on `/system` leaves those dots "unknown".
- `friendlyError` says "Here is the latest recorded answer" only when one is shown, and strips bare and quoted service hostnames (agents, api, engines, pgvector, redis) and IPv6 with a port.

### Agent pipeline and document retrieval

The pipeline is a compact stepper: one line per agent (status icon, name, status, duration, model chip such as "Nemotron 3.5 Lightning 30B · Nightshift fast lane" from the trace `lane`), details collapsed until clicked, loop chips ("Skeptic revise ×1", "Judge repair ×1") and World Model hypotheses on one line. In the Ask chat it streams open while agents work and folds to one summary line once the answer arrives ("8 agents · 5 min 12 s · Nemotron 3.5 Lightning 30B via Nightshift · Judge 0.90 ▸ show steps"). The live "Live · model" badge uses the same chip text (`src/lib/modelChip.ts`).

`src/components/AgentPipeline.tsx` (model: `src/lib/pipeline.ts`) draws any run body (live, cache or replay) as Scope → Watchers → Memory → Investigator ⇄ Skeptic → Exposure → Playbook → Judge → Human approval. Each node shows its status, the summed trace `latency_ms`, its lane, how many times it ran, and the trace summary. The revise loop appears when `revise_rounds` > 0 and the repair loop when `repair_rounds` > 0. Badges:

- "Zetaris · N queryIds" on SQL-lane steps.
- One provider rule (`providerOf` in `src/lib/lanes.ts`) for badges, chips and the live model line: the trace's explicit provider wins when present; otherwise an `nvidia/…nemotron…` id is "Nightshift · …", and every other id is shown as stored.
- "H-MEM recall · N" only when the memory step recalled at least one finding.
- "World Model" with the last board (H1 supported / not_supported …).
- "pgvector + Zetaris JDBC" when layer (c) citations exist.

The reveal is CSS and stops under `prefers-reduced-motion`. `src/components/RetrievalPanel.tsx` (model: `src/lib/retrieval.ts`) shows the layer (c) query, the passages per claim (title, page, publisher, licence, quote, attribution), the Zetaris query id that hydrated them, and the Judge's verdict, including "Flagged by Judge". Both views appear in the Ask popup under "How I got this". On insurer Review they form the "Causal chain" header, which reads `VITE_REPLAY_RUN_ID` or, failing that, the bundled recording `src/fixtures/run_f16733274f1c.json`. That header carries a "Recorded run · not live" badge and a note that says when it fell back to the bundled recording. Claim C2 in that recording is a known degenerate agent output and is shown as recorded.

### How this answer was made (TechTrace)

Every finished answer carries four sponsor tiles under the stepper: Zetaris, Meterless Nightshift, Meterless H-MEM and Meterless World Model, each a button (`aria-expanded`) that opens its detail, with a one-sentence glossary as tooltip and in the panel. A first line states the router's choice and the Judge result ("Router → quick lane (live level question about KÖLN) · Checked 1.00"). `src/lib/techTrace.ts` derives everything from the run snapshot (`claims[].citations`, `trace` model_id / lane / latency_ms, `memory_used`, the World Model board in the trace, `judge_summary`, `lane`, `router_reason`) and invents nothing: Zetaris counts the distinct cited `query_id`s over layers a and c and lists the views and layer b upstream sources; Nightshift lists the models and lanes with the count of model-assisted steps (not calls) and the time in those steps (it includes data queries), labels a non-Nemotron model "test provider", notes cached or replayed answers as recorded, and for a run without a model call says "No model call: answered deterministically from Zetaris data"; H-MEM lists recalled memories (demo seed labelled), separates "recall not active in this run" from "no approved memory matched", and adds "+ writes on approval" only when recall ran and the run awaits approval; World Model lists H1..Hn verdicts or "Not used by this lane". `src/components/TechTrace.tsx` mounts after the stepper in the Ask answer; on insurer Review `LatestRunTechTrace` shows it in a collapsed disclosure for the run awaiting review (else the newest finished run from `GET /runs/past`; in Past mode the newest run of the chosen event, pass `mode` and `eventId`), and How it works opens with the same four tiles plus the live status dot from `/config` and `/system`. Styles: `src/styles/techTrace.css`. Tests: `src/lib/techTrace.test.ts` (quick, full and forecast runs).

### Disaster replay

Page `replay` on both desks, right after Now. Two events:

- Ahr valley, 13–16 Jul 2021 (EMSR517). The page reads `GET /views/hazard_timeline?event_id=EMSR517&source=replay` (Zetaris `floodsense_seed`, migrations 051/052, even when `FF_LIVE_DATA` points the app at the live views) and uses the result when it holds AHR points inside the window, badged "Replay · Zetaris floodsense_seed · not live". Otherwise it uses `src/fixtures/ahr_2021.json`, badged "Bundled modelled data (Open-Meteo, CC BY 4.0), not from Zetaris". `VITE_AHR_SOURCE=fixture` forces the fixture. The fixture holds Open-Meteo Flood API (GloFAS v4 daily discharge) and Historical Weather API (ERA5 hourly precipitation) data for four points (AHR01 Altenahr, AHR02 Bad Neuenahr-Ahrweiler, AHR03 Schuld, AHR04 Dernau), rendered from `ingestion/prep/ahr_*.csv` (the same rows as `floodsense_seed`), CC BY 4.0 Open-Meteo.com, modelled values.
- Valencia, 28–31 Oct 2024 (EMSR773), from the loaded `hazard_timeline` rows.

The page has an hourly scrubber, day buttons and Play/Pause. Under reduced motion Play steps once a second, and the time readout is not announced while playing. Each point shows its rain and discharge at the scrubbed time. Because GloFAS discharge is daily, a crossing of the 100 m³/s Watchers line is dated by day ("Crossed the line on 14 Jul 2021 (daily value)"), never by hour. "Ask the agents about this moment" opens Ask pre-filled and sends `context` {page, event_id, replay_date, point_id, place}. Everything is labelled "Replay of … · not live".

### Ask opening, suggestions and declined questions

The Ask popup opens with a greeting fitted to role and page (`greetingFor` in `src/lib/chatGreeting.ts`): "Hi! I'm FloodSense. Ask me about flood risk where you are — every answer cites its sources." and three suggested questions that send on click (citizen: Paiporta, the Rhine at Köln, the Ahr valley in July 2021; insurer: exposure and insured value). The recorded run (`VITE_REPLAY_RUN_ID`, or the fixture answer) is behind "See an example answer" and is labelled "Recorded run · not live". Real answers keep the badge, pipeline, retrieval and trace. When the agents decline a question that belongs to the other event (`status` out_of_scope with `scope.elsewhere`), the answer shows "Ask about Ahr 2021 instead" (or Valencia 2024), which re-sends the question with that `event_id`. Live mode sends no `event_id` (a question naming a flood is routed by the agents); Past flood mode sends the chosen `event_id` and replay date on every page, so a question about the other flood is declined first and the switch button is the way across. Suggestions follow the global mode and, in Past flood, the chosen event (`shownEventId`): Ahr suggestions never mention Valencia. Live suggestions include "Do the next 48 hours look safe at Köln?" (the forecast lane). "Recorded run · not live" appears once, only while the example is open; the toggle has `aria-expanded` and `aria-controls`.

The header subtitle is the product tagline on every page.

Citizen "What should I do?" shows general guidance at once: "Follow your official warning service" and the agents' own `CITIZEN_ADVICE` text, verbatim (`src/lib/safety.ts`; `safety.test.ts` fails if it drifts from `agents/floodsense_agents/live.py`). The agent-written, tailored step stays behind human review ("A tailored step from our agents appears here after a person checks it."). An Ask FloodSense button opens the chat. Below the advice: "In an emergency call 112." and official warning-service links for the country of the chosen place (`warningCountriesForCountry`: DE gets Germany, ES gets Spain, any other country only the EU-wide Meteoalarm link; without a country `warningCountriesFor` reads the names, and no place shows all groups). The URLs live only in `WARNING_LINKS` in `src/lib/safety.ts` and are pinned by an allowlist test; they render through `SafeLink` (new tab, `rel="noopener noreferrer"`, and a visually hidden "(opens in new tab)").

### Ask screen context

Every Ask request carries `context` from `screenContext()` in ConsoleContext (role, page, selected point and place), merged with a page's own context. It is added only by `withAskContext` (`src/lib/askContext.ts`); `VITE_ASK_CONTEXT=off` stops sending it. The agents' `RunRequest` ignores unknown fields (pydantic default).

### River-gauge map

The API caches the views (`x-views-cache` miss, hit or stale; `x-views-age-s`). When a view is served stale the live sources failed and this is the last good copy: `LiveHealthNote` says "Last good reading from HH:MM UTC (live source temporarily unavailable)", the context strip says "Live data · view eu_watch is N min old" and never plain "Live". The headers are read in `src/api/euWatch.ts`, `gauges.ts`, `now.ts`; the logic is in `src/lib/staleness.ts`.

`GET {VITE_API_URL}/views/gauge_levels` (Zetaris `floodsense.gauge_levels`, PEGELONLINE Rhine/Mosel gauges). The browser never calls PEGELONLINE. Numbers sent as strings are coerced. Markers sit at the view's `lat`/`lon` (fallback: `STATION_POSITIONS` in `src/lib/gauges.ts`), coloured by `band` (below, near, above, unknown = No threshold). Cards show level, `trend_cm_h` as rising/steady/falling, MW and MHW, and the measured time. Each row's origin comes from `source`: a seed, fixture or replay stamp is labelled Seed or Fixture (dashed marker), never Live. A row with `is_stale` true (or missing) is labelled Stale. Live appears only for a live-source, fresh row, and the map chip says Live only when every gauge is. The view is re-read every 5 minutes; a failed or empty read is retried, not cached. An empty or unreachable view says "No live gauge readings yet". No sample gauges are drawn. Tiles: OpenStreetMap via Leaflet.

## Fixture and live

On load the screen paints the fixtures, then checks the API.

1. `GET ${VITE_API_URL}/health` — the API on `main` returns `{"status":"ok"}`.
2. If that succeeds, it tries a JSON array at each of these paths:
   - `/views/discharge_daily`
   - `/views/hazard_timeline`
   - `/views/exposure_join`
   - `/views/provenance`

A 200 body is used only when every element has the view columns below (numbers as JSON numbers, `in_footprint` as a boolean). `warning_level` may be missing; a missing value is null. `discharge_m3s` on hazard rows may be null. An empty JSON array is an empty view response, not a silent return to the fixture. A 404, a network error, a failed health check, or a different shape keeps the fixture. `GET /health` on its own does not change the label. The top bar has one honesty chip: **Preview** while any view is a fixture or seed, **Cached** when every view is live but the answer is cached or replayed, and **Live** only when every view and the answer are live. Opening the chip shows the answer serving line and each view's origin. Review labels the reviewed answer on its own card; Approvals shows the selected run's own facts instead. The same per-view list is under Data origin on Portfolio. The view list, map caption, and citizen caption use **Fixture**, **Seed**, or **Live**. Seed means the view response is seed-stamped (`source` starts with `seed:`); an adopted sibling with no stamp takes that seed label too. Live is a response whose rows each carry a source stamp that does not start with `seed:`, and none of those rows has `synthetic` equal to `yes`. An empty array stays empty and is labelled Fixture, not Live. Rows with no source stamp stay Fixture; the caption says unstamped. A seed discharge response still marks an unstamped sibling Seed. A live discharge response does not mark that sibling Live. `exposure_join` with `synthetic` equal to `yes` (migration 018) is Seed, including when discharge is Live. Fixture, seed, cache, and replay chrome do not say “live” and do not use the green live colour. The answer serving line under the chip says **cached at HH:MM UTC · replay**.

`ts_utc` with no zone is treated as UTC. Provenance `source_url` and citation `source_url` must be `http:` or `https:`. Other schemes are rejected and are not put in an `href`.

Those paths are optional reads, not the run contract. The Ask chat, Approvals, Review, the Control tower and the System page do call `/runs`, `/watch/*` and `/system`; this optional-read list is only for the replay views. The API serves `/health`, `/config`, `/runs`, approval, `/watch/*`, `/views/{name}` and `/system`. A health check alone does not select Live. CORS must allow the UI origin before a browser can read even `/health`; a blocked call stays on the fixture.

The reviewed answer is always the fixture in `ui/src/fixtures/answer.json`. It uses the shared contract (`served_from`, `cached_at`, claims, citations, evidence, judge, playbook action). `served_from` is `replay` and `cached_at` is `2026-10-24T14:32:00Z`, so the serving line under the chip reads **cached at 14:32 UTC**. Cache and replay are never labelled live. `query_id` values in that file are fixture ids, not Zetaris query ids, and the SQL is not executed.

Skeptic notes in `ui/src/fixtures/console.ts` are display copy for this screen. The outcome names (`held`, `challenged`, `revised`) live in `src/types/skeptic.ts` and are not a shared contract yet. They are not an agent payload and they do not choose a Nightshift lane. The Judge fixture stores `meterless/deep`. The Judge tab shows a routing name as stored. A concrete Nightshift id is labelled "answered by" that model, using the names in the table at the top of `docs/architecture/c4.md`. Super VL answers both lanes today, so it is not shown as one lane. Lightning is not shown as `meterless/fast`. This UI does not call a model. Skeptic counter-checks that quote fixture numbers are hidden while discharge rows are live.

`src/types/contract.ts` is a type-only re-export of `contracts/typescript`. Compose builds the UI image from `./ui` only, so that path is outside the image. Vite drops `import type` at build time, and `npm run dev` in the container does not need the file. `tsc` from a full checkout still resolves it. Do not copy `contracts/` into `ui/`.

## How the fixtures map to the views

Numbers and column names were copied on 24 Oct 2026 from `feat/zetaris-data-sync` (PR #12’s branch) and the prep CSVs on `feat/ingestion-sources-terms`. This branch does not modify those branches. When the views change, replace the JSON under `ui/src/fixtures/` and keep the column names.

| Fixture | View | Columns |
| --- | --- | --- |
| `discharge_daily.json` | `floodsense_seed.discharge_daily` (migration 012; live twin is migration 004) | `point_id`, `date`, `discharge_m3s`, `source` |
| `hazard_timeline.json` | `floodsense_seed.hazard_timeline` for 28–30 Oct 2024 (migration 013; live twin is 007) | `point_id`, `ts_utc`, `rain_mm`, `discharge_m3s`, `warning_level` |
| `exposure_join.json` | `floodsense_seed.exposure_join` (migration 016; live twin is 014) | `policy_id`, `site_id`, `lat`, `lon`, `in_footprint`, `sum_insured_eur`, `segment` |
| `provenance.json` | `floodsense_seed.provenance` (migration 017; live twin is 015), six datasets | `dataset`, `source_url`, `publisher`, `licence`, `attribution`, `fetched_at` |
| `valencia_points.json` | prep CSV `ingestion/prep/valencia_points.csv`, not a view | joins to discharge on `point_id` |

`discharge_daily.source` in the seed extract is `seed:open-meteo-flood-glofas`. The live view stamps the same series as `open-meteo-flood-glofas`. The evidence drawer says the series is modelled GloFAS only when the source stamp is that one. A fixture notice is built from the loaded rows and is removed when those rows are live. `fetched_at` is the prep `accessed_at` date written as midnight UTC, which is what the provenance view does when it casts that date to a timestamp. The provenance fixture is the six migration 017 datasets (EMSR773, OSM sites, the synthetic portfolio, Open-Meteo Flood, Open-Meteo historical rain, AEMET). PEGELONLINE and DWD prep rows are not in that view. Source stamps map to those datasets by a fixed table, not by searching for the word “flood”.

The discharge figures are the frozen Open-Meteo Flood (GloFAS) copy from migration 012: VAL01–VAL08, 20 Oct–5 Nov 2024, modelled, not observed. Neighbouring points can share a value because Open-Meteo snaps them to a 0.05° cell. The portfolio behind `exposure_join` is synthetic.

After PR #12 is on `main`, Zetaris has the views. This UI still will not read Zetaris itself. Point `VITE_API_URL` at an API that serves the arrays above, or keep the fixtures until that route exists. The serving line stays on the replay fixture until a runs API returns an `Answer` with its own `served_from` and `cached_at`.

`compose.yaml` is unchanged. The UI container still runs `npm run dev` on port 5173.
