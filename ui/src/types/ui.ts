export type RouteId = "citizen" | "insurer" | "operator";

export type EvidenceTopic = "discharge" | "rain";

export type NoticeTone = "info" | "sim";

export interface Notice {
  id: string;
  title: string;
  body: string;
  tone: NoticeTone;
  read: boolean;
}

export type DischargeBand = "low" | "typical" | "elevated" | "peak";

export { SIMULATED_ALERT_M3S } from "../config/scenario";
