import type { AuthAdapter, UserId } from "@junjo.io/shared";
import { JunjoError } from "../errors.js";

/**
 * The minimum payload shape the adapter cares about. Any object with a
 * string `sub` (or whichever claim `userIdClaim` selects) verifies; every
 * other field on the payload is ignored.
 */
export interface ClerkVerifiedPayload {
  sub?: string | null;
  [claim: string]: unknown;
}

/**
 * Structural shape of the `verifyToken` function the dev wires up. The
 * dev points this at `@clerk/backend`'s `verifyToken` (a standalone
 * function in v1+ of that package), pre-bound to their secret key and
 * audience. Keeps `@clerk/backend` a peer dep, not a direct dep, so
 * callers without Clerk pay nothing.
 */
export type ClerkVerifyTokenFn = (
  token: string,
) => Promise<ClerkVerifiedPayload | null | undefined>;

/** Options for {@link clerkAdapter}. */
export interface ClerkAdapterOptions {
  /**
   * The Clerk verifier. Wrap `@clerk/backend`'s `verifyToken` here so the
   * secret key and audience options live next to your own configuration,
   * not inside this adapter.
   *
   *   import { verifyToken } from "@clerk/backend";
   *   clerkAdapter({
   *     verifyToken: (token) => verifyToken(token, {
   *       secretKey: process.env.CLERK_SECRET_KEY!,
   *     }),
   *   })
   */
  verifyToken: ClerkVerifyTokenFn;
  /**
   * Which claim to read the user id from. Defaults to "sub", which is
   * Clerk's user id (e.g. "user_2abc..."). Override only if you use a
   * custom Clerk session-token template that exposes the id elsewhere.
   */
  userIdClaim?: string;
}

/**
 * Builds an AuthAdapter that verifies Clerk session tokens through the
 * supplied verifier. Returns null (rather than throwing) for tokens
 * that fail verification or lack the user id claim.
 */
export function clerkAdapter(opts: ClerkAdapterOptions): AuthAdapter {
  if (typeof opts.verifyToken !== "function") {
    throw new JunjoError("clerkAdapter: `verifyToken` must be a function", "invalid_config");
  }
  const userIdClaim = opts.userIdClaim ?? "sub";
  const verify = opts.verifyToken;

  return {
    async verifyToken(token) {
      if (typeof token !== "string" || token.length === 0) return null;

      let payload: ClerkVerifiedPayload | null | undefined;
      try {
        payload = await verify(token);
      } catch {
        return null;
      }

      if (payload === null || payload === undefined) return null;
      const raw = payload[userIdClaim];
      if (typeof raw !== "string" || raw.length === 0) return null;
      return { userId: raw as UserId };
    },
  };
}
