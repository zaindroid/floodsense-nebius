import { describe, expect, it } from "vitest";
import type { ReplayClaim } from "../api/replay";
import type { WatchSource } from "./euWatch";
import { WARNING_LINKS } from "./safety";
import {
  OPERATOR_ACTION_LABELS,
  RIVER_KM_DIRECTION,
  SCRIPT_FOOTER,
  SCRIPT_KEYS,
  badgeText,
  buildBrief,
  buildCallScript,
  coverageOf,
  forecastLaneEnabled,
  outlookBlocked,
  readingTime,
  buildRiverGroups,
  defaultGroup,
  escalationQuestion,
  focusSource,
  forecastBriefFrom,
  forecastQuestion,
  isOperatorRunKey,
  languagesFor,
  operatorActionChip,
  operatorContext,
  operatorRunKey,
  orderAlongRiver,
  orderLine,
  sameRiverElsewhere,
  scriptKey,
  scriptSources,
  screeningView,
  splitForecastClaims,
  type Lang,
} from "./operatorDesk";
import { plainOf, statusView } from "./places";

function src(over: Partial<WatchSource> & Pick<WatchSource, "id" | "name">): WatchSource {
  return {
    kind: "gauge",
    river: "Rhine",
    country: "DE",
    lat: 50,
    lon: 7,
    status: "ok",
    ratio: 0.2,
    value: "144 cm · MHW 725 cm",
    live: true,
    question: "?",
    measuredAt: "2026-10-27T13:00:00Z",
    riverKm: null,
    ...over,
  };
}

const RHINE = [
  src({ id: "gauge:KÖLN", name: "Köln", riverKm: 688 }),
  src({ id: "gauge:MAINZ", name: "Mainz", riverKm: 498.27 }),
  src({ id: "gauge:EMMERICH", name: "Emmerich", riverKm: 851.9 }),
];
const DANUBE = [
  // Regensburg lies west (upstream) of Passau but has the larger PEGELONLINE km: Danube km is counted from the mouth.
  src({ id: "gauge:PASSAU DONAU", name: "Passau Donau", river: "Danube", riverKm: 2226.7, lon: 13.46 }),
  src({ id: "gauge:REGENSBURG EISERNE BRÜCKE", name: "Regensburg Eiserne Brücke", river: "Danube", riverKm: 2379.3, lon: 12.1 }),
];
const VIENNA = src({ id: "model:EU07", kind: "model", name: "Vienna", river: "Danube", country: "AT", status: "ok", value: "7-day max 1000 m³/s" });
const VAL = src({ id: "valencia:VAL01", kind: "valencia", name: "Paiporta", river: "", country: "ES", status: "near" });

describe("river order", () => {
  it("orders the Rhine upstream to downstream by rising kilometre", () => {
    const out = orderAlongRiver("Rhine", RHINE);
    expect(out.ordered).toBe("km");
    expect(out.sources.map((s) => s.name)).toEqual(["Mainz", "Köln", "Emmerich"]);
  });

  it("orders the Danube by falling kilometre, which runs from the mouth", () => {
    const out = orderAlongRiver("Danube", DANUBE);
    expect(out.ordered).toBe("km");
    expect(out.sources.map((s) => s.name)).toEqual(["Regensburg Eiserne Brücke", "Passau Donau"]);
    // Downstream means east on the Danube: the longitude must grow along the returned order.
    expect(out.sources[0].lon!).toBeLessThan(out.sources[1].lon!);
  });

  it("covers every German water the poller reads except the single-gauge Ems", () => {
    for (const water of ["Rhine", "Elbe", "Oder", "Weser", "Danube", "Main", "Mosel", "Neckar", "Saar"]) {
      expect(RIVER_KM_DIRECTION[water], water).toBeDefined();
    }
  });

  it("keeps the list order when a source has no kilometre or the direction is unknown", () => {
    const partial = [RHINE[0], { ...RHINE[1], riverKm: null }, RHINE[2]];
    expect(orderAlongRiver("Rhine", partial)).toEqual({ sources: partial, ordered: "list" });
    const unknown = [src({ id: "a", name: "A", river: "Ems", riverKm: 2 }), src({ id: "b", name: "B", river: "Ems", riverKm: 1 })];
    expect(orderAlongRiver("Ems", unknown).sources.map((s) => s.name)).toEqual(["A", "B"]);
    expect(orderAlongRiver("Ems", unknown).ordered).toBe("list");
  });

  it("says how the order was found", () => {
    const groups = buildRiverGroups([...RHINE, ...DANUBE, VAL]);
    const rhine = groups.find((g) => g.river === "Rhine")!;
    expect(orderLine(rhine)).toMatch(/Upstream to downstream, by PEGELONLINE river kilometre/);
    expect(orderLine(groups.find((g) => g.river === "Valencia area")!)).toMatch(/One watched source/);
  });
});

