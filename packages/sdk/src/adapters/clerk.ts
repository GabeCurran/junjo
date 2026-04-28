import type { AuthAdapter } from "@junjo/shared";

// Structural shape of the bits of the Clerk SDK we use. Keeps Clerk
// from being a hard dependency of @junjo/sdk.
interface ClerkLike {
  verifyToken(token: string): Promise<{ sub: string } | null>;
}

export function clerkAdapter(_clerk: ClerkLike): AuthAdapter {
  return {
    async verifyToken(_token) {
      throw new Error("not implemented");
    },
  };
}
