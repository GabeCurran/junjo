import type { AuthAdapter, UserId } from "@junjo/shared";
import { type CryptoKey, type JWTPayload, importSPKI, errors as joseErrors, jwtVerify } from "jose";
import { JunjoError } from "../errors.js";

export type JwtAdapterAlgorithm = "HS256" | "RS256" | "ES256";

export interface JwtAdapterOptions {
  // For HS256, a UTF-8 shared secret. For RS256 / ES256, a PEM-encoded
  // SPKI public key (the `-----BEGIN PUBLIC KEY-----` block). JWKS URLs
  // are not supported in V1; rotate keys by deploying a new adapter.
  key: string;
  algorithm: JwtAdapterAlgorithm;
  // The JWT claim to read the user id from. Defaults to "sub".
  userIdClaim?: string;
  // When set, the JWT's `iss` claim must equal this value.
  issuer?: string;
  // When set, the JWT's `aud` claim must include this value (string or
  // array; jose handles both).
  audience?: string | string[];
  // Maximum allowed clock skew between the JWT's `nbf`/`exp` and `now`,
  // in seconds. Defaults to 0 (strict). Set higher only if the issuer
  // and your server are known to drift.
  clockToleranceSeconds?: number;
}

export function jwtAdapter(opts: JwtAdapterOptions): AuthAdapter {
  if (typeof opts.key !== "string" || opts.key.length === 0) {
    throw new JunjoError("jwtAdapter: `key` must be a non-empty string", "invalid_config");
  }
  if (opts.algorithm !== "HS256" && opts.algorithm !== "RS256" && opts.algorithm !== "ES256") {
    throw new JunjoError(
      `jwtAdapter: unsupported algorithm "${opts.algorithm}"; expected HS256, RS256, or ES256`,
      "invalid_config",
    );
  }

  const userIdClaim = opts.userIdClaim ?? "sub";
  const keyPromise = resolveVerificationKey(opts.algorithm, opts.key).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    throw new JunjoError(`jwtAdapter: failed to import key (${detail})`, "invalid_config");
  });

  return {
    async verifyToken(token) {
      if (typeof token !== "string" || token.length === 0) return null;

      const key = await keyPromise;
      let payload: JWTPayload;
      try {
        const result = await jwtVerify(token, key, {
          algorithms: [opts.algorithm],
          ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
          ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
          ...(opts.clockToleranceSeconds !== undefined
            ? { clockTolerance: opts.clockToleranceSeconds }
            : {}),
        });
        payload = result.payload;
      } catch (err) {
        if (isJoseError(err)) return null;
        throw err;
      }

      const raw = payload[userIdClaim];
      if (typeof raw !== "string" || raw.length === 0) return null;
      return { userId: raw as UserId };
    },
  };
}

async function resolveVerificationKey(
  algorithm: JwtAdapterAlgorithm,
  key: string,
): Promise<CryptoKey | Uint8Array> {
  if (algorithm === "HS256") {
    return new TextEncoder().encode(key);
  }
  return importSPKI(key, algorithm);
}

function isJoseError(err: unknown): boolean {
  return err instanceof joseErrors.JOSEError;
}