describe("river groups", () => {
  const all = [...RHINE, ...DANUBE, VIENNA, VAL];
  const groups = buildRiverGroups(all);

  it("groups by country and river, countries and rivers alphabetical", () => {
    expect(groups.map((g) => `${g.country}|${g.river}`)).toEqual(["AT|Danube", "DE|Danube", "DE|Rhine", "ES|Valencia area"]);
    expect(groups.find((g) => g.key === "DE|Rhine")!.sources.map((s) => s.name)).toEqual(["Mainz", "Köln", "Emmerich"]);
  });

  it("names the Valencia model points as an area, since they have no river", () => {
    expect(groups.find((g) => g.country === "ES")!.label).toBe("Valencia area (1)");
  });

  it("opens on the group that holds the worst source", () => {
    const worst = all.map((s) => (s.id === "gauge:KÖLN" ? { ...s, status: "over" as const } : s));
    const g = buildRiverGroups(worst);
    expect(defaultGroup(g, worst)!.key).toBe("DE|Rhine");
    expect(focusSource(g.find((x) => x.key === "DE|Rhine")!, null)!.name).toBe("Köln");
    expect(focusSource(g.find((x) => x.key === "DE|Rhine")!, "gauge:MAINZ")!.name).toBe("Mainz");
    expect(focusSource(g.find((x) => x.key === "DE|Rhine")!, "gauge:NOT-HERE")!.name).toBe("Köln");
    expect(defaultGroup([], [])).toBeNull();
  });

  it("points at the same river in another country", () => {
    expect(sameRiverElsewhere(groups, groups.find((g) => g.key === "DE|Danube")!)).toEqual(["Austria"]);
    expect(sameRiverElsewhere(groups, groups.find((g) => g.key === "DE|Rhine")!)).toEqual([]);
  });
});

const STATUSES: WatchSource["status"][] = ["ok", "near", "over", "unknown"];
const KINDS: WatchSource["kind"][] = ["gauge", "model", "valencia"];
const LANGS: Lang[] = ["en", "de", "es"];

