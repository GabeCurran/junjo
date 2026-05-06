import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { RouteSpec } from "./types.ts";

// Walks `apps/docs/pages/**/*.mdx` and derives one RouteSpec per page.
// `_meta.ts`, `_app.tsx`, and any other `_`-prefixed file or directory
// is skipped (Nextra convention). `index.mdx` files map to the section
// root path: `pages/index.mdx` -> `/`, `pages/sdk/index.mdx` -> `/sdk`.
export function discoverDocsRoutes(rootDir: string): RouteSpec[] {
  const files = walkMdx(rootDir);
  const routes = files.map((file) => fileToRoute(rootDir, file));
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

function walkMdx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith("_")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMdx(full));
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      out.push(full);
    }
  }
  return out;
}

function fileToRoute(rootDir: string, file: string): RouteSpec {
  const rel = relative(rootDir, file)
    .split(sep)
    .join("/")
    .replace(/\.mdx$/, "");
  const segments = rel.split("/");
  const last = segments[segments.length - 1] ?? "";
  const isIndex = last === "index";
  const pathParts = isIndex ? segments.slice(0, -1) : segments;
  const path = pathParts.length === 0 ? "/" : `/${pathParts.join("/")}`;
  const slug = pathParts.length === 0 ? "home" : pathParts.join("-");
  return { slug, path, description: describeRoute(pathParts, isIndex) };
}

function describeRoute(pathParts: readonly string[], isIndex: boolean): string {
  if (pathParts.length === 0) return "Docs landing";
  const labels = pathParts.map(humanize);
  if (pathParts.length === 1) {
    return isIndex ? `${labels[0]} overview` : (labels[0] ?? "");
  }
  const head = labels[0] ?? "";
  const tail = labels.slice(1).join(" > ");
  return `${head} > ${tail}`;
}

function humanize(segment: string): string {
  return segment
    .split("-")
    .map((w) => {
      const first = w[0];
      if (first === undefined) return w;
      return first.toUpperCase() + w.slice(1);
    })
    .join(" ");
}
