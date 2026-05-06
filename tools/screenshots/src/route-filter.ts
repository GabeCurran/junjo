import type { RouteSpec } from "./types.ts";

export function filterRoutes(routes: readonly RouteSpec[], slug: string | undefined): RouteSpec[] {
  if (!slug) return [...routes];
  const matches = routes.filter((r) => r.slug === slug);
  if (matches.length === 0) {
    const known = routes.map((r) => r.slug).join(", ") || "(none)";
    throw new Error(`no route with slug "${slug}". known slugs: ${known}`);
  }
  return matches;
}
