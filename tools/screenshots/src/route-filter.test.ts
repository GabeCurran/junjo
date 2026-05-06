import { describe, expect, it } from "vitest";
import { filterRoutes } from "./route-filter.ts";
import type { RouteSpec } from "./types.ts";

const ROUTES: RouteSpec[] = [
  { slug: "home", path: "/", description: "landing page" },
  { slug: "groups", path: "/games/g_1/groups", description: "groups list" },
  { slug: "audit", path: "/games/g_1/audit", description: "audit log" },
];

describe("filterRoutes", () => {
  it("returns all routes when no slug is provided", () => {
    expect(filterRoutes(ROUTES, undefined).map((r) => r.slug)).toEqual(["home", "groups", "audit"]);
  });

  it("returns the matching route when slug is provided", () => {
    expect(filterRoutes(ROUTES, "audit")).toEqual([
      { slug: "audit", path: "/games/g_1/audit", description: "audit log" },
    ]);
  });

  it("throws with the list of known slugs when no match", () => {
    expect(() => filterRoutes(ROUTES, "missing")).toThrow(/no route with slug "missing"/);
    expect(() => filterRoutes(ROUTES, "missing")).toThrow(/home, groups, audit/);
  });

  it("returns a copy so callers can't mutate the source list", () => {
    const result = filterRoutes(ROUTES, undefined);
    expect(result).not.toBe(ROUTES);
  });
});
