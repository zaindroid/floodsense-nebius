import type { ReplayClaim } from "../api/replay";
import type { AskContext } from "./askContext";
import type { WatchSource } from "./euWatch";
import type { ActionType } from "./hitl";
import type { LiveEvidence } from "./liveEvidence";
import { basisLabel, countryName, plainOf, statusView, timeWord, worstFirst, type StatusView } from "./places";
import { WARNING_LINKS, warningCountriesForCountry, type WarningLink } from "./safety";

/**
 * Civil protection desk (role = operator). Everything here is pure and deterministic: river groups and their
 * upstream-to-downstream order, the fixed call-script templates, the brief text and the run questions. No model
 * writes any line of the call script, and no template carries a number a source did not give (the only digits are
 * 112 and the "7 days" / "30 days" of the model band rules).
 */

/* ---------- River groups and order ---------- */

/** What PEGELONLINE's river_km means per water, checked against the gauge coordinates (Passau lies east of Regensburg, Frankfurt west of Würzburg, ...). */
export type KmDirection = "up" | "down";
/** "down": the kilometre grows towards the mouth (counted from the source or the border). "up": counted from the mouth, so it falls downstream. */
export const RIVER_KM_DIRECTION: Record<string, KmDirection> = {
  Rhine: "down",
  Elbe: "down",
  Oder: "down",
  Weser: "down",
  Danube: "up",
  Main: "up",
  Mosel: "up",
  Neckar: "up",
  Saar: "up",
};

export interface RiverGroup {
  key: string;
  country: string;
  /** Display name; "Valencia area" for the model points that have no river. */
  river: string;
  label: string;
  /** In display order: upstream to downstream when `ordered` is "km", else the list order of the views. */
  sources: WatchSource[];
  ordered: "km" | "list";
}

const NO_RIVER = "Valencia area";

export function riverLabelOf(s: WatchSource): string {
  return s.river || (s.kind === "valencia" ? NO_RIVER : s.name);
}

/** Pure: upstream to downstream by river kilometre, only when every source has one and the water's direction is known. Otherwise the given order. */
export function orderAlongRiver(river: string, sources: readonly WatchSource[]): { sources: WatchSource[]; ordered: "km" | "list" } {
  const direction = RIVER_KM_DIRECTION[river];
  const kms = sources.map((s) => (typeof s.riverKm === "number" && Number.isFinite(s.riverKm) ? s.riverKm : null));
  if (!direction || sources.length < 2 || kms.some((k) => k === null)) return { sources: [...sources], ordered: "list" };
  const paired = sources.map((s, i) => ({ s, km: kms[i] as number }));
  paired.sort((a, b) => (direction === "down" ? a.km - b.km : b.km - a.km));
  return { sources: paired.map((p) => p.s), ordered: "km" };
}

/** Pure: the 45 watch sources grouped by country and river, countries and rivers alphabetical. */
export function buildRiverGroups(sources: readonly WatchSource[]): RiverGroup[] {
  const by = new Map<string, { country: string; river: string; list: WatchSource[] }>();
  for (const s of sources) {
    const country = s.country.toUpperCase();
    const river = riverLabelOf(s);
    const key = `${country}|${river}`;
    const g = by.get(key);
    if (g) g.list.push(s);
    else by.set(key, { country, river, list: [s] });
  }
  const groups: RiverGroup[] = [...by.entries()].map(([key, g]) => {
    const { sources: ordered, ordered: how } = orderAlongRiver(g.river, g.list);
    return {
      key,
      country: g.country,
      river: g.river,
      label: `${g.river} (${ordered.length})`,
      sources: ordered,
      ordered: how,
    };
  });
  return groups.sort((a, b) => countryName(a.country).localeCompare(countryName(b.country)) || a.river.localeCompare(b.river));
}

/** Pure: the countries that have a group, in order. */
export function groupCountries(groups: readonly RiverGroup[]): string[] {
  return [...new Set(groups.map((g) => g.country))];
}

/** Pure: the group that holds the worst source, else the first group, else null. */
export function defaultGroup(groups: readonly RiverGroup[], sources: readonly WatchSource[]): RiverGroup | null {
  const worst = worstFirst(sources)[0];
  const hit = worst ? groups.find((g) => g.sources.some((s) => s.id === worst.id)) : undefined;
  return hit ?? groups[0] ?? null;
}

/** Pure: the source to brief on inside a group: the picked one if it is in the group, else its worst. */
export function focusSource(group: RiverGroup | null, pickedId: string | null): WatchSource | null {
  if (!group) return null;
  return group.sources.find((s) => s.id === pickedId) ?? worstFirst(group.sources)[0] ?? null;
}

