import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSync, extractMermaidFences } from "./check-sync.ts";
import { EMBED_MAP } from "./embed-map.ts";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, "..");
const repoRoot = resolve(workspaceRoot, "..", "..");
const REAL_SOURCE_DIR = resolve(workspaceRoot, "source");

describe("extractMermaidFences", () => {
  it("returns an empty array when the text has no fences", () => {
    expect(extractMermaidFences("# heading\n\nsome prose\n")).toEqual([]);
  });

  it("extracts the body of a single mermaid fence", () => {
    const text = "intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\noutro";
    expect(extractMermaidFences(text)).toEqual(["flowchart LR\n  A --> B"]);
  });

  it("extracts multiple fences in order", () => {
    const text = "```mermaid\none\n```\n\n```mermaid\ntwo\n```";
    expect(extractMermaidFences(text)).toEqual(["one", "two"]);
  });

  it("ignores non-mermaid fenced blocks", () => {
    const text = "```ts\nconst x = 1\n```\n\n```mermaid\nflowchart LR\n```";
    expect(extractMermaidFences(text)).toEqual(["flowchart LR"]);
  });

  it("normalises CRLF line endings while preserving fence body line breaks", () => {
    const text = "```mermaid\r\nflowchart LR\r\n  A --> B\r\n```\r\n";
    expect(extractMermaidFences(text)).toEqual(["flowchart LR\n  A --> B"]);
  });
});

describe("checkSync (synthetic)", () => {
  let dir: string;
  let sourceDir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diagrams-checksync-"));
    sourceDir = join(dir, "source");
    repo = join(dir, "repo");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports ok when source and embed are byte-identical", () => {
    const body = "%%{init: {'theme': 'neutral'}}%%\nflowchart LR\n  A --> B\n";
    writeFileSync(join(sourceDir, "demo.mmd"), body);
    writeFileSync(join(repo, "page.mdx"), `# title\n\n\`\`\`mermaid\n${body.trimEnd()}\n\`\`\`\n`);
    const result = checkSync({
      sourceDir,
      repoRoot: repo,
      embedMap: { demo: ["page.mdx"] },
    });
    expect(result.ok).toBe(true);
    expect(result.drifts).toEqual([]);
    expect(result.checkedFences).toBe(1);
  });

  it("flags drift when the embed body diverges", () => {
    writeFileSync(join(sourceDir, "demo.mmd"), "flowchart LR\n  A --> B\n");
    writeFileSync(join(repo, "page.mdx"), "```mermaid\nflowchart LR\n  A --> C\n```\n");
    const result = checkSync({
      sourceDir,
      repoRoot: repo,
      embedMap: { demo: ["page.mdx"] },
    });
    expect(result.ok).toBe(false);
    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]?.reason).toMatch(/drifts from \.mmd source/);
  });

  it("flags missing embed targets", () => {
    writeFileSync(join(sourceDir, "demo.mmd"), "flowchart LR\n");
    const result = checkSync({
      sourceDir,
      repoRoot: repo,
      embedMap: { demo: ["does-not-exist.mdx"] },
    });
    expect(result.ok).toBe(false);
    expect(result.drifts[0]?.reason).toBe("embed target does not exist");
  });

  it("flags pages with zero mermaid fences", () => {
    writeFileSync(join(sourceDir, "demo.mmd"), "flowchart LR\n");
    writeFileSync(join(repo, "page.mdx"), "# title\n\nno fence here.\n");
    const result = checkSync({
      sourceDir,
      repoRoot: repo,
      embedMap: { demo: ["page.mdx"] },
    });
    expect(result.ok).toBe(false);
    expect(result.drifts[0]?.reason).toBe("no mermaid fence found in embed target");
  });

  it("flags pages with more than one mermaid fence", () => {
    writeFileSync(join(sourceDir, "demo.mmd"), "flowchart LR\n");
    writeFileSync(
      join(repo, "page.mdx"),
      "```mermaid\nflowchart LR\n```\n\n```mermaid\nflowchart RL\n```\n",
    );
    const result = checkSync({
      sourceDir,
      repoRoot: repo,
      embedMap: { demo: ["page.mdx"] },
    });
    expect(result.ok).toBe(false);
    expect(result.drifts[0]?.reason).toMatch(/expected exactly 1 mermaid fence/);
  });

  it("flags sources missing from EMBED_MAP", () => {
    writeFileSync(join(sourceDir, "orphan.mmd"), "flowchart LR\n");
    const result = checkSync({
      sourceDir,
      repoRoot: repo,
      embedMap: {},
    });
    expect(result.ok).toBe(false);
    expect(result.drifts[0]?.reason).toBe("source has no entry in EMBED_MAP");
  });

  it("flags EMBED_MAP entries with no matching source", () => {
    const result = checkSync({
      sourceDir,
      repoRoot: repo,
      embedMap: { ghost: ["page.mdx"] },
    });
    expect(result.ok).toBe(false);
    expect(result.drifts[0]?.reason).toBe("EMBED_MAP entry has no matching .mmd source file");
  });
});

describe("checkSync (real repo)", () => {
  it("every committed .mmd source matches its embedded fence(s) byte-for-byte", () => {
    const result = checkSync({
      sourceDir: REAL_SOURCE_DIR,
      repoRoot,
      embedMap: EMBED_MAP,
    });
    if (!result.ok) {
      const lines = result.drifts.map((d) => `  - ${d.slug} (${d.path}): ${d.reason}`);
      throw new Error(`Mermaid source/embed drift:\n${lines.join("\n")}`);
    }
    expect(result.checkedSlugs).toBeGreaterThan(0);
    expect(result.checkedFences).toBeGreaterThanOrEqual(result.checkedSlugs);
  });
});
