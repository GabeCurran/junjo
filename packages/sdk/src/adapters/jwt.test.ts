import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { JunjoError } from "../errors.js";
import { jwtAdapter } from "./jwt.js";

const HS256_SECRET = "this-is-a-shared-hmac-secret-for-tests";

async function signHs256(
  payload: Record<string, unknown>,
  opts?: {
    secret?: string;
    issuer?: string;
    audience?: string | string[];
    expiresIn?: string;
    notBefore?: string;
  },
): Promise<string> {
  let builder = new SignJWT(payload).setProtectedHeader({ alg: "HS256" });
  if (opts?.issuer !== undefined) builder = builder.setIssuer(opts.issuer);
  if (opts?.audience !== undefined) builder = builder.setAudience(opts.audience);
  if (opts?.expiresIn !== undefined) builder = builder.setExpirationTime(opts.expiresIn);
  if (opts?.notBefore !== undefined) builder = builder.setNotBefore(opts.notBefore);
  return builder.sign(new TextEncoder().encode(opts?.secret ?? HS256_SECRET));
}

interface AsymKey {
  spki: string;
  privateKey: CryptoKey;
}

async function generateAsymKey(alg: "RS256" | "ES256"): Promise<AsymKey> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const spki = await exportSPKI(publicKey);
  return { spki, privateKey };
}

async function signAsym(
  alg: "RS256" | "ES256",
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg }).sign(privateKey);
}

