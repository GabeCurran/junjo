import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverDocsRoutes } from "../discover-docs-routes.ts";
import type { CrawlConfig } from "../types.ts";

const DEFAULT_PORT = 13131;

const port = readNumberEnv("SCREENSHOTS_DOCS_PORT", DEFAULT_PORT);
const repoRoot = resolveRepoRoot();
const docsPagesDir = resolve(repoRoot, "apps", "docs", "pages");

const config: CrawlConfig = {
  area: "docs",
  viewports: [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 375, height: 812, deviceScaleFactor: 2, isMobile: true },
  ],
  routes: discoverDocsRoutes(docsPagesDir),
  devServer: {
    command: `npm run dev -w @junjo/docs -- --port ${port.toString()} --hostname 127.0.0.1`,
    cwd: repoRoot,
    port,
    readyPath: "/",
    startupTimeoutMs: 120_000,
  },
};

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function resolveRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

export default config;
