import { describe, expect, it } from "vitest";
import { generateApiKey, hashSecret, parseApiKey, verifySecret } from "./apiKey";

describe("apiKey crypto", () => {
  it("round-trips a hashed secret", async () => {
    const stored = await hashSecret("hunter2");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifySecret("hunter2", stored)).toBe(true);
    expect(await verifySecret("hunter3", stored)).toBe(false);
  });

  it("uses a fresh salt each time", async () => {
    const a = await hashSecret("same-secret");
    const b = await hashSecret("same-secret");
    expect(a).not.toBe(b);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifySecret("x", "")).toBe(false);
    expect(await verifySecret("x", "scrypt$onlyone")).toBe(false);
    expect(await verifySecret("x", "argon2$salt$key")).toBe(false);
  });

  it("generates a usable key pair", async () => {
    const key = await generateApiKey();
    expect(key.full).toBe(`${key.prefix}.${key.secret}`);
    expect(key.prefix.startsWith("jk_")).toBe(true);
    expect(await verifySecret(key.secret, key.hashedSecret)).toBe(true);
  });
});

describe("parseApiKey", () => {
  it("splits on the first dot", () => {
    expect(parseApiKey("abc.xyz.qrs")).toEqual({ prefix: "abc", secret: "xyz.qrs" });
  });

  it("returns null for missing dot", () => {
    expect(parseApiKey("nodothere")).toBeNull();
  });

  it("returns null for empty prefix or empty secret", () => {
    expect(parseApiKey(".secret")).toBeNull();
    expect(parseApiKey("prefix.")).toBeNull();
  });
});
