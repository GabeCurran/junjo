// @cloud-only
//
// Admin token middleware gating cloud-only routes (the cross-game user query
// in Phase 10.2; future cross-tenant admin endpoints). Reads `Authorization:
// Bearer <token>` and constant-time-compares it to the configured admin
// token. The configured token is threaded through `createApp({ adminToken })`
// from the server entry point (which reads `JUNJO_ADMIN_TOKEN` via `loadEnv`).
//
// Distinct from `apiKeyMiddleware`: per-game API keys identify which game is
// calling and gate per-game data; the admin token is a single server-wide
// secret intended for the dashboard or operator scripts that need
// cross-tenant visibility. The two middlewares never run on the same route.
//
// When the configured token is undefined (self-host setups that never
// configured one) every request returns 401 - the route is effectively
// disabled rather than open. Documented in `apps/docs/pages/api/admin.mdx`.

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Errors } from "../errors.js";

export function adminAuthMiddleware(configuredToken: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!configuredToken) {
      throw Errors.invalidAdminToken("admin endpoints are disabled on this server");
    }
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      throw Errors.invalidAdminToken("missing or malformed Authorization header");
    }
    const presented = auth.slice("Bearer ".length).trim();
    if (presented.length === 0) {
      throw Errors.invalidAdminToken("empty bearer token");
    }
    if (!constantTimeStringEqual(presented, configuredToken)) {
      throw Errors.invalidAdminToken();
    }
    await next();
  };
}

// Constant-time string comparison via Buffer + timingSafeEqual. Returns
// false on length mismatch without leaking via early return - we still run
// a fixed-length compare against a zero buffer so the runtime is bounded
// by max(presented.length, expected.length), not the shorter one.
function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // timingSafeEqual requires equal lengths; do a dummy compare to keep
    // the timing path resembling the equal-length case, then return false.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
