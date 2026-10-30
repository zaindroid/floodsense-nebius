import { describe, expect, it } from "vitest";
import { BAND_STYLE, STATUS_STYLE, bandPoint, columnsGeoJson, failMapMode, flatGeoJson, MAP_MODE_KEY, readMapMode, statusPoint, writeMapMode } from "./shellLogic";

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("map mode", () => {
  it("defaults to 2d and round-trips 3d", () => {
    const s = store();
    expect(readMapMode(s)).toBe("2d");
    writeMapMode("3d", s);
    expect(s.getItem(MAP_MODE_KEY)).toBe("3d");
    expect(readMapMode(s)).toBe("3d");
  });
  it("ignores junk and blocked storage", () => {
    const s = store();
    s.setItem(MAP_MODE_KEY, "4d");
    expect(readMapMode(s)).toBe("2d");
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readMapMode(broken)).toBe("2d");
    expect(() => writeMapMode("3d", broken)).not.toThrow();
    expect(readMapMode(null)).toBe("2d");
  });
});

describe("columns", () => {
  const base = { id: "a", lat: 40, lon: 0, label: "A" };
  it("height follows band order, selection widens", () => {
    const fc = columnsGeoJson([bandPoint(base, "low"), bandPoint({ ...base, id: "b" }, "peak")], "b", 0.01);
    const [low, peak] = fc.features;
    expect(peak!.properties.height).toBe(4 * low!.properties.height);
    const width = (f: NonNullable<typeof low>) => f.geometry.coordinates[0]![1]![0]! - f.geometry.coordinates[0]![0]![0]!;
    expect(width(peak!)).toBeGreaterThan(width(low!));
  });
  it("drops non-finite positions", () => {
    expect(columnsGeoJson([bandPoint({ ...base, lat: NaN }, "low")], undefined, 0.01).features).toHaveLength(0);
  });
  it("never uses a red colour, on every actual palette value", () => {
    const colors = [...Object.values(BAND_STYLE), ...Object.values(STATUS_STYLE)].map((v) => v.color);
    expect(colors.length).toBeGreaterThan(7);
    for (const c of colors) {
      const [r, g, b] = [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)) as [number, number, number];
      expect(r - g).toBeLessThan(100); // red would be r far above g
      expect(r > 150 && g < 90 && b < 90).toBe(false);
    }
  });
  it("unknown status and missing value get no column, only a labelled flat marker", () => {
    const pts = [statusPoint(base, "unknown"), bandPoint({ ...base, id: "n" }, null), statusPoint({ ...base, id: "ok" }, "ok")];
    expect(columnsGeoJson(pts, undefined, 0.01).features.map((f) => f.properties.id)).toEqual(["ok"]);
    const flat = flatGeoJson(pts).features;
    expect(flat.map((f) => f.properties.id)).toEqual(["a", "n"]);
    expect(flat[0]!.properties.label).toContain("no reading");
  });
});

describe("3D failure", () => {
  it("saves 2d so the next load does not retry", () => {
    const s = store();
    writeMapMode("3d", s);
    expect(failMapMode(s)).toBe("2d");
    expect(readMapMode(s)).toBe("2d");
  });
});
