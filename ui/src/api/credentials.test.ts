import { describe, expect, it } from "vitest";

// Behind a password (the hosted demo's Caddy basic_auth), a fetch with
// credentials "omit" never carries the login: the page loads, and every API
// call is a 401 that reads as "Live data unavailable". curl --user cannot see
// this, so it is pinned here.
const files = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("API calls carry the login on the same origin", () => {
  it("no fetch omits credentials", () => {
    const offenders = Object.entries(files)
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .filter(([, text]) => /credentials:\s*["']omit["']/.test(text))
      .map(([path]) => path);
    expect(Object.keys(files).length).toBeGreaterThan(20); // the glob really read the sources
    expect(offenders).toEqual([]);
  });
});
