import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboardRoutes, seedScreenshotFixtures } from "../seed-fixtures.ts";
import type { CrawlConfig, PrepareResult } from "../types.ts";

// Defaults to 3000 to match the user's standard `npm run dev:dashboard`
// port. Combined with isAlreadyServing() in dev-server.ts, the crawler
// reuses the running dashboard from the dev workflow rather than
// spawning a parallel instance. Override via SCREENSHOTS_DASHBOARD_PORT
// for unusual setups.
const DEFAULT_PORT = 3000;
const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
// Defaults match the dashboard's standard local-dev `.env.local` values
// (DASHBOARD_ADMIN_USER=admin / DASHBOARD_ADMIN_PASSWORD=admin). The
// previous "admin-screenshots" default caused 401s during crawls because
// the crawler runs in a separate process and doesn't load the dashboard
// app's .env.local. Override via DASHBOARD_ADMIN_USER / _PASSWORD env
// vars when running against a non-default credential set.
const DEFAULT_ADMIN_USER = "admin";
const DEFAULT_ADMIN_PASSWORD = "admin";

const port = readNumberEnv("SCREENSHOTS_DASHBOARD_PORT", DEFAULT_PORT);
const adminUser = process.env.DASHBOARD_ADMIN_USER ?? DEFAULT_ADMIN_USER;
const adminPassword = process.env.DASHBOARD_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;
const junjoBaseUrl = process.env.JUNJO_BASE_URL ?? DEFAULT_BASE_URL;
const junjoAdminApiKey = process.env.JUNJO_ADMIN_API_KEY ?? "";
const junjoAdminToken = process.env.JUNJO_ADMIN_TOKEN ?? "";

const config: CrawlConfig = {
  area: "dashboard",
  basicAuth: { username: adminUser, password: adminPassword },
  viewports: [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 375, height: 812, deviceScaleFactor: 2, isMobile: true },
  ],
  devServer: {
    command: `npm run dev -w @junjo/dashboard -- --port ${port.toString()} --hostname 127.0.0.1`,
    cwd: rootRelative(),
    port,
    readyPath: "/",
    startupTimeoutMs: 120_000,
    env: {
      DASHBOARD_ADMIN_USER: adminUser,
      DASHBOARD_ADMIN_PASSWORD: adminPassword,
      JUNJO_BASE_URL: junjoBaseUrl,
      JUNJO_ADMIN_API_KEY: junjoAdminApiKey,
      ...(junjoAdminToken ? { JUNJO_ADMIN_TOKEN: junjoAdminToken } : {}),
    },
  },
  prepare: async (): Promise<PrepareResult> => {
    if (!junjoAdminToken) {
      throw new Error(
        "JUNJO_ADMIN_TOKEN is required to seed the dashboard catalog. Set it to the admin token configured on the Junjo server.",
      );
    }
    const result = await seedScreenshotFixtures({
      baseUrl: junjoBaseUrl,
      adminToken: junjoAdminToken,
    });
    return {
      routes: buildDashboardRoutes({
        gameId: result.gameId,
        primaryGroupId: result.primaryGroupId,
      }),
    };
  },
};

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function rootRelative(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

export default config;
