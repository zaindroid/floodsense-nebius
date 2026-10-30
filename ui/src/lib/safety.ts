/**
 * General safety guidance a citizen sees before any reviewed, tailored step.
 * Not written for the UI: CITIZEN_ADVICE is verbatim the advice the agents already append to every
 * citizen answer (agents/floodsense_agents/live.py, CITIZEN_ADVICE). safety.test.ts fails if the two drift.
 * WARNING_LINKS is the only place official warning-service URLs live (allowlist in safety.test.ts).
 */
export type WarningCountry = "de" | "es" | "eu";

export interface WarningLink {
  label: string;
  url: string;
}

export const WARNING_LINKS: Record<WarningCountry, { title: string; links: readonly WarningLink[] }> = {
  de: {
    title: "Germany",
    links: [
      { label: "NINA warning app (BBK)", url: "https://www.bbk.bund.de/DE/Warnung-Vorsorge/Warn-App-NINA/warn-app-nina_node.html" },
      { label: "Current warnings (warnung.bund.de)", url: "https://warnung.bund.de" },
      { label: "DWD weather warnings", url: "https://www.dwd.de/DE/wetter/warnungen_gemeinden/warnWetter_node.html" },
      { label: "Länder flood centres", url: "https://www.hochwasserzentralen.de" },
    ],
  },
  es: {
    title: "Spain · Valencia",
    links: [
      { label: "Protección Civil", url: "https://www.proteccioncivil.es" },
      { label: "AEMET warnings", url: "https://www.aemet.es/es/eltiempo/prediccion/avisos" },
      { label: "112 Comunitat Valenciana", url: "https://www.112cv.gva.es" },
    ],
  },
  eu: {
    title: "Europe",
    links: [{ label: "Find your national warning service (Meteoalarm)", url: "https://meteoalarm.org/en/live/" }],
  },
};

/**
 * Pure: warning-service groups for a place's country (ISO alpha-2). DE gives Germany, ES gives Spain, any other
 * country gives only the EU-wide Meteoalarm link. No country falls back to `warningCountriesFor` on the names.
 */
export function warningCountriesForCountry(
  country: string | null | undefined,
  ...names: (string | null | undefined)[]
): WarningCountry[] {
  const c = (country ?? "").trim().toUpperCase();
  if (c === "DE") return ["de"];
  if (c === "ES") return ["es"];
  if (c) return ["eu"];
  return warningCountriesFor(...names);
}

export const EMERGENCY_LINE = "In an emergency call 112.";

// Full words only. JS \b is ASCII-only, so boundaries are Unicode-aware lookarounds (u flag).
const words = (list: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join("|")})(?![\\p{L}\\p{N}])`, "iu");
const GERMAN = words([
  "AHR\\d{2}", "ahr", "altenahr", "ahrweiler", "schuld", "dernau", "rhine", "rhein", "köln", "koeln",
  "cologne", "bonn", "koblenz", "mosel", "germany", "deutschland",
]);
const SPANISH = words([
  "VAL\\d{2}", "valencia", "paiporta", "catarroja", "sedaví", "alfafar", "benetússer", "algemesí", "chiva",
  "utiel", "spain", "españa",
]);

/**
 * Pure: which countries' warning services fit the shown place. Spanish only gives ["es"], German only
 * gives ["de"]; unclear or both gives ["de", "es"], shown as two groups.
 */
export function warningCountriesFor(...shown: (string | null | undefined)[]): WarningCountry[] {
  const text = shown.filter(Boolean).join(" ");
  const de = GERMAN.test(text);
  const es = SPANISH.test(text);
  if (de && !es) return ["de"];
  if (es && !de) return ["es"];
  return ["de", "es"];
}
export const SAFETY_HEADLINE = "Follow your official warning service";

export const CITIZEN_ADVICE =
  "What to do: follow the official warnings (Germany: Hochwassermeldedienst of your Land, " +
  "DWD, NINA app; Spain: AEMET, ES-Alert, Protección Civil); keep away from riverbanks, " +
  "underpasses and cellars; call 112 in an emergency.";

export const CITIZEN_ADVICE_SOURCE = "Same advice the FloodSense agents give with every citizen answer";

/** Same rule as How it works: answers are not held back; only the agent-written playbook step waits for a person. */
export const GATE_LINE =
  "Your answers aren't held back. Only the agent-written step for this past flood is checked by a person before it appears here.";
