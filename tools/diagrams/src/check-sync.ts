import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSources } from "./discover-sources.ts";
import { EMBED_MAP } from "./embed-map.ts";

export type Drift = {
  slug: string;
  path: string;
  reason: string;
};

export type CheckSyncOptions = {
  sourceDir: string;
  repoRoot: string;
  embedMap: Readonly<Record<string, readonly string[]>>;
};

export type CheckSyncResult = {
  ok: boolean;
  drifts: Drift[];
  checkedSlugs: number;
  checkedFences: number;
};

const FENCE_OPEN = /^\s*```mermaid\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;

export function extractMermaidFences(text: string): string[] {
  const fences: string[] = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let buffer: string[] = [];
  for (const line of lines) {
    if (!inFence) {
      if (FENCE_OPEN.test(line)) {
        inFence = true;
        buffer = [];
      }
    } else if (FENCE_CLOSE.test(line)) {
      inFence = false;
      fences.push(buffer.join("\n"));
    } else {
      buffer.push(line);
    }
  }
  return fences;
}

function normalize(s: string): string {
  return s.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

export function checkSync(opts: CheckSyncOptions): CheckSyncResult {
  const { sourceDir, repoRoot, embedMap } = opts;
  const drifts: Drift[] = [];
  const sources = discoverSources(sourceDir);
  const sourceSlugs = new Set(sources.map((s) => s.slug));
  const mappedSlugs = new Set(Object.keys(embedMap));

  for (const s of sources) {
    if (!mappedSlugs.has(s.slug)) {
      drifts.push({
        slug: s.slug,
        path: s.absPath,
        reason: "source has no entry in EMBED_MAP",
      });
    }
  }

  for (const slug of mappedSlugs) {
    if (!sourceSlugs.has(slug)) {
      drifts.push({
        slug,
        path: `source/${slug}.mmd`,
        reason: "EMBED_MAP entry has no matching .mmd source file",
      });
    }
  }

  let checkedFences = 0;

  for (const [slug, paths] of Object.entries(embedMap)) {
    if (!sourceSlugs.has(slug)) continue;
    const sourceFile = resolve(sourceDir, `${slug}.mmd`);
    const expected = normalize(readFileSync(sourceFile, "utf8"));
    for (const rel of paths) {
      const abs = resolve(repoRoot, rel);
      if (!existsSync(abs)) {
        drifts.push({
          slug,
          path: rel,
          reason: "embed target does not exist",
        });
        continue;
      }
      const fileText = readFileSync(abs, "utf8");
      const fences = extractMermaidFences(fileText);
      const [first] = fences;
      if (first === undefined) {
        drifts.push({
          slug,
          path: rel,
          reason: "no mermaid fence found in embed target",
        });
        continue;
      }
      if (fences.length !== 1) {
        drifts.push({
          slug,
          path: rel,
          reason: `expected exactly 1 mermaid fence, found ${fences.length}`,
        });
        continue;
      }
      checkedFences += 1;
      const actual = normalize(first);
      if (actual !== expected) {
        drifts.push({
          slug,
          path: rel,
          reason:
            "fence content drifts from .mmd source (run npm run diagrams to re-render and resync)",
        });
      }
    }
  }

  return {
    ok: drifts.length === 0,
    drifts,
    checkedSlugs: sources.length,
    checkedFences,
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, "..");
const repoRoot = resolve(workspaceRoot, "..", "..");
const SOURCE_DIR = resolve(workspaceRoot, "source");

function isMain(): boolean {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const result = checkSync({
    sourceDir: SOURCE_DIR,
    repoRoot,
    embedMap: EMBED_MAP,
  });
  if (result.ok) {
    console.log(
      `OK: ${result.checkedSlugs} mermaid source(s) match ${result.checkedFences} embedded fence(s)`,
    );
    process.exit(0);
  }
  console.error(`FAIL: ${result.drifts.length} drift entry/entries`);
  for (const d of result.drifts) {
    console.error(`  - ${d.slug} (${d.path}): ${d.reason}`);
  }
  process.exit(1);
}
