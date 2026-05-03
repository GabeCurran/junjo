// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 13030);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

const ADMIN_USER = process.env.DASHBOARD_ADMIN_USER ?? "admin";
const ADMIN_PASSWORD = process.env.DASHBOARD_ADMIN_PASSWORD ?? "admin-e2e-password";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    httpCredentials: { username: ADMIN_USER, password: ADMIN_PASSWORD },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Local-only: the bar for V1 is "the script being present and passing
  // locally" (VISION Phase 14.12). Operators bring up Postgres + the Junjo
  // server on JUNJO_BASE_URL out of band; the webServer block boots only
  // the dashboard itself so the test cycle is one command.
  webServer: {
    command: `npm run dev -- --port ${PORT.toString()} --hostname 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DASHBOARD_ADMIN_USER: ADMIN_USER,
      DASHBOARD_ADMIN_PASSWORD: ADMIN_PASSWORD,
      JUNJO_BASE_URL: process.env.JUNJO_BASE_URL ?? "http://127.0.0.1:8787",
      JUNJO_ADMIN_API_KEY: process.env.JUNJO_ADMIN_API_KEY ?? "",
      ...(process.env.JUNJO_ADMIN_TOKEN
        ? { JUNJO_ADMIN_TOKEN: process.env.JUNJO_ADMIN_TOKEN }
        : {}),
    },
  },
});
