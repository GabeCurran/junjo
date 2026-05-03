import type { CrawlConfig, RouteSpec } from "./types.ts";

// Resolves the route list a crawl run should iterate over. When the
// config defines a `prepare` hook it wins (the hook is what configs
// for dynamic targets like the dashboard use to seed data and return
// routes containing freshly-resolved IDs). Otherwise the static
// `routes` array is used. Both forms are mutually exclusive in
// practice; if neither is present, an error is thrown.
export async function resolveRoutes(config: CrawlConfig): Promise<RouteSpec[]> {
  if (config.prepare) {
    const result = await config.prepare();
    return result.routes;
  }
  if (!config.routes) {
    throw new Error(
      `no routes resolved for target "${config.area}": config must define routes or a prepare() hook`,
    );
  }
  return config.routes;
}
