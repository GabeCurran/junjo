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

  it("defaults RATE_LIMIT_PER_MINUTE to 600 and RATE_LIMIT_BURST to 100", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x" });
    expect(env.RATE_LIMIT_PER_MINUTE).toBe(600);
    expect(env.RATE_LIMIT_BURST).toBe(100);
  });

  it("treats empty RATE_LIMIT_* as the default", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      RATE_LIMIT_PER_MINUTE: "",
      RATE_LIMIT_BURST: "",
    });
    expect(env.RATE_LIMIT_PER_MINUTE).toBe(600);
    expect(env.RATE_LIMIT_BURST).toBe(100);
  });

  it("coerces RATE_LIMIT_* strings to integers", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      RATE_LIMIT_PER_MINUTE: "1200",
      RATE_LIMIT_BURST: "200",
    });
    expect(env.RATE_LIMIT_PER_MINUTE).toBe(1200);
    expect(env.RATE_LIMIT_BURST).toBe(200);
  });

  it("accepts zero as the disable signal for RATE_LIMIT_*", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      RATE_LIMIT_PER_MINUTE: "0",
      RATE_LIMIT_BURST: "0",
    });
    expect(env.RATE_LIMIT_PER_MINUTE).toBe(0);
    expect(env.RATE_LIMIT_BURST).toBe(0);
  });

  it("rejects a negative RATE_LIMIT_PER_MINUTE", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", RATE_LIMIT_PER_MINUTE: "-1" })).toThrow(
      /RATE_LIMIT_PER_MINUTE/,
    );
  });

  it("rejects a non-integer RATE_LIMIT_BURST", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", RATE_LIMIT_BURST: "1.5" })).toThrow(
      /RATE_LIMIT_BURST/,
    );
  });

  it("rejects a non-numeric RATE_LIMIT_PER_MINUTE", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", RATE_LIMIT_PER_MINUTE: "abc" })).toThrow();
  });

  it("defaults LOG_LEVEL to info", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x" });
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("treats empty LOG_LEVEL as the default", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x", LOG_LEVEL: "" });
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("accepts every supported LOG_LEVEL value", () => {
    for (const level of ["error", "warn", "info", "debug", "silent"] as const) {
      const env = loadEnv({ DATABASE_URL: "postgres://x", LOG_LEVEL: level });
      expect(env.LOG_LEVEL).toBe(level);
    }
  });

  it("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", LOG_LEVEL: "trace" })).toThrow(
      /LOG_LEVEL/,
    );
  });

  it("defaults WEBHOOK_ALLOW_PRIVATE_HOSTS to false", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x" });
    expect(env.WEBHOOK_ALLOW_PRIVATE_HOSTS).toBe(false);
  });

  it("accepts 'true' / '1' as enabling WEBHOOK_ALLOW_PRIVATE_HOSTS", () => {
    expect(
      loadEnv({ DATABASE_URL: "postgres://x", WEBHOOK_ALLOW_PRIVATE_HOSTS: "true" })
        .WEBHOOK_ALLOW_PRIVATE_HOSTS,
    ).toBe(true);
    expect(
      loadEnv({ DATABASE_URL: "postgres://x", WEBHOOK_ALLOW_PRIVATE_HOSTS: "1" })
        .WEBHOOK_ALLOW_PRIVATE_HOSTS,
    ).toBe(true);
  });

  it("treats other WEBHOOK_ALLOW_PRIVATE_HOSTS values as false", () => {
    for (const v of ["", "false", "0", "yes", "no"]) {
      const env = loadEnv({ DATABASE_URL: "postgres://x", WEBHOOK_ALLOW_PRIVATE_HOSTS: v });
      expect(env.WEBHOOK_ALLOW_PRIVATE_HOSTS).toBe(false);
    }
  });

  it("defaults JUNJO_MAX_PAGE_SIZE to 100", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x" });
    expect(env.JUNJO_MAX_PAGE_SIZE).toBe(100);
  });

  it("parses JUNJO_MAX_PAGE_SIZE from a numeric string", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x", JUNJO_MAX_PAGE_SIZE: "5000" });
    expect(env.JUNJO_MAX_PAGE_SIZE).toBe(5000);
  });

  it("rejects a non-positive JUNJO_MAX_PAGE_SIZE", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", JUNJO_MAX_PAGE_SIZE: "0" })).toThrow(
      /JUNJO_MAX_PAGE_SIZE/,
    );
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", JUNJO_MAX_PAGE_SIZE: "-1" })).toThrow(
      /JUNJO_MAX_PAGE_SIZE/,
    );
    expect(() => loadEnv({ DATABASE_URL: "postgres://x", JUNJO_MAX_PAGE_SIZE: "1.5" })).toThrow(
      /JUNJO_MAX_PAGE_SIZE/,
    );
  });
});
