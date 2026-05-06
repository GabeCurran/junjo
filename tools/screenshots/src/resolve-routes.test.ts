import { describe, expect, it, vi } from "vitest";
import { resolveRoutes } from "./resolve-routes.ts";
import type { CrawlConfig, RouteSpec } from "./types.ts";

const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900 }];

const STATIC_ROUTES: RouteSpec[] = [
  { slug: "home", path: "/", description: "home" },
  { slug: "about", path: "/about", description: "about" },
];

describe("resolveRoutes", () => {
  it("returns the static routes when no prepare hook is set", async () => {
    const config: CrawlConfig = { area: "docs", viewports: VIEWPORTS, routes: STATIC_ROUTES };
    const out = await resolveRoutes(config);
    expect(out.map((r) => r.slug)).toEqual(["home", "about"]);
  });

  it("calls prepare and returns its routes when present", async () => {
    const dynamic: RouteSpec[] = [{ slug: "dynamic", path: "/dyn", description: "x" }];
    const prepare = vi.fn().mockResolvedValue({ routes: dynamic });
    const config: CrawlConfig = { area: "dashboard", viewports: VIEWPORTS, prepare };
    const out = await resolveRoutes(config);
    expect(out).toEqual(dynamic);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("prepare wins over a static routes array", async () => {
    const dynamic: RouteSpec[] = [{ slug: "dynamic", path: "/dyn", description: "x" }];
    const prepare = vi.fn().mockResolvedValue({ routes: dynamic });
    const config: CrawlConfig = {
      area: "dashboard",
      viewports: VIEWPORTS,
      routes: STATIC_ROUTES,
      prepare,
    };
    const out = await resolveRoutes(config);
    expect(out.map((r) => r.slug)).toEqual(["dynamic"]);
  });

  it("throws when neither routes nor prepare is set", async () => {
    const config: CrawlConfig = { area: "broken", viewports: VIEWPORTS };
    await expect(resolveRoutes(config)).rejects.toThrow(/no routes resolved for target "broken"/);
  });
});
