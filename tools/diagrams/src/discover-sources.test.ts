import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSources } from "./discover-sources.ts";

describe("discoverSources", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diagrams-discover-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty array when the source directory does not exist", () => {
    expect(discoverSources(join(dir, "missing"))).toEqual([]);
  });

  it("returns an empty array when the directory has no .mmd files", () => {
    writeFileSync(join(dir, "README.md"), "# nope\n");
    writeFileSync(join(dir, "diagram.txt"), "graph TD\n");
    expect(discoverSources(dir)).toEqual([]);
  });

  it("finds .mmd files and derives slugs from filenames", () => {
    writeFileSync(join(dir, "system-architecture.mmd"), "graph TD\nA-->B\n");
    writeFileSync(join(dir, "auth-flow.mmd"), "sequenceDiagram\n");
    const sources = discoverSources(dir);
    expect(sources.map((s) => s.slug)).toEqual(["auth-flow", "system-architecture"]);
    for (const s of sources) {
      expect(s.absPath).toContain(s.slug);
      expect(s.absPath.endsWith(".mmd")).toBe(true);
    }
  });

  it("ignores non-.mmd files", () => {
    writeFileSync(join(dir, "good.mmd"), "graph TD\n");
    writeFileSync(join(dir, "bad.png"), "binary");
    writeFileSync(join(dir, "stale.mmd.bak"), "graph TD\n");
    expect(discoverSources(dir).map((s) => s.slug)).toEqual(["good"]);
  });

  it("sorts slugs alphabetically for deterministic output", () => {
    writeFileSync(join(dir, "z.mmd"), "graph TD\n");
    writeFileSync(join(dir, "a.mmd"), "graph TD\n");
    writeFileSync(join(dir, "m.mmd"), "graph TD\n");
    expect(discoverSources(dir).map((s) => s.slug)).toEqual(["a", "m", "z"]);
  });
});
