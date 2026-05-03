// @cloud-only
//
// Admin token vs per-game API key: per-game keys identify the calling
// game and gate per-game data; the admin token is a single server-wide
// secret for the dashboard / operator scripts that need cross-tenant
// visibility. The two middlewares never run on the same route.
//
// An undefined `configuredToken` (self-host setups that never set one)
// 401s every request - the routes are disabled rather than open.

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

// Constant-time. Length mismatch still runs a dummy compare so the
// timing path resembles the equal-length case and the runtime is bounded
// by max(a.length, b.length).
function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
