import answerJson from "./answer.json";
import dischargeJson from "./discharge_daily.json";
import exposureJson from "./exposure_join.json";
import hazardJson from "./hazard_timeline.json";
import pointsJson from "./valencia_points.json";
import provenanceJson from "./provenance.json";
import type { Answer } from "../types/contract";
import type {
  DischargeDailyRow,
  ExposureJoinRow,
  HazardTimelineRow,
  ProvenanceRow,
  ValenciaPoint,
} from "../types/views";
import { provenanceForSource } from "../lib/series";
import {
  asDischargeRow,
  asExposureRow,
  asHazardRow,
  asProvenanceRow,
  asValenciaPoint,
  assertAnswer,
  parseRows,
} from "../lib/validate";

export interface FixtureBundle {
  answer: Answer;
  discharge: DischargeDailyRow[];
  hazard: HazardTimelineRow[];
  exposure: ExposureJoinRow[];
  provenance: ProvenanceRow[];
  points: ValenciaPoint[];
}

function required<T>(rows: T[] | null, name: string): T[] {
  if (rows === null) throw new Error(`${name} fixture does not match its view columns.`);
  return rows;
}

export function loadFixtures(): FixtureBundle {
  const provenance = required(parseRows(provenanceJson, asProvenanceRow), "provenance");
  const dischargeSource = provenanceForSource("seed:open-meteo-flood-glofas", provenance);
  if (!dischargeSource?.dataset.toLowerCase().includes("open-meteo")) {
    throw new Error("The GloFAS source stamp did not match the Open-Meteo provenance row.");
  }
  const rainSource = provenanceForSource("open-meteo-rain", provenance);
  if (!rainSource?.dataset.toLowerCase().includes("historical")) {
    throw new Error("The rain source stamp did not match the Open-Meteo archive provenance row.");
  }
  return {
    answer: assertAnswer(answerJson),
    discharge: required(parseRows(dischargeJson, asDischargeRow), "discharge_daily"),
    hazard: required(parseRows(hazardJson, asHazardRow), "hazard_timeline"),
    exposure: required(parseRows(exposureJson, asExposureRow), "exposure_join"),
    provenance,
    points: required(parseRows(pointsJson, asValenciaPoint), "valencia_points"),
  };
}