describe("call script", () => {
  it("has a template for every kind and status in every language", () => {
    const seen = new Set<string>();
    for (const kind of KINDS)
      for (const status of STATUSES) {
        const key = scriptKey(kind, status);
        seen.add(key);
        for (const lang of LANGS) {
          const script = buildCallScript(src({ id: "x", name: "Köln", kind, status, river: kind === "valencia" ? "" : "Rhine" }), lang);
          expect(script.say.length, `${kind}/${status}/${lang}`).toBeGreaterThanOrEqual(3);
          expect(script.say.length).toBeLessThanOrEqual(4);
          for (const line of [...script.say, ...script.canSay, ...script.mustNot]) {
            expect(line.text.trim().length).toBeGreaterThan(10);
            expect(line.src.length).toBeGreaterThan(0);
          }
        }
      }
    expect([...seen].sort()).toEqual([...SCRIPT_KEYS].sort());
  });

  it("uses different German and English text and never leaves a template hole", () => {
    for (const key of SCRIPT_KEYS) {
      const [kind, band] = key === "unknown" ? (["gauge", "unknown"] as const) : (key.split("-") as [string, string]);
      const status = ({ ok: "ok", near: "near", over: "over", unknown: "unknown" } as const)[band as "ok"];
      const s = src({ id: "x", name: "Köln", kind: kind === "demo" ? "valencia" : (kind as "gauge"), status });
      const en = buildCallScript(s, "en");
      const de = buildCallScript(s, "de");
      expect(de.say[0].text).not.toBe(en.say[0].text);
      for (const t of [...en.say, ...de.say].map((l) => l.text)) expect(t).not.toMatch(/undefined|\$\{|\[object|NaN/);
    }
  });

  it("states no number that no source gave: only 112 and the fixed 7- and 30-day band windows", () => {
    for (const kind of KINDS)
      for (const status of STATUSES)
        for (const lang of LANGS) {
          // The source carries 144 cm, 725 cm and 1000 m3/s. None may leak into a spoken line.
          const s = src({ id: "x", name: "Köln", kind, status, value: "144 cm · MHW 725 cm · 1000 m³/s" });
          const script = buildCallScript(s, lang);
          const digits = [...script.say, ...script.canSay, ...script.mustNot].flatMap((l) => l.text.match(/\d+/g) ?? []);
          for (const d of digits) expect(["112", "7", "30"], `${kind}/${status}/${lang}: ${d}`).toContain(d);
          expect(script.say.map((l) => l.text).join(" ")).toMatch(/112/);
        }
  });

  it("reads the state from the source: raised gauge text is not the normal text, and a model is never called a measurement", () => {
    const gauge = (status: WatchSource["status"]) => buildCallScript(src({ id: "g", name: "Köln", status }), "en").say[0].text;
    expect(gauge("ok")).toMatch(/below its long-term mean high water/);
    expect(gauge("near")).toMatch(/close to its long-term mean high water/);
    expect(gauge("over")).toMatch(/at or above its long-term mean high water/);
    expect(buildCallScript(src({ id: "g", name: "Köln", status: "over" }), "en").say[1].text).toMatch(/Meldestufen/);
    const model = buildCallScript(src({ id: "m", name: "Paris", kind: "model", river: "Seine", country: "FR", status: "over" }), "en");
    expect(model.say[0].text).toMatch(/our model/);
    expect(model.say[1].text).toMatch(/not a measurement/);
    expect(model.status.tone).toBe("elevated");
    const unknown = buildCallScript(src({ id: "u", name: "Köln", status: "unknown" }), "en");
    expect(unknown.say[0].text).toBe("We have no current reading for Köln.");
    expect(unknown.say[1].text).toMatch(/cannot tell you/);
  });

  it("follows the statusView words: a model band is amber, never red", () => {
    for (const status of ["near", "over"] as const) {
      expect(buildCallScript(src({ id: "m", name: "Paris", kind: "model", status }), "en").status).toEqual(statusView("model", status));
      expect(buildCallScript(src({ id: "m", name: "Paris", kind: "model", status }), "en").status.tone).not.toBe("warning");
    }
    expect(buildCallScript(src({ id: "g", name: "Köln", status: "over" }), "en").status).toEqual(plainOf(src({ id: "g", name: "Köln", status: "over" })));
  });

  it("gives the country's verified warning links, from the allowlist", () => {
    const urls = (s: WatchSource) => buildCallScript(s, "en").channels.flatMap((c) => c.links.map((l) => l.url));
    expect(urls(src({ id: "g", name: "Köln" }))).toEqual(WARNING_LINKS.de.links.map((l) => l.url));
    expect(urls(VAL)).toEqual(WARNING_LINKS.es.links.map((l) => l.url));
    expect(urls(VIENNA)).toEqual(WARNING_LINKS.eu.links.map((l) => l.url));
    expect(urls(src({ id: "p", name: "Paris", kind: "model", country: "FR" }))).toEqual(WARNING_LINKS.eu.links.map((l) => l.url));
    // A German place never gets the Spanish services, and the reverse.
    expect(urls(src({ id: "g", name: "Köln" })).join(" ")).not.toMatch(/proteccioncivil|aemet/);
    expect(urls(VAL).join(" ")).not.toMatch(/bund\.de|dwd\.de/);
  });

  it("keeps the Valencia-only 112 line off another Spanish place", () => {
    const zaragoza = src({ id: "model:EU05", kind: "model", name: "Zaragoza", river: "Ebro", country: "ES" });
    const links = buildCallScript(zaragoza, "es").channels.flatMap((c) => c.links.map((l) => l.label));
    expect(links).toEqual(["Protección Civil", "AEMET warnings"]);
    expect(buildCallScript(zaragoza, "es").say[2].text).not.toMatch(/Valenciana/);
    expect(buildCallScript(VAL, "es").say[2].text).toMatch(/112 Comunitat Valenciana/);
  });

  it("refers German callers to the Hochwassermeldedienst of the Land, others to their national service", () => {
    const must = (s: WatchSource, lang: Lang) => buildCallScript(s, lang).mustNot[0].text;
    expect(must(src({ id: "g", name: "Köln" }), "en")).toBe("Do not give a flood forecast of your own; refer to the Hochwassermeldedienst of your Land.");
    expect(must(src({ id: "g", name: "Köln" }), "de")).toMatch(/Hochwassermeldedienst Ihres Landes/);
    expect(must(VIENNA, "en")).toMatch(/Meteoalarm/);
    expect(must(VIENNA, "en")).not.toMatch(/Hochwassermeldedienst/);
  });

  it("offers Spanish only for a Spanish place", () => {
    expect(languagesFor("DE")).toEqual(["en", "de"]);
    expect(languagesFor("es")).toEqual(["en", "de", "es"]);
    expect(languagesFor("FR")).toEqual(["en", "de"]);
  });

  it("carries a source badge on every line, ends with the screening line, and numbers the sources 1 to 4", () => {
    const s = src({ id: "g", name: "Köln", status: "over" });
    const script = buildCallScript(s, "de");
    for (const line of [...script.say, ...script.canSay, ...script.mustNot]) expect(badgeText(line.src)).toMatch(/^(\[[1-4]\])+$/);
    expect(script.footer).toBe(SCRIPT_FOOTER);
    expect(script.footer).toBe("Model-based screening, not an official warning");
    expect(script.footerLocal).toMatch(/keine amtliche Warnung/);
    expect(buildCallScript(s, "en").footerLocal).toBeNull();
    expect(script.say[2].src).toEqual(["official"]);
    const list = scriptSources(s, null, "Measured 27 Oct, 13:00 UTC");
    expect(list.map((x) => x.n)).toEqual([1, 2, 3, 4]);
    expect(list[0].text).toMatch(/gauge_levels/);
    expect(list[3].text).toMatch(/No model wrote it/);
  });

  it("is the same every time for the same input (no model, no clock)", () => {
    const s = src({ id: "g", name: "Köln", status: "near" });
    expect(buildCallScript(s, "en")).toEqual(buildCallScript(s, "en"));
  });
});

describe("runs for the operator desk", () => {
  it("sends role operator and only values the agents accept", () => {
    expect(operatorContext(src({ id: "gauge:KÖLN", name: "Köln" }))).toEqual({ role: "operator", page: "situation", place: "Köln", station: "KÖLN" });
    expect(operatorContext(VAL)).toEqual({ role: "operator", page: "situation", place: "Paiporta", point_id: "VAL01" });
    // A station with a digit or a bracket would be refused by RunContext, so it is left out.
    const ctx = operatorContext(src({ id: "gauge:FRANKFURT1 (ODER)", name: "Frankfurt1 (Oder)" }));
    expect(ctx.station).toBeUndefined();
    expect(operatorContext(VIENNA).point_id).toBeUndefined();
  });

  it("asks the forecast lane by place name and the full lane for the escalation", () => {
    expect(forecastQuestion(src({ id: "g", name: "Köln" }))).toBe("What does the next 48 hours outlook show for Köln?");
    const q = escalationQuestion(src({ id: "g", name: "Köln" }), plainOf(src({ id: "g", name: "Köln", status: "over" })));
    expect(q).toMatch(/civil protection/);
    expect(q).toMatch(/Draft an alert/); // a router "deep" word: the full lane, not the quick forecast
    expect(q).toMatch(/Above mean high water/);
  });

  it("keys the operator queue apart from the insurer's runs", () => {
    const key = operatorRunKey(src({ id: "gauge:KÖLN", name: "Köln" }));
    expect(isOperatorRunKey(key)).toBe(true);
    expect(isOperatorRunKey("alert:gauge:KÖLN")).toBe(false);
  });

  it("gives the agents' four action types authority wording", () => {
    expect(operatorActionChip("inform-public")).toBe("Inform public");
    expect(operatorActionChip("dispatch-loss-adjuster")).toBe("Request support");
    expect(operatorActionChip(null)).toBe("Action");
    for (const label of Object.values(OPERATOR_ACTION_LABELS)) expect(label).not.toMatch(/underwrit|policyholder|loss adjuster/i);
  });
});

const claim = (id: string, text: string, layer = "a"): ReplayClaim => ({
  id,
  text,
  citations: [{ id: `${id}-a1`, layer, title: "t", publisher: null, licence: null, attribution: null, quote: null, page: null, queryId: "q1" }],
});

describe("forecast lane result", () => {
  const body = {
    lane: "forecast",
    status: "answered",
    served_from: "live",
    forecast: { status: "Normal", lead: "Status: Normal for KÖLN over the next 48 hours (FloodSense screening; not an official warning).", gaps: ["no discharge forecast"], disclaimer: "d" },
  };

  it("reads only a finished forecast-lane answer", () => {
    expect(forecastBriefFrom(body, "r1")).toMatchObject({ runId: "r1", status: "Normal", gaps: ["no discharge forecast"], servedFrom: "live" });
    expect(forecastBriefFrom({ ...body, lane: "full" }, "r1")).toBeNull();
    expect(forecastBriefFrom({ ...body, status: "awaiting_approval" }, "r1")).toBeNull();
    expect(forecastBriefFrom({ ...body, forecast: null }, "r1")).toBeNull();
    expect(forecastBriefFrom(null, "r1")).toBeNull();
  });

  it("shows a rain screening as amber, never red", () => {
    expect(screeningView("Normal").tone).toBe("normal");
    expect(screeningView("Watch").tone).toBe("watch");
    expect(screeningView("Elevated").tone).toBe("elevated");
    expect(screeningView("Warning").word).toBe("Elevated");
    expect(screeningView(null).tone).toBe("unknown");
  });

  it("names the driver in the chip and never says Warning or Elevated rain", () => {
    expect(screeningView("Elevated", "Elevated (river model)").word).toBe("Elevated (river model)");
    expect(screeningView("Elevated", "Elevated (rain)").word).toBe("Elevated (rain)");
    expect(screeningView("Normal").word).toBe("Normal");
    expect(screeningView("Elevated").word).not.toMatch(/warning|rain/i);
    expect(forecastBriefFrom({ ...body, forecast: { ...body.forecast, status_label: "Watch (rain)" } }, "r1")?.statusLabel).toBe("Watch (rain)");
  });

  it("splits the claims into the outlook and what happened before", () => {
    const claims = [
      claim("F1", "KÖLN: forecast precipitation for the next 48 hours is 1 mm."),
      claim("F2", "KÖLN (RHEIN) gauge: level 144 cm."),
      claim("F3", "Past pattern: before the July 2021 Ahr flood, rain reached 78 mm."),
      claim("F4", 'Approved memory (H-MEM, approved by evals) for KÖLN: "x" (context from an earlier run, not a measurement).'),
      claim("F5", "A multi-disciplinary analysis ...", "c"),
    ];
    const { outlook, history } = splitForecastClaims(claims);
    expect(outlook.map((c) => c.id)).toEqual(["F1", "F2"]);
    expect(history.map((h) => [h.claim.id, h.kind])).toEqual([["F3", "pattern"], ["F4", "memory"], ["F5", "report"]]);
    expect(history[1].heading).toMatch(/not a measurement/);
  });
});

describe("brief text", () => {
  const s = src({ id: "gauge:KÖLN", name: "Köln", status: "over", riverKm: 688 });
  const group = buildRiverGroups([...RHINE.filter((x) => x.id !== "gauge:KÖLN"), s]).find((g) => g.river === "Rhine")!;
  const script = buildCallScript(s, "en");
  const base = {
    now: new Date("2026-10-27T13:41:00Z"),
    source: s,
    group,
    measuredText: "Measured 27 Oct, 13:00 UTC",
    evidence: { queryId: "abc-123", view: "floodsense.gauge_levels" } as never,
    forecast: null,
    outlookLines: [],
    historyLines: [],
    runQueryIds: [],
    script,
  };

  it("carries the time, the order, the script, the sources and the query ids", () => {
    const text = buildBrief({
      ...base,
      forecast: forecastBriefFrom({ lane: "forecast", status: "answered", served_from: "live", forecast: { status: "Normal", lead: "Status: Normal for KÖLN." } }, "run42"),
      outlookLines: ["- KÖLN: rain 1 mm. [R1]"],
      historyLines: ["- A past flood, from the replay data: Past pattern: 78 mm. [R2]"],
      runRefs: ["[R1] Data via Zetaris: floodsense.weather_forecast · query q-run-1"],
      runQueryIds: ["q-run-1"],
    });
    expect(text).toContain("Created: 2026-10-27 13:41 UTC");
    expect(text).toContain("Place: Köln, Rhine, Germany");
    expect(text).toContain("Status: Above mean high water");
    expect(text).toContain("upstream to downstream");
    expect(text.indexOf("Mainz")).toBeLessThan(text.indexOf("Köln: Above"));
    expect(text).toContain("<- this place");
    expect(text).toContain("Status: Normal for KÖLN.");
    expect(text).toContain("Run run42 · live");
    expect(text).toContain("Sources of the outlook and the past:\n  [R1] Data via Zetaris: floodsense.weather_forecast");
    expect(text).toContain("Sources of the call script:");
    expect(text).toContain("Past pattern: 78 mm.");
    for (const l of WARNING_LINKS.de.links) expect(text).toContain(l.url);
    expect(text).toContain("[1] Data via Zetaris: floodsense.gauge_levels");
    expect(text).toContain("Query ids: abc-123, q-run-1");
    expect(text.trimEnd().endsWith(`${SCRIPT_FOOTER}.`)).toBe(true);
  });

  it("says plainly when the outlook or the history is missing, and invents nothing", () => {
    const text = buildBrief({ ...base, evidence: null });
    expect(text).toContain("Not available when this brief was copied.");
    expect(text).toContain("No earlier event is stored for this place.");
    expect(text).toContain("Query ids: none given by the views");
  });

  it("says the order is not a flow order when no kilometre is known", () => {
    const unordered = buildRiverGroups([VAL])[0];
    const text = buildBrief({ ...base, source: VAL, group: unordered, script: buildCallScript(VAL, "es") });
    expect(text).toContain("watch-list order, not a flow order");
    expect(text).toContain("Call script (Español)");
  });
});

describe("review round 1: conservative script wording", () => {
  const all = (s: WatchSource) => LANGS.flatMap((l) => buildCallScript(s, l).say.map((x) => x.text));

  it("never claims 'not a warning level', 'seasonal', 'normal' or an all-clear", () => {
    for (const kind of KINDS)
      for (const status of STATUSES) {
        const text = all(src({ id: "x", name: "Köln", kind, status })).join(" ");
        expect(text).not.toMatch(/not a warning level|keine Warnstufe|No es un nivel de aviso|seasonal|jahreszeitlich|estacional/i);
        expect(text).not.toMatch(/\bnormal(en)?\b/i);
      }
  });

  it("tells staff to check the official warning service for every status, live or not", () => {
    for (const live of [true, false])
      for (const kind of KINDS)
        for (const status of STATUSES)
          for (const lang of LANGS) {
            const s = buildCallScript(src({ id: "x", name: "Köln", kind, status, live }), lang);
            expect(s.say[2].src).toEqual(["official"]);
            expect(s.say[2].text).toMatch(/warn|Warn|aviso/i);
          }
  });

  it("points a raised gauge at the Land's Meldestufen, and a non-German one at the national service", () => {
    const de = buildCallScript(src({ id: "x", name: "Köln", status: "over" }), "de").say[1].text;
    expect(de).toMatch(/Meldestufen legt der Hochwassermeldedienst Ihres Landes fest/);
    const fr = buildCallScript(src({ id: "x", name: "Paris", status: "near", country: "FR", river: "Seine" }), "en").say[1].text;
    expect(fr).toMatch(/national flood service/);
  });

  it("does not sound like an all-clear for a week", () => {
    const model = buildCallScript(src({ id: "m", name: "Paris", kind: "model", river: "Seine", country: "FR", status: "ok" }), "en").say[0].text;
    expect(model).toBe("For the Seine at Paris, the model does not show unusual river flow this week. This is not a guarantee and not an official forecast.");
    expect(buildCallScript(src({ id: "m", name: "Paris", kind: "model", status: "ok" }), "de").say[0].text).toMatch(/keine Garantie und keine amtliche Vorhersage/);
  });

  it("says a stale or non-live reading is from its time and states no level", () => {
    for (const lang of LANGS)
      for (const kind of KINDS) {
        const s = buildCallScript(src({ id: "x", name: "Köln", kind, status: "over", live: false, measuredAt: "2026-10-27T05:15:00Z" }), lang);
        expect(s.stale).toBe(true);
        expect(s.say[0].text).toContain("05:15 UTC, 27 Oct");
        expect(s.say[0].text).toMatch(/may be out of date|möglicherweise veraltet|puede estar desactualizada/);
        expect(s.say.map((l) => l.text).join(" ")).not.toMatch(/mean high water|mittleren Hochwasser|crecida|screening line|Prüfschwelle/);
      }
    expect(buildCallScript(src({ id: "x", name: "Köln", live: true }), "en").stale).toBe(false);
    expect(readingTime(null)).toBe("an unknown time");
    expect(readingTime("2026-10-27")).toBe("27 Oct (model day)");
  });

  it("uses the usual wording and localised names in German and Spanish", () => {
    const over = (lang: Lang) => buildCallScript(src({ id: "m", name: "Vienna", kind: "model", river: "Danube", country: "AT", status: "over" }), lang).say[0].text;
    expect(over("de")).toBe("Unser Modell zeigt für Wien (Donau) in den nächsten 7 Tagen einen mindestens doppelt so hohen Abfluss, wie in den letzten 30 Tagen üblich war.");
    expect(over("es")).toMatch(/Viena \(Danubio\).*al menos el doble del habitual/);
    expect(buildCallScript(src({ id: "g", name: "Köln", status: "ok", country: "ES" }), "es").say[0].text).toMatch(/^La estación de aforo/);
    for (const kind of KINDS)
      for (const status of STATUSES)
        expect(buildCallScript(src({ id: "x", name: "Köln", kind, status }), "es").say.map((l) => l.text).join(" ")).not.toMatch(/medidor/);
  });

  it("uses the national service in the right case in each language", () => {
    const fr = (lang: Lang) => buildCallScript(src({ id: "p", name: "Paris", kind: "model", country: "FR", river: "Seine", status: "ok" }), lang).say[2].text;
    expect(fr("de")).toBe("Bitte prüfen Sie die aktuellen Warnungen und Warnstufen beim nationalen Warndienst (Meteoalarm).");
    expect(fr("en")).toMatch(/your national warning service \(Meteoalarm\)/);
  });

  it("keeps prompts away from 'safe'", () => {
    expect(forecastQuestion(src({ id: "g", name: "Köln" }))).not.toMatch(/safe/i);
  });
});

describe("review round 1: coverage and the outlook gate", () => {
  const ok = [
    { name: "gauge_levels", state: "rows" },
    { name: "eu_watch", state: "rows" },
    { name: "hazard_now", state: "rows" },
  ];

  it("says all 45 only when 45 loaded and nothing failed", () => {
    expect(coverageOf(45, ok)).toMatchObject({ partial: false, text: "All 45 sources loaded." });
  });

  it("names the failed views and warns when sources are missing", () => {
    const c = coverageOf(34, [ok[0], { name: "eu_watch", state: "unavailable" }, ok[2]]);
    expect(c.partial).toBe(true);
    expect(c.failed).toEqual(["eu_watch"]);
    expect(c.text).toMatch(/^34 of 45 sources loaded\. Not loaded: eu_watch\./);
    expect(c.text).not.toMatch(/All 45/);
    expect(coverageOf(40, ok).partial).toBe(true);
    expect(coverageOf(0, [{ name: "gauge_levels", state: "loading" }]).partial).toBe(false);
  });

  it("flags partial data and the live flag in the brief", () => {
    const s = src({ id: "gauge:KÖLN", name: "Köln", status: "over", live: false, measuredAt: "2026-10-27T05:15:00Z" });
    const group = buildRiverGroups([s])[0];
    const text = buildBrief({
      now: new Date("2026-10-27T13:41:00Z"),
      source: s,
      group,
      measuredText: "Measured 27 Oct, 05:15 UTC",
      evidence: null,
      coverage: coverageOf(34, [ok[0], { name: "eu_watch", state: "unavailable" }, ok[2]]),
      forecast: null,
      outlookLines: [],
      historyLines: [],
      runQueryIds: [],
      script: buildCallScript(s, "en"),
    });
    expect(text).toContain("WARNING, PARTIAL DATA: 34 of 45 sources loaded. Not loaded: eu_watch.");
    expect(text).toContain("NOT LIVE (stale, seed or no model reading)");
    expect(text).toContain("Measured 27 Oct, 05:15 UTC");
    expect(text).toContain("This reading is from 05:15 UTC, 27 Oct and may be out of date");
  });

  it("posts a forecast run only when /config says the lane and live data are on", () => {
    expect(forecastLaneEnabled({ flags: { FF_FORECAST_LANE: true, FF_LIVE_DATA: true } })).toBe(true);
    expect(forecastLaneEnabled({ flags: { FF_FORECAST_LANE: false, FF_LIVE_DATA: true } })).toBe(false);
    expect(forecastLaneEnabled({ flags: { FF_FORECAST_LANE: true, FF_LIVE_DATA: false } })).toBe(false);
    expect(forecastLaneEnabled({ flags: {} })).toBe(false);
    expect(forecastLaneEnabled(null)).toBe(false);
  });

  it("does not post for a gauge whose name the router could send to another lane (Frankfurt1 (Oder))", () => {
    expect(outlookBlocked(src({ id: "gauge:FRANKFURT1 (ODER)", name: "Frankfurt1 (Oder)" }))).toMatch(/cannot be sent safely/);
    expect(outlookBlocked(src({ id: "gauge:KÖLN", name: "Köln" }))).toBeNull();
    expect(outlookBlocked(VAL)).toBeNull();
    expect(outlookBlocked(VIENNA)).toBeNull();
  });
});
