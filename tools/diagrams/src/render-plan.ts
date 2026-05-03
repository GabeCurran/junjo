import { join } from "node:path";
import type { DiagramSource } from "./discover-sources.ts";

export type RenderTask = {
  slug: string;
  source: string;
  output: string;
};

export type RenderFormat = "png" | "svg";

export class RenderPlanError extends Error {}

export function buildRenderPlan(opts: {
  sources: readonly DiagramSource[];
  outDir: string;
  format: RenderFormat;
  filterSlug?: string;
}): RenderTask[] {
  const { sources, outDir, format, filterSlug } = opts;
  const matched = filterSlug ? sources.filter((s) => s.slug === filterSlug) : sources;
  if (filterSlug && matched.length === 0) {
    const known = sources.map((s) => s.slug).join(", ") || "(none)";
    throw new RenderPlanError(
      `no diagram source matches --file=${filterSlug}. Known slugs: ${known}`,
    );
  }
  return matched.map((s) => ({
    slug: s.slug,
    source: s.absPath,
    output: join(outDir, `${s.slug}.${format}`),
  }));
}
