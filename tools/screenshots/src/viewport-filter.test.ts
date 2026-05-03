import { describe, expect, it } from "vitest";
import type { Viewport } from "./types.ts";
import { filterViewports } from "./viewport-filter.ts";

const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 375, height: 812, deviceScaleFactor: 2, isMobile: true },
];

describe("filterViewports", () => {
  it("returns all viewports when no name is provided", () => {
    expect(filterViewports(VIEWPORTS, undefined).map((v) => v.name)).toEqual(["desktop", "mobile"]);
  });

  it("returns only the matching viewport when name is provided", () => {
    expect(filterViewports(VIEWPORTS, "mobile")).toEqual([
      { name: "mobile", width: 375, height: 812, deviceScaleFactor: 2, isMobile: true },
    ]);
  });

  it("throws with the list of known viewports when no match", () => {
    expect(() => filterViewports(VIEWPORTS, "tablet")).toThrow(/no viewport named "tablet"/);
    expect(() => filterViewports(VIEWPORTS, "tablet")).toThrow(/desktop, mobile/);
  });

  it("returns a copy so callers can't mutate the source list", () => {
    const result = filterViewports(VIEWPORTS, undefined);
    expect(result).not.toBe(VIEWPORTS);
  });
});
