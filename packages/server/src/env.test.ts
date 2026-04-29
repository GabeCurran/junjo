import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("parses a minimal valid env", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x:y@localhost:5432/z" });
    expect(env.DATABASE_URL).toBe("postgres://x:y@localhost:5432/z");
    expect(env.PORT).toBe(8787);
    expect(env.NODE_ENV).toBe("development");
  });

  it("coerces PORT to a number", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x", PORT: "3001" });
    expect(env.PORT).toBe(3001);
  });

  it("falls back to 8787 when PORT is empty", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x", PORT: "" });
    expect(env.PORT).toBe(8787);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("throws when DATABASE_URL is empty", () => {
    expect(() => loadEnv({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", NODE_ENV: "staging" })).toThrow();
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", PORT: "abc" })).toThrow();
  });

  it("leaves JUNJO_ADMIN_TOKEN undefined when unset", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x" });
    expect(env.JUNJO_ADMIN_TOKEN).toBeUndefined();
  });

  it("accepts a non-empty JUNJO_ADMIN_TOKEN", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      JUNJO_ADMIN_TOKEN: "supersecret-admin-token",
    });
    expect(env.JUNJO_ADMIN_TOKEN).toBe("supersecret-admin-token");
  });

  it("rejects an empty JUNJO_ADMIN_TOKEN", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", JUNJO_ADMIN_TOKEN: "" })).toThrow(
      /JUNJO_ADMIN_TOKEN/,
    );
  });
});
