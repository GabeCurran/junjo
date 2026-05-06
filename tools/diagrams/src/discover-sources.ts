import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type DiagramSource = {
  slug: string;
  absPath: string;
};

export function discoverSources(sourceDir: string): DiagramSource[] {
  let entries: string[];
  try {
    entries = readdirSync(sourceDir);
  } catch {
    return [];
  }
  const sources: DiagramSource[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".mmd")) continue;
    const absPath = join(sourceDir, entry);
    const st = statSync(absPath);
    if (!st.isFile()) continue;
    const slug = entry.slice(0, -".mmd".length);
    if (!slug) continue;
    sources.push({ slug, absPath });
  }
  sources.sort((a, b) => a.slug.localeCompare(b.slug));
  return sources;
}
