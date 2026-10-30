import { describe, expect, it } from "vitest";
import { SIMULATED_ALERT_M3S } from "../config/scenario";
import { dischargeBand } from "./series";
import { REPLAY_EVENTS } from "./disasterReplay";
import py from "../../../agents/floodsense_agents/governance.py?raw";

describe("one alert line", () => {
  it("Sites map, Replay and the Watchers anomaly share it", () => {
    for (const e of REPLAY_EVENTS) expect(e.thresholdM3s).toBe(SIMULATED_ALERT_M3S);
    expect(dischargeBand(SIMULATED_ALERT_M3S - 1)).not.toBe("peak");
    expect(dischargeBand(SIMULATED_ALERT_M3S)).toBe("peak");
    expect(py).toMatch(new RegExp(`"anomaly_discharge": Definition\\([^)]*value=${SIMULATED_ALERT_M3S},`));
  });
});
