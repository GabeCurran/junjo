import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverDocsRoutes } from "./discover-docs-routes.ts";

const here = dirname(fileURLToPath(import.meta.url));

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "junjo-docs-routes-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function touch(rel: string, body = "# ok\n"): void {
  const full = join(tmpRoot, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

describe("discoverDocsRoutes (synthetic tree)", () => {
  it("maps pages/index.mdx to the root path with slug home", () => {
    touch("index.mdx");
    const routes = discoverDocsRoutes(tmpRoot);
    expect(routes).toEqual([{ slug: "home", path: "/", description: "Docs landing" }]);
  });

  it("maps a leaf mdx to its slug-derived path", () => {
    touch("getting-started.mdx");
    const [route] = discoverDocsRoutes(tmpRoot);
    expect(route).toEqual({
      slug: "getting-started",
      path: "/getting-started",
      description: "Getting Started",
    });
  });

  it("maps a section index.mdx to the section root", () => {
    touch("sdk/index.mdx");
    const [route] = discoverDocsRoutes(tmpRoot);
    expect(route).toEqual({ slug: "sdk", path: "/sdk", description: "Sdk overview" });
  });

  it("maps a nested leaf to a section-prefixed slug + path", () => {
    touch("api-reference/groups.mdx");
    const [route] = discoverDocsRoutes(tmpRoot);
    expect(route).toEqual({
      slug: "api-reference-groups",
      path: "/api-reference/groups",
      description: "Api Reference > Groups",
    });
  });

  it("skips Nextra meta + app files (anything starting with underscore)", () => {
    touch("_meta.ts", "export default {};\n");
    touch("_app.tsx", "export default function App() { return null; }\n");
    touch("index.mdx");
    touch("auth/_meta.ts", "export default {};\n");
    touch("auth/jwt.mdx");
    const slugs = discoverDocsRoutes(tmpRoot).map((r) => r.slug);
    expect(slugs).toEqual(["home", "auth-jwt"]);
  });

  it("sorts routes deterministically by path", () => {
    touch("zebra.mdx");
    touch("alpha.mdx");
    touch("index.mdx");
    touch("sdk/index.mdx");
    touch("sdk/groups.mdx");
    const paths = discoverDocsRoutes(tmpRoot).map((r) => r.path);
    expect(paths).toEqual(["/", "/alpha", "/sdk", "/sdk/groups", "/zebra"]);
  });

  it("returns an empty list when the root has no mdx pages", () => {
    touch("readme.txt", "no mdx here\n");
    expect(discoverDocsRoutes(tmpRoot)).toEqual([]);
  });

  it("drops files inside underscore-prefixed directories", () => {
    touch("_drafts/secret.mdx");
    touch("public.mdx");
    const slugs = discoverDocsRoutes(tmpRoot).map((r) => r.slug);
    expect(slugs).toEqual(["public"]);
  });
});

describe("discoverDocsRoutes (real apps/docs tree)", () => {
  const realRoot = join(here, "..", "..", "..", "apps", "docs", "pages");

  it("includes the well-known landing + section roots", () => {
    const paths = new Set(discoverDocsRoutes(realRoot).map((r) => r.path));
    expect(paths.has("/")).toBe(true);
    expect(paths.has("/getting-started")).toBe(true);
    expect(paths.has("/tutorial")).toBe(true);
    expect(paths.has("/self-host")).toBe(true);
    expect(paths.has("/sdk")).toBe(true);
    expect(paths.has("/react")).toBe(true);
    expect(paths.has("/api-reference")).toBe(true);
    expect(paths.has("/auth")).toBe(true);
    expect(paths.has("/roblox")).toBe(true);
  });

  it("includes representative deep pages from each section", () => {
    const paths = new Set(discoverDocsRoutes(realRoot).map((r) => r.path));
    expect(paths.has("/sdk/groups")).toBe(true);
    expect(paths.has("/react/use-can")).toBe(true);
    expect(paths.has("/api-reference/errors")).toBe(true);
    expect(paths.has("/api-reference/webhooks-discord")).toBe(true);
    expect(paths.has("/auth/jwt")).toBe(true);
  });

  it("emits a unique slug per page (no collisions across sections)", () => {
    const slugs = discoverDocsRoutes(realRoot).map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
