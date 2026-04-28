import type { AuthAdapter } from "@junjo/shared";

export interface JwtAdapterOptions {
  // PEM-encoded public key, JWKS URL, or shared HMAC secret.
  key: string;
  algorithm?: "HS256" | "RS256" | "ES256";
  // The JWT claim to read the user id from. Defaults to "sub".
  userIdClaim?: string;
  issuer?: string;
  audience?: string;
}

export function jwtAdapter(_opts: JwtAdapterOptions): AuthAdapter {
  return {
    async verifyToken(_token) {
      throw new Error("not implemented");
    },
  };
}