describe("jwtAdapter HS256", () => {
  it("verifies a token signed with the same secret and returns the sub claim", async () => {
    const adapter = jwtAdapter({ key: HS256_SECRET, algorithm: "HS256" });
    const token = await signHs256({ sub: "user_abc" });
    const result = await adapter.verifyToken(token);
    expect(result).toEqual({ userId: "user_abc" });
  });

  it("returns null when the secret does not match", async () => {
    const adapter = jwtAdapter({
      key: "a-completely-different-hmac-secret-for-tests",
      algorithm: "HS256",
    });
    const token = await signHs256({ sub: "user_abc" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });

  it("returns null when the token signature has been tampered", async () => {
    const adapter = jwtAdapter({ key: HS256_SECRET, algorithm: "HS256" });
    const token = await signHs256({ sub: "user_abc" });
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(await adapter.verifyToken(tampered)).toBeNull();
  });

  it("returns null on a malformed (not three-segment) token", async () => {
    const adapter = jwtAdapter({ key: HS256_SECRET, algorithm: "HS256" });
    expect(await adapter.verifyToken("garbage")).toBeNull();
    expect(await adapter.verifyToken("a.b")).toBeNull();
  });

  it("returns null on an empty or non-string token", async () => {
    const adapter = jwtAdapter({ key: HS256_SECRET, algorithm: "HS256" });
    expect(await adapter.verifyToken("")).toBeNull();
  });

  it("returns null when the token is expired", async () => {
    const adapter = jwtAdapter({ key: HS256_SECRET, algorithm: "HS256" });
    const token = await signHs256({ sub: "user_abc" }, { expiresIn: "-5m" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });

  it("returns null when nbf is in the future", async () => {
    const adapter = jwtAdapter({ key: HS256_SECRET, algorithm: "HS256" });
    const token = await signHs256({ sub: "user_abc" }, { notBefore: "10m" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });

  it("rejects a token signed with a different algorithm than configured", async () => {
    const adapter = jwtAdapter({ key: HS256_SECRET, algorithm: "HS256" });
    const { spki, privateKey } = await generateAsymKey("RS256");
    void spki;
    const token = await signAsym("RS256", privateKey, { sub: "user_abc" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });
});

describe("jwtAdapter RS256", () => {
  it("verifies a token signed with the matching RSA private key", async () => {
    const { spki, privateKey } = await generateAsymKey("RS256");
    const adapter = jwtAdapter({ key: spki, algorithm: "RS256" });
    const token = await signAsym("RS256", privateKey, { sub: "user_rs256" });
    expect(await adapter.verifyToken(token)).toEqual({ userId: "user_rs256" });
  });

  it("returns null when the public key does not match the signing key", async () => {
    const { spki: _ignored, privateKey } = await generateAsymKey("RS256");
    const { spki: otherSpki } = await generateAsymKey("RS256");
    const adapter = jwtAdapter({ key: otherSpki, algorithm: "RS256" });
    const token = await signAsym("RS256", privateKey, { sub: "user_rs256" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });

  it("throws JunjoError(invalid_config) when the PEM is malformed", async () => {
    const adapter = jwtAdapter({
      key: "-----BEGIN PUBLIC KEY-----\nnot-actually-base64\n-----END PUBLIC KEY-----",
      algorithm: "RS256",
    });
    await expect(adapter.verifyToken("any.token.here")).rejects.toMatchObject({
      name: "JunjoError",
      code: "invalid_config",
    });
  });
});

describe("jwtAdapter ES256", () => {
  it("verifies a token signed with the matching EC private key", async () => {
    const { spki, privateKey } = await generateAsymKey("ES256");
    const adapter = jwtAdapter({ key: spki, algorithm: "ES256" });
    const token = await signAsym("ES256", privateKey, { sub: "user_es256" });
    expect(await adapter.verifyToken(token)).toEqual({ userId: "user_es256" });
  });

  it("returns null when the public key does not match the signing key", async () => {
    const { privateKey } = await generateAsymKey("ES256");
    const { spki: otherSpki } = await generateAsymKey("ES256");
    const adapter = jwtAdapter({ key: otherSpki, algorithm: "ES256" });
    const token = await signAsym("ES256", privateKey, { sub: "user_es256" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });
});

describe("jwtAdapter claim handling", () => {
  it("reads the user id from a custom claim when userIdClaim is set", async () => {
    const adapter = jwtAdapter({
      key: HS256_SECRET,
      algorithm: "HS256",
      userIdClaim: "user_id",
    });
    const token = await signHs256({ sub: "ignored", user_id: "user_xyz" });
    expect(await adapter.verifyToken(token)).toEqual({ userId: "user_xyz" });
  });

  it("returns null when the configured claim is missing", async () => {
    const adapter = jwtAdapter({
      key: HS256_SECRET,
      algorithm: "HS256",
      userIdClaim: "user_id",
    });
    const token = await signHs256({ sub: "user_abc" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });

  it("returns null when the configured claim is not a string", async () => {
    const adapter = jwtAdapter({ key: HS256_SECRET, algorithm: "HS256" });
    const token = await signHs256({ sub: 12345 });
    expect(await adapter.verifyToken(token)).toBeNull();
  });

  it("returns null when the configured claim is an empty string", async () => {
    const adapter = jwtAdapter({ key: HS256_SECRET, algorithm: "HS256" });
    const token = await signHs256({ sub: "" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });
});

describe("jwtAdapter iss/aud validation", () => {
  it("accepts a token whose iss matches the configured issuer", async () => {
    const adapter = jwtAdapter({
      key: HS256_SECRET,
      algorithm: "HS256",
      issuer: "https://issuer.example",
    });
    const token = await signHs256({ sub: "user_abc" }, { issuer: "https://issuer.example" });
    expect(await adapter.verifyToken(token)).toEqual({ userId: "user_abc" });
  });

  it("rejects a token whose iss does not match the configured issuer", async () => {
    const adapter = jwtAdapter({
      key: HS256_SECRET,
      algorithm: "HS256",
      issuer: "https://issuer.example",
    });
    const token = await signHs256({ sub: "user_abc" }, { issuer: "https://attacker.example" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });

  it("rejects a token missing iss when an issuer is configured", async () => {
    const adapter = jwtAdapter({
      key: HS256_SECRET,
      algorithm: "HS256",
      issuer: "https://issuer.example",
    });
    const token = await signHs256({ sub: "user_abc" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });

  it("accepts a token whose aud matches the configured audience", async () => {
    const adapter = jwtAdapter({
      key: HS256_SECRET,
      algorithm: "HS256",
      audience: "junjo-api",
    });
    const token = await signHs256({ sub: "user_abc" }, { audience: "junjo-api" });
    expect(await adapter.verifyToken(token)).toEqual({ userId: "user_abc" });
  });

  it("rejects a token whose aud does not include the configured audience", async () => {
    const adapter = jwtAdapter({
      key: HS256_SECRET,
      algorithm: "HS256",
      audience: "junjo-api",
    });
    const token = await signHs256({ sub: "user_abc" }, { audience: "different-api" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });

  it("accepts a token when the configured audience is one of an aud array", async () => {
    const adapter = jwtAdapter({
      key: HS256_SECRET,
      algorithm: "HS256",
      audience: "junjo-api",
    });
    const token = await signHs256({ sub: "user_abc" }, { audience: ["other-api", "junjo-api"] });
    expect(await adapter.verifyToken(token)).toEqual({ userId: "user_abc" });
  });

  it("does not require iss when no issuer is configured", async () => {
    const adapter = jwtAdapter({ key: HS256_SECRET, algorithm: "HS256" });
    const token = await signHs256({ sub: "user_abc" }, { issuer: "https://anything.example" });
    expect(await adapter.verifyToken(token)).toEqual({ userId: "user_abc" });
  });
});

describe("jwtAdapter clock tolerance", () => {
  it("accepts a token expired within the configured clockToleranceSeconds", async () => {
    const adapter = jwtAdapter({
      key: HS256_SECRET,
      algorithm: "HS256",
      clockToleranceSeconds: 600,
    });
    const token = await signHs256({ sub: "user_abc" }, { expiresIn: "-30s" });
    expect(await adapter.verifyToken(token)).toEqual({ userId: "user_abc" });
  });

  it("still rejects a token expired well outside the clockToleranceSeconds window", async () => {
    const adapter = jwtAdapter({
      key: HS256_SECRET,
      algorithm: "HS256",
      clockToleranceSeconds: 60,
    });
    const token = await signHs256({ sub: "user_abc" }, { expiresIn: "-10m" });
    expect(await adapter.verifyToken(token)).toBeNull();
  });
});

describe("jwtAdapter configuration validation", () => {
  it("throws JunjoError(invalid_config) when key is empty", () => {
    expect(() => jwtAdapter({ key: "", algorithm: "HS256" })).toThrow(JunjoError);
  });

  it("throws JunjoError(invalid_config) when algorithm is unsupported", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: testing a bad runtime value
      jwtAdapter({ key: HS256_SECRET, algorithm: "RS512" as any }),
    ).toThrow(JunjoError);
  });

  it("rejects an HS256 secret shorter than 32 bytes", () => {
    const thirtyOneBytes = "a".repeat(31);
    expect(() => jwtAdapter({ key: thirtyOneBytes, algorithm: "HS256" })).toThrow(
      /at least 32 bytes/,
    );
  });

  it("accepts an HS256 secret of exactly 32 bytes", () => {
    const thirtyTwoBytes = "a".repeat(32);
    expect(() => jwtAdapter({ key: thirtyTwoBytes, algorithm: "HS256" })).not.toThrow();
  });

  it("measures the HS256 minimum in UTF-8 bytes, not code units", () => {
    // 16 two-byte characters: 16 code units but 32 UTF-8 bytes.
    const sixteenTwoByteChars = "é".repeat(16);
    expect(() => jwtAdapter({ key: sixteenTwoByteChars, algorithm: "HS256" })).not.toThrow();
  });

  it("does not enforce the 32-byte minimum on RS256/ES256 PEMs", async () => {
    const { spki } = await generateAsymKey("RS256");
    expect(() => jwtAdapter({ key: spki, algorithm: "RS256" })).not.toThrow();
  });
});

describe("jwtAdapter key import failure handling", () => {
  it("does not emit an unhandled rejection when constructed with a bad PEM and never used", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      jwtAdapter({
        key: "-----BEGIN PUBLIC KEY-----\nnot-actually-base64\n-----END PUBLIC KEY-----",
        algorithm: "RS256",
      });
      // The eager-import bug surfaced on the microtask queue; give it
      // several macrotask turns to fire before asserting silence.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("throws the same JunjoError on every verifyToken call after a failed import", async () => {
    const adapter = jwtAdapter({
      key: "-----BEGIN PUBLIC KEY-----\nnot-actually-base64\n-----END PUBLIC KEY-----",
      algorithm: "RS256",
    });
    await expect(adapter.verifyToken("any.token.here")).rejects.toMatchObject({
      code: "invalid_config",
    });
    await expect(adapter.verifyToken("any.token.here")).rejects.toMatchObject({
      code: "invalid_config",
    });
  });
});
