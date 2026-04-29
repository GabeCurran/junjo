// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { z } from "zod";

// Server-only env vars consumed by the dashboard. Validated lazily so a
// missing variable surfaces as a clear runtime error on the request that
// needs it, rather than crashing at module load (which would break
// next build's static-route discovery on a deploy where one of these
// variables is intentionally absent).
const dashboardEnvSchema = z.object({
  JUNJO_BASE_URL: z.string().url().default("http://localhost:8787"),
  JUNJO_ADMIN_API_KEY: z.string().min(1),
  JUNJO_ADMIN_TOKEN: z.string().min(1).optional(),
  // Optional. The URL prefix used when constructing invite-link URLs in the
  // dashboard's invite-member dialog. The dashboard does not host the
  // acceptance flow itself; the dev runs a player-facing app at this origin
  // that resolves `/invite/<code>` against the Junjo server. When unset, the
  // dialog falls back to JUNJO_BASE_URL so operators still get a copyable
  // string (typically pointing at the API rather than a player-facing
  // frontend; document this in the README).
  JUNJO_INVITE_BASE_URL: z.string().url().optional(),
});

export type DashboardEnv = z.infer<typeof dashboardEnvSchema>;

let cached: DashboardEnv | null = null;

export function loadDashboardEnv(): DashboardEnv {
  if (cached) return cached;
  const parsed = dashboardEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`dashboard environment is misconfigured: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

// Test-only escape hatch so unit tests can swap envs without touching
// process.env globally. Not exported from the package surface.
export function resetDashboardEnvCache(): void {
  cached = null;
}