/** Pure: other countries that watch the same river, so a wave crossing a border is not missed. */
export function sameRiverElsewhere(groups: readonly RiverGroup[], group: RiverGroup): string[] {
  if (group.river === NO_RIVER) return [];
  return groups.filter((g) => g.river === group.river && g.country !== group.country).map((g) => countryName(g.country));
}

/** Pure: the line that says how the order was found. */
export function orderLine(group: RiverGroup): string {
  if (group.sources.length < 2) return "One watched source on this river.";
  return group.ordered === "km"
    ? "Upstream to downstream, by PEGELONLINE river kilometre. A rise usually travels in this direction."
    : "In the order of the watch list: the views give no river kilometre for these points, so this is not a flow order.";
}

/* ---------- Run questions and contexts ---------- */

const STATION_OK = /^[A-Za-zÄÖÜäöüß .-]{2,40}$/;
const PLACE_OK = /^[\p{L}\p{N}_ .,'()-]{1,64}$/u;

/** Pure: the run context for a source. The agents' RunContext checks each pattern, so a value that would be refused is left out. */
export function operatorContext(s: WatchSource, page = "situation"): AskContext {
  const ctx: AskContext = { role: "operator", page };
  if (PLACE_OK.test(s.name)) ctx.place = s.name;
  const station = s.kind === "gauge" ? s.id.slice("gauge:".length) : "";
  if (station && STATION_OK.test(station)) ctx.station = station;
  const pid = /^valencia:([A-Z]{3}\d{2})$/.exec(s.id)?.[1];
  if (pid) ctx.point_id = pid;
  return ctx;
}

/** The forecast lane's question: a forecast cue plus the place name routes it to the deterministic lane (no model call). */
export function forecastQuestion(s: WatchSource): string {
  return `What does the next 48 hours outlook show for ${s.name}?`;
}

/**
 * The full-run question. "Draft an alert" is a router word for the deep lane, so it reaches the Playbook and the
 * human review step, not the quick forecast answer.
 */
export function escalationQuestion(s: WatchSource, status: StatusView): string {
  const where = `${s.name}${s.river ? ` on the ${s.river}` : ""}`;
  return (
    `Assess the flood situation at ${where} for civil protection: the source reads "${status.word}". ` +
    `What should the authority tell the public, and what support should it request? Draft an alert for the public.`
  );
}

/** Tracked-run key: the Approvals page of this desk lists only runs whose key starts with it. */
export const OPERATOR_RUN_PREFIX = "operator:";
export const operatorRunKey = (s: WatchSource): string => `${OPERATOR_RUN_PREFIX}${s.id}`;
export const isOperatorRunKey = (key: string): boolean => key.startsWith(OPERATOR_RUN_PREFIX);

/** Authority wording for the playbook action types. The agents' four types are reused; only the label changes. */
export const OPERATOR_ACTION_LABELS: Record<ActionType, string> = {
  "inform-public": "Inform public",
  "notify-policyholders": "Inform public",
  "dispatch-loss-adjuster": "Request support",
  "flag-underwriting-review": "Internal review",
};

export function operatorActionChip(type: ActionType | null): string {
  return type ? OPERATOR_ACTION_LABELS[type] : "Action";
}

/* ---------- Call script ---------- */

export type Lang = "en" | "de" | "es";
export const LANG_LABEL: Record<Lang, string> = { en: "English", de: "Deutsch", es: "Español" };

/** German and English always; Spanish for a Spanish place. */
export function languagesFor(country: string): Lang[] {
  return country.toUpperCase() === "ES" ? ["en", "de", "es"] : ["en", "de"];
}

/** The four kinds of source a script line can rest on. Their numbers are fixed so [1]..[4] mean the same on every script. */
export type ScriptSrc = "reading" | "rule" | "official" | "house";
export const SCRIPT_SRC_NUMBER: Record<ScriptSrc, number> = { reading: 1, rule: 2, official: 3, house: 4 };

export interface ScriptLine {
  text: string;
  src: ScriptSrc[];
}

export type ScriptKey = `${"gauge" | "model" | "demo"}-${"ok" | "near" | "over"}` | "unknown";

/** Pure: which template a source's status uses. */
export function scriptKey(kind: WatchSource["kind"], status: WatchSource["status"]): ScriptKey {
  if (status === "unknown") return "unknown";
  const k = kind === "valencia" ? "demo" : kind;
  return `${k}-${status}` as ScriptKey;
}

export const SCRIPT_KEYS: readonly ScriptKey[] = [
  "gauge-ok", "gauge-near", "gauge-over", "model-ok", "model-near", "model-over", "demo-ok", "demo-near", "demo-over", "unknown",
];

const RIVER_DE: Record<string, string> = {
  Rhine: "Rhein", Danube: "Donau", Vistula: "Weichsel", Meuse: "Maas", Vltava: "Moldau", Tisza: "Theiß", Rhone: "Rhône",
};
const RIVER_ES: Record<string, string> = {
  Rhine: "Rin", Danube: "Danubio", Vistula: "Vístula", Meuse: "Mosa", Vltava: "Moldava", Rhone: "Ródano", Seine: "Sena",
};
const PLACE_DE: Record<string, string> = { Vienna: "Wien", Prague: "Prag", Warsaw: "Warschau", Liege: "Lüttich", Orleans: "Orléans" };
const PLACE_ES: Record<string, string> = { Vienna: "Viena", Prague: "Praga", Warsaw: "Varsovia", Liege: "Lieja" };

/** Pure: "13:15 UTC, 27 Oct" for a reading time, "27 Oct (model day)" for a model day, else "an unknown time". */
export function readingTime(iso: string | null): string {
  if (!iso) return "an unknown time";
  const date = iso.length === 10;
  const d = new Date(date ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  if (date) return `${day} (model day)`;
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${hm} UTC, ${day}`;
}

interface Names {
  /** "Rhine gauge at Köln" (en), "Köln (Rhein)" (de), "Köln (Rin)" (es): follows "The" / "Der Pegel" / "La estación de aforo". */
  gauge: string;
  /** "the Rhine at Köln" (en), "Köln (Rhein)" (de, es): the place in a model sentence. */
  where: string;
  /** "Köln" */
  name: string;
}

// No line below says a level is "normal" or "safe", and none calls a level "not a warning level": the official
// warning levels belong to the Land's (or the country's) flood service, and staff are told to check them.
const STATE: Record<Lang, Record<ScriptKey, (n: Names) => string>> = {
  en: {
    "gauge-ok": (n) => `The ${n.gauge} shows a level below its long-term mean high water.`,
    "gauge-near": (n) => `The ${n.gauge} is close to its long-term mean high water.`,
    "gauge-over": (n) => `The ${n.gauge} is at or above its long-term mean high water.`,
    "model-ok": (n) => `For ${n.where}, the model does not show unusual river flow this week. This is not a guarantee and not an official forecast.`,
    "model-near": (n) => `Over the next 7 days our model shows river flow for ${n.where} somewhat above what has been usual in the last 30 days.`,
    "model-over": (n) => `Over the next 7 days our model shows river flow for ${n.where} at least twice what has been usual in the last 30 days.`,
    "demo-ok": (n) => `Our model shows river flow at ${n.name} below FloodSense's own screening line. This is not a guarantee.`,
    "demo-near": (n) => `Our model shows river flow at ${n.name} above FloodSense's first screening line. That is not an official threshold.`,
    "demo-over": (n) => `Our model shows river flow at ${n.name} above FloodSense's higher screening line. That is not an official threshold.`,
    unknown: (n) => `We have no current reading for ${n.name}.`,
  },
  de: {
    "gauge-ok": (n) => `Der Pegel ${n.gauge} zeigt einen Wasserstand unter dem langjährigen mittleren Hochwasser.`,
    "gauge-near": (n) => `Der Pegel ${n.gauge} liegt nahe am langjährigen mittleren Hochwasser.`,
    "gauge-over": (n) => `Der Pegel ${n.gauge} liegt auf oder über dem langjährigen mittleren Hochwasser.`,
    "model-ok": (n) => `Für ${n.where} zeigt das Modell diese Woche keinen ungewöhnlichen Abfluss. Das ist keine Garantie und keine amtliche Vorhersage.`,
    "model-near": (n) => `Unser Modell zeigt für ${n.where} in den nächsten 7 Tagen einen etwas höheren Abfluss, als in den letzten 30 Tagen üblich war.`,
    "model-over": (n) => `Unser Modell zeigt für ${n.where} in den nächsten 7 Tagen einen mindestens doppelt so hohen Abfluss, wie in den letzten 30 Tagen üblich war.`,
    "demo-ok": (n) => `Unser Modell zeigt für ${n.name} einen Abfluss unter der FloodSense-eigenen Prüfschwelle. Das ist keine Garantie.`,
    "demo-near": (n) => `Unser Modell zeigt für ${n.name} einen Abfluss über der ersten FloodSense-eigenen Prüfschwelle. Das ist kein amtlicher Schwellenwert.`,
    "demo-over": (n) => `Unser Modell zeigt für ${n.name} einen Abfluss über der höheren FloodSense-eigenen Prüfschwelle. Das ist kein amtlicher Schwellenwert.`,
    unknown: (n) => `Für ${n.name} liegt uns gerade kein aktueller Messwert vor.`,
  },
  es: {
    "gauge-ok": (n) => `La estación de aforo ${n.gauge} muestra un nivel por debajo de su nivel medio de crecida a largo plazo.`,
    "gauge-near": (n) => `La estación de aforo ${n.gauge} está cerca de su nivel medio de crecida a largo plazo.`,
    "gauge-over": (n) => `La estación de aforo ${n.gauge} está en o por encima de su nivel medio de crecida a largo plazo.`,
    "model-ok": (n) => `Para ${n.where}, el modelo no muestra un caudal inusual esta semana. No es una garantía ni una previsión oficial.`,
    "model-near": (n) => `Para los próximos 7 días, nuestro modelo muestra en ${n.where} un caudal algo superior al habitual de los últimos 30 días.`,
    "model-over": (n) => `Para los próximos 7 días, nuestro modelo muestra en ${n.where} un caudal de al menos el doble del habitual de los últimos 30 días.`,
    "demo-ok": (n) => `Nuestro modelo muestra un caudal en ${n.name} por debajo de la línea de control propia de FloodSense. No es una garantía.`,
    "demo-near": (n) => `Nuestro modelo muestra un caudal en ${n.name} por encima de la primera línea de control de FloodSense. No es un umbral oficial.`,
    "demo-over": (n) => `Nuestro modelo muestra un caudal en ${n.name} por encima de la línea de control más alta de FloodSense. No es un umbral oficial.`,
    unknown: (n) => `No tenemos una lectura actual para ${n.name}.`,
  },
};

const STALE: Record<Lang, (time: string) => string> = {
  en: (t) => `This reading is from ${t} and may be out of date. Do not read it out as the current situation.`,
  de: (t) => `Dieser Wert stammt von ${t} und ist möglicherweise veraltet. Bitte nicht als aktuelle Lage vorlesen.`,
  es: (t) => `Esta lectura es de ${t} y puede estar desactualizada. No la lea como la situación actual.`,
};

const LIMIT: Record<Lang, { gauge: string; model: string; unknown: string }> = {
  en: {
    gauge: "This is a measurement of the water level, not a forecast.",
    model: "This is a model, not a measurement and not an official warning.",
    unknown: "So I cannot tell you how the river is doing there right now.",
  },
  de: {
    gauge: "Das ist eine Messung des Wasserstands, keine Vorhersage.",
    model: "Das ist eine Modellrechnung, keine Messung und keine amtliche Warnung.",
    unknown: "Ich kann Ihnen daher jetzt nicht sagen, wie die Lage dort ist.",
  },
  es: {
    gauge: "Esto es una medición del nivel de agua, no una previsión.",
    model: "Esto es un modelo, no una medición ni un aviso oficial.",
    unknown: "Por eso ahora no puedo decirle cómo está el río allí.",
  },
};

/** Added after a raised gauge: the warning levels are the flood service's, not FloodSense's. */
const LEVELS: Record<Lang, { de: string; other: string }> = {
  en: {
    de: "Official flood warning levels (Meldestufen) are set by your Land's flood service. Check them.",
    other: "Official warning levels are set by your national flood service. Check them.",
  },
  de: {
    de: "Die amtlichen Meldestufen legt der Hochwassermeldedienst Ihres Landes fest. Bitte prüfen Sie diese.",
    other: "Die amtlichen Warnstufen legt der nationale Hochwasserdienst fest. Bitte prüfen Sie diese.",
  },
  es: {
    de: "Los niveles de aviso oficiales los fija el servicio de inundaciones de su Land. Compruébelos.",
    other: "Los niveles de aviso oficiales los fija su servicio nacional de inundaciones. Compruébelos.",
  },
};

const OFFICIAL_LINE: Record<Lang, { list: (channels: string) => string; national: string }> = {
  en: {
    list: (c) => `Please check the official warning service for current warnings and warning levels: ${c}.`,
    national: "Please check your national warning service (Meteoalarm) for current warnings and warning levels.",
  },
  de: {
    list: (c) => `Bitte prüfen Sie die aktuellen Warnungen und Warnstufen bei den amtlichen Stellen: ${c}.`,
    national: "Bitte prüfen Sie die aktuellen Warnungen und Warnstufen beim nationalen Warndienst (Meteoalarm).",
  },
  es: {
    list: (c) => `Compruebe los avisos y niveles de aviso vigentes en los canales oficiales: ${c}.`,
    national: "Compruebe los avisos y niveles de aviso vigentes en su servicio nacional de avisos (Meteoalarm).",
  },
};

const EMERGENCY: Record<Lang, string> = {
  en: "In an emergency call 112.",
  de: "Im Notfall rufen Sie die 112 an.",
  es: "En una emergencia llame al 112.",
};

/** Object of "refer to ...": accusative in German. */
const NATIONAL: Record<Lang, string> = {
  en: "your national warning service (Meteoalarm)",
  de: "den nationalen Warndienst (Meteoalarm)",
  es: "su servicio nacional de avisos (Meteoalarm)",
};

/** The channels named in the spoken line. They match the allowlisted links shown under the script (safety.ts). */
const DE_CHANNELS: Record<Lang, string> = {
  en: "the NINA warning app, warnung.bund.de, the DWD weather warnings and the flood centres of the Länder",
  de: "die NINA-Warn-App, warnung.bund.de, die DWD-Wetterwarnungen und die Hochwasserzentralen der Länder",
  es: "la app NINA, warnung.bund.de, los avisos del DWD y los centros de inundaciones de los Länder",
};
const ES_CHANNELS = "Protección Civil, AEMET";
const ES_VALENCIA_CHANNELS = "Protección Civil, AEMET, 112 Comunitat Valenciana";

const REFER_DE: Record<Lang, string> = {
  en: "the Hochwassermeldedienst of your Land",
  de: "den Hochwassermeldedienst Ihres Landes",
  es: "el Hochwassermeldedienst de su Land",
};

const CAN: Record<Lang, [string, string, string, string]> = {
  en: [
    "Read out the status lines above: what the gauge or model shows, nothing more.",
    "Say that FloodSense is a model-based screening and not an official warning.",
    "Give the official channels listed above.",
    "Tell callers to call 112 in an emergency.",
  ],
  de: [
    "Die Statuszeilen oben vorlesen: was der Pegel oder das Modell zeigt, nicht mehr.",
    "Sagen, dass FloodSense eine modellbasierte Einschätzung und keine amtliche Warnung ist.",
    "Die oben genannten amtlichen Stellen nennen.",
    "Anrufern sagen: im Notfall die 112 anrufen.",
  ],
  es: [
    "Leer las líneas de estado de arriba: lo que muestra la estación de aforo o el modelo, nada más.",
    "Decir que FloodSense es una evaluación basada en modelos y no un aviso oficial.",
    "Indicar los canales oficiales de arriba.",
    "Decir a quien llama que llame al 112 en una emergencia.",
  ],
};

const MUST_NOT: Record<Lang, { forecast: (refer: string) => string; rest: [string, string, string] }> = {
  en: {
    forecast: (r) => `Do not give a flood forecast of your own; refer to ${r}.`,
    rest: [
      "Do not say that an area is safe, or that it will or will not flood.",
      "Do not give evacuation, sandbag or travel instructions unless your own incident command has issued them.",
      "Do not read out model values as if they were measurements or warnings.",
    ],
  },
  de: {
    forecast: (r) => `Keine eigene Hochwasservorhersage geben; verweisen Sie auf ${r}.`,
    rest: [
      "Nicht sagen, ein Gebiet sei sicher oder werde (nicht) überflutet.",
      "Keine Evakuierungs-, Sandsack- oder Reisehinweise geben, die Ihre Einsatzleitung nicht selbst herausgegeben hat.",
      "Modellwerte nicht wie Messwerte oder Warnungen vorlesen.",
    ],
  },
  es: {
    forecast: (r) => `No dar una previsión de inundación propia; remita a ${r}.`,
    rest: [
      "No decir que una zona es segura, ni que se inundará o no.",
      "No dar instrucciones de evacuación, sacos de arena o viaje que no haya emitido su propio mando de incidente.",
      "No leer valores del modelo como si fueran mediciones o avisos.",
    ],
  },
};

export const SCRIPT_FOOTER = "Model-based screening, not an official warning";
const FOOTER_LOCAL: Record<Lang, string | null> = {
  en: null,
  de: "Modellbasierte Einschätzung, keine amtliche Warnung",
  es: "Evaluación basada en modelos, no es un aviso oficial",
};

export interface ScriptChannel {
  group: string;
  links: readonly WarningLink[];
}

export interface CallScript {
  lang: Lang;
  key: ScriptKey;
  status: StatusView;
  /** True when the reading is not live: the script then says it may be out of date and states no level. */
  stale: boolean;
  /** "What to tell callers": three or four lines. */
  say: ScriptLine[];
  channels: ScriptChannel[];
  canSay: ScriptLine[];
  mustNot: ScriptLine[];
  footer: string;
  footerLocal: string | null;
}

/** The 112 line of the Comunitat Valenciana is only for the Valencia points; another Spanish place gets the national services. */
const VALENCIA_ONLY = /^112 Comunitat/;

function channelsFor(country: string, kind?: WatchSource["kind"]): ScriptChannel[] {
  const local = country.toUpperCase() === "ES" && kind !== undefined && kind !== "valencia";
  return warningCountriesForCountry(country).map((c) => ({
    group: local && c === "es" ? "Spain" : WARNING_LINKS[c].title,
    links: local && c === "es" ? WARNING_LINKS[c].links.filter((l) => !VALENCIA_ONLY.test(l.label)) : WARNING_LINKS[c].links,
  }));
}

/**
 * Pure: a fixed template filled from the status and the place's names. Same input, same output; no model call.
 * A source that is not live (stale gauge, seed or missing model reading) never has its state read out: the script
 * says the reading is from its time and may be out of date.
 */
export function buildCallScript(s: WatchSource, lang: Lang): CallScript {
  const key = scriptKey(s.kind, s.status);
  const status = statusView(s.kind, s.status);
  const de = s.country.toUpperCase() === "DE";
  const stale = key !== "unknown" && !s.live;
  const river = lang === "de" ? (RIVER_DE[s.river] ?? s.river) : lang === "es" ? (RIVER_ES[s.river] ?? s.river) : s.river;
  const place = lang === "de" ? (PLACE_DE[s.name] ?? s.name) : lang === "es" ? (PLACE_ES[s.name] ?? s.name) : s.name;
  const names: Names =
    lang === "en"
      ? { gauge: river ? `${river} gauge at ${place}` : `gauge at ${place}`, where: river ? `the ${river} at ${place}` : place, name: place }
      : { gauge: river ? `${place} (${river})` : place, where: river ? `${place} (${river})` : place, name: place };
  const limitKind = key === "unknown" || stale ? "unknown" : s.kind === "gauge" ? "gauge" : "model";
  const channels = channelsFor(s.country, s.kind);
  const es = s.country.toUpperCase() === "ES";
  const official = OFFICIAL_LINE[lang];
  const officialText = de
    ? official.list(DE_CHANNELS[lang])
    : es
      ? official.list(s.kind === "valencia" ? ES_VALENCIA_CHANNELS : ES_CHANNELS)
      : official.national;
  const raised = !stale && s.kind === "gauge" && (key === "gauge-near" || key === "gauge-over");
  const limit = `${LIMIT[lang][limitKind]}${raised ? ` ${de ? LEVELS[lang].de : LEVELS[lang].other}` : ""}`;
  const say: ScriptLine[] = [
    stale
      ? { text: STALE[lang](readingTime(s.measuredAt)), src: ["reading"] }
      : { text: STATE[lang][key](names), src: ["reading", "rule"] },
    { text: limit, src: [limitKind === "gauge" ? "reading" : "rule"].concat(raised ? ["official"] : []) as ScriptSrc[] },
    { text: officialText, src: ["official"] },
    { text: EMERGENCY[lang], src: ["official"] },
  ];
  const refer = de ? REFER_DE[lang] : NATIONAL[lang];
  const can = CAN[lang];
  const must = MUST_NOT[lang];
  return {
    lang,
    key,
    status,
    stale,
    say,
    channels,
    canSay: [
      { text: can[0], src: ["reading", "rule"] },
      { text: can[1], src: ["house"] },
      { text: can[2], src: ["official"] },
      { text: can[3], src: ["official"] },
    ],
    mustNot: [
      { text: must.forecast(refer), src: ["house"] },
      ...must.rest.map((t): ScriptLine => ({ text: t, src: ["house"] })),
    ],
    footer: SCRIPT_FOOTER,
    footerLocal: FOOTER_LOCAL[lang],
  };
}

/** "[1][2]" for a line's sources, in number order. */
export function badgeText(src: readonly ScriptSrc[]): string {
  return [...src]
    .map((x) => SCRIPT_SRC_NUMBER[x])
    .sort((a, b) => a - b)
    .map((n) => `[${n}]`)
    .join("");
}

export interface ScriptSource {
  n: number;
  src: ScriptSrc;
  heading: string;
  text: string;
}

/** Pure: the numbered source list under the script. [1] carries the Zetaris query id when the view gave one. */
export function scriptSources(s: WatchSource, evidence: LiveEvidence | null, measuredText: string): ScriptSource[] {
  const country = s.country.toUpperCase();
  const groups = channelsFor(country, s.kind).map((c) => c.group).join(", ");
  return [
    {
      n: 1,
      src: "reading",
      heading: "Data via Zetaris",
      text: `${evidence?.view ?? (s.kind === "gauge" ? "floodsense.gauge_levels" : "floodsense.eu_watch")} · ${measuredText}${evidence?.queryId ? ` · query ${evidence.queryId}` : ""}`,
    },
    { n: 2, src: "rule", heading: "FloodSense status rule", text: `${timeWord(s.kind)} · ${basisLabel(s.kind)}` },
    { n: 3, src: "official", heading: "Official warning services", text: `${groups} (verified allowlist in the app's safety module)` },
    {
      n: 4,
      src: "house",
      heading: "Call-script template",
      text: "Fixed wording written by the FloodSense team. No model wrote it. Agree it with your agency before using it on a line.",
    },
  ];
}

/* ---------- Forecast lane and history ---------- */

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export interface ForecastBrief {
  runId: string;
  /** FloodSense screening word: Normal, Watch or Elevated. Never an official level. */
  status: string | null;
  /** Status plus its driver, e.g. "Elevated (river model)"; null on older runs. */
  statusLabel: string | null;
  statusReason: string | null;
  lead: string;
  screening: string | null;
  gaps: string[];
  disclaimer: string | null;
  attribution: string | null;
  servedFrom: string | null;
}

/** Pure: the `forecast` object of a finished forecast-lane run (agents nodes/forecast.py), or null. */
export function forecastBriefFrom(body: Record<string, unknown> | null, runId: string): ForecastBrief | null {
  if (!body || body.lane !== "forecast" || body.status !== "answered") return null;
  const f = rec(body.forecast);
  const lead = f && str(f.lead);
  if (!f || !lead) return null;
  return {
    runId,
    status: str(f.status),
    statusLabel: str(f.status_label),
    statusReason: str(f.status_reason),
    lead,
    screening: str(f.screening),
    gaps: Array.isArray(f.gaps) ? f.gaps.filter((g): g is string => typeof g === "string" && g.trim().length > 0) : [],
    disclaimer: str(f.disclaimer),
    attribution: str(f.attribution),
    servedFrom: str(body.served_from),
  };
}

/** The screening status with its driver as a chip: red is reserved for a gauge above mean high water, so a rain screening is never red. */
export function screeningView(status: string | null, label?: string | null): StatusView {
  const word = (fallback: string) => label?.trim() || fallback;
  if (status === "Normal") return { word: word("Normal"), tone: "normal", rank: 8 };
  if (status === "Watch") return { word: word("Watch"), tone: "watch", rank: 3 };
  // "Warning" is the word older recorded runs carry; it is shown as Elevated, never as a warning.
  if (status === "Elevated" || status === "Warning") return { word: word("Elevated"), tone: "elevated", rank: 1 };
  return { word: "No screening", tone: "unknown", rank: 9 };
}

export type HistoryKind = "pattern" | "memory" | "report";

export interface HistoryItem {
  kind: HistoryKind;
  /** Framed as the past, with what it is. */
  heading: string;
  claim: ReplayClaim;
}

const HISTORY_HEADING: Record<HistoryKind, string> = {
  pattern: "A past flood, from the replay data",
  memory: "Remembered from an earlier approved run (context, not a measurement)",
  report: "From a published report",
};

function historyKind(c: ReplayClaim): HistoryKind | null {
  if (/^Past pattern:/i.test(c.text)) return "pattern";
  if (/^Approved memory/i.test(c.text)) return "memory";
  if (c.citations.some((x) => x.layer === "c")) return "report";
  return null;
}

/** Pure: the forecast run's claims split into the outlook (current data) and "what has happened here before". */
export function splitForecastClaims(claims: readonly ReplayClaim[]): { outlook: ReplayClaim[]; history: HistoryItem[] } {
  const outlook: ReplayClaim[] = [];
  const history: HistoryItem[] = [];
  for (const claim of claims) {
    const kind = historyKind(claim);
    if (kind) history.push({ kind, heading: HISTORY_HEADING[kind], claim });
    else outlook.push(claim);
  }
  return { outlook, history };
}

/* ---------- Brief ---------- */

/* ---------- Coverage and the outlook gate ---------- */

export const WATCH_TOTAL = 45;

export interface ViewState {
  /** The view's name: gauge_levels, eu_watch, hazard_now. */
  name: string;
  state: string;
}

export interface Coverage {
  loaded: number;
  failed: string[];
  loading: boolean;
  partial: boolean;
  text: string;
}

/** Pure: "N of 45 sources loaded" and the views that did not answer. Never says "all" unless all 45 are in. */
export function coverageOf(loaded: number, views: readonly ViewState[]): Coverage {
  const loading = views.some((v) => v.state === "loading");
  const failed = views.filter((v) => v.state === "unavailable" || v.state === "error" || v.state === "empty").map((v) => v.name);
  const partial = !loading && (failed.length > 0 || loaded < WATCH_TOTAL);
  const text = loading
    ? `${loaded} of ${WATCH_TOTAL} sources loaded so far.`
    : partial
      ? `${loaded} of ${WATCH_TOTAL} sources loaded.${failed.length ? ` Not loaded: ${failed.join(", ")}.` : ""} This board is incomplete: a river or place that is missing here is not "normal", it is unknown.`
      : `All ${WATCH_TOTAL} sources loaded.`;
  return { loaded, failed, loading, partial, text };
}

/** Pure: true only when /config says the forecast lane is on and live data is on (otherwise the router sends the question to the full lane). */
export function forecastLaneEnabled(config: unknown): boolean {
  const flags = rec(rec(config)?.flags);
  return flags?.FF_FORECAST_LANE === true && flags?.FF_LIVE_DATA === true;
}

/**
 * Pure: null when the question for this place is known to route to the forecast lane, else why not. A gauge whose
 * shortname fails the RunContext pattern (digits or brackets, e.g. "FRANKFURT1 (ODER)") is named only in the
 * question, which the router may send to the quick or the full lane, so no run is posted for it.
 */
export function outlookBlocked(s: WatchSource): string | null {
  if (s.kind === "gauge") {
    const station = s.id.slice("gauge:".length);
    if (!STATION_OK.test(station)) return `the gauge name "${station}" cannot be sent safely to the forecast lane`;
  }
  if (!PLACE_OK.test(s.name)) return "the place name cannot be sent to the forecast lane";
  return null;
}

export interface BriefInput {
  now: Date;
  source: WatchSource;
  /** The group in display order, each with the status the board shows. */
  group: RiverGroup;
  measuredText: string;
  evidence: LiveEvidence | null;
  /** How many of the 45 sources loaded; a partial board is flagged at the top of the brief. */
  coverage?: Coverage;
  forecast: ForecastBrief | null;
  /** Outlook and history sentences. Their marks are [R1], [R2], ... so they never collide with the script's [1]..[4]. */
  outlookLines: string[];
  historyLines: string[];
  /** One line per [Rn]: what the source is and its query id. */
  runRefs?: string[];
  /** Query ids of the forecast run's data citations. */
  runQueryIds: string[];
  script: CallScript;
}

function utc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** Pure: the plain-text brief that "Copy brief" puts on the clipboard. Time, sources, query ids; no invented lines. */
export function buildBrief(input: BriefInput): string {
  const { source: s, group, script } = input;
  const out: string[] = [];
  out.push("FloodSense EU · Civil protection brief");
  out.push(`Created: ${utc(input.now)} (this browser's clock)`);
  out.push(`Place: ${s.name}${s.river ? `, ${s.river}` : ""}, ${countryName(s.country)}`);
  if (input.coverage?.partial) out.push(`WARNING, PARTIAL DATA: ${input.coverage.text}`);
  out.push(
    `Status: ${script.status.word} · ${input.measuredText} · ${s.live ? "live reading" : "NOT LIVE (stale, seed or no model reading): may be out of date, do not read it out as current"} · ${basisLabel(s.kind)}`,
  );
  out.push("");
  out.push(`${group.river} (${countryName(group.country)}), ${group.ordered === "km" ? "upstream to downstream" : "watch-list order, not a flow order"}:`);
  group.sources.forEach((x, i) => out.push(`  ${i + 1}. ${x.name}: ${plainOf(x).word}${x.id === s.id ? "  <- this place" : ""}`));
  out.push("");
  out.push("Next 48 hours (forecast lane, no model call):");
  if (input.forecast) {
    out.push(`  ${input.forecast.lead}`);
    for (const line of input.outlookLines) out.push(`  ${line}`);
    for (const gap of input.forecast.gaps) out.push(`  Gap: ${gap}`);
    const served = input.forecast.servedFrom;
    out.push(`  Run ${input.forecast.runId}${served ? ` · ${served === "live" ? "live" : `${served}, not live`}` : ""}`);
  } else {
    out.push("  Not available when this brief was copied.");
  }
  out.push("");
  out.push("What has happened here before (past, not a prediction):");
  if (input.historyLines.length) for (const line of input.historyLines) out.push(`  ${line}`);
  else out.push("  No earlier event is stored for this place.");
  out.push("");
  out.push(`Call script (${LANG_LABEL[script.lang]}):`);
  for (const line of script.say) out.push(`  ${badgeText(line.src)} ${line.text}`);
  out.push("Official channels:");
  for (const c of script.channels) for (const l of c.links) out.push(`  ${l.label}: ${l.url}`);
  out.push("");
  if (input.runRefs?.length) {
    out.push("Sources of the outlook and the past:");
    for (const line of input.runRefs) out.push(`  ${line}`);
    out.push("");
  }
  out.push("Sources of the call script:");
  const sources = scriptSources(s, input.evidence, input.measuredText);
  for (const src of sources) out.push(`  [${src.n}] ${src.heading}: ${src.text}`);
  const ids = [...new Set([...(input.evidence?.queryId ? [input.evidence.queryId] : []), ...input.runQueryIds])];
  out.push(`Query ids: ${ids.length ? ids.join(", ") : "none given by the views"}`);
  out.push("");
  out.push(`${script.footer}.`);
  return out.join("\n");
}
