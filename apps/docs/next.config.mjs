import nextra from "nextra";

const withNextra = nextra({
  theme: "nextra-theme-docs",
  themeConfig: "./theme.config.tsx",
});

/** @type {import('next').NextConfig} */
export default withNextra({
  reactStrictMode: true,
  // Map /healthz -> /api/healthz so the orchestrator probe (Railway's
  // healthcheckPath at the repo root) hits the JSON liveness handler.
  // Pages router can't serve JSON from a non-`/api` route directly.
  async rewrites() {
    return [{ source: "/healthz", destination: "/api/healthz" }];
  },
});
