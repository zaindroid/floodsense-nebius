/**
 * Plain-language wording for claim text. Answer claims sometimes name database tables and columns;
 * the original sentence stays available under "Technical detail" or in the hover text.
 * Numbers and meaning are not changed, and a seed source always stays disclosed as seed data.
 */
const SOURCES: Record<string, string> = {
  "seed:open-meteo-flood-glofas": "seed data: Open-Meteo GloFAS model",
};

function sourceWords(stamp: string): string {
  const known = SOURCES[stamp];
  if (known) return known;
  return stamp.startsWith("seed") ? `seed data: ${stamp.replace(/^seed:?/, "")}` : stamp;
}

const TABLES: Record<string, string> = {
  discharge_daily: "daily river-flow record",
  hazard_timeline: "hourly rain record",
  exposure_join: "insured-sites record",
  provenance: "source list",
};

function tableWords(name: string): string {
  return TABLES[name] ?? `${name.replace(/_/g, " ")} record`;
}

/** 140.89999999999998 -> 140.9. Only decimals of four or more places are touched; dates and ids are not decimals. */
export function roundLongNumbers(text: string): string {
  return text.replace(/(?<![\w.])(\d+\.\d{4,})(?![\w])/g, (m) => String(Number(Number(m).toFixed(2))));
}

export function plainLanguage(text: string): string {
  return roundLongNumbers(text)
    .replace(/\bThe source column is ([^\s.]+(?:\.[^\s.]+)*?)\./g, (_m, stamp: string) => `(${sourceWords(stamp)}).`)
    .replace(/\bfloodsense_seed\.(\w+)/g, (_m, name: string) => `the ${tableWords(name)} (seed data)`)
    .replace(/\bfloodsense\.(\w+)/g, (_m, name: string) => `the ${tableWords(name)}`)
    .replace(/\b(discharge_daily|hazard_timeline|exposure_join)\b/g, (_m, name: string) => `the ${tableWords(name)}`)
    .replace(/\bwarning_level is null\b/g, "no official warning level is attached")
    .replace(/\bwarning_level\b/g, "warning level")
    .replace(/\bdischarge_m3s\b/g, "river flow")
    .replace(/\brain_mm\b/g, "rain")
    .replace(/\bseed:open-meteo-flood-glofas\b/g, SOURCES["seed:open-meteo-flood-glofas"])
    .replace(/\s{2,}/g, " ")
    .trim();
}
