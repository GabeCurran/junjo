import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTestDatabaseUrl } from "./testdb";

describe("getTestDatabaseUrl", () => {
  const original = process.env.TEST_DATABASE_URL;

  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: tests must actually unset the env var; assigning undefined would coerce to the string "undefined".
    delete process.env.TEST_DATABASE_URL;
  });

  afterEach(() => {
    if (original === undefined) {
      // biome-ignore lint/performance/noDelete: see beforeEach.
      delete process.env.TEST_DATABASE_URL;
    } else {
      process.env.TEST_DATABASE_URL = original;
    }
  });

  it("returns the value when the env var is set", () => {
    process.env.TEST_DATABASE_URL = "postgres://user:pw@localhost:5432/junjo_test";
    expect(getTestDatabaseUrl()).toBe("postgres://user:pw@localhost:5432/junjo_test");
  });

  it("throws a helpful error when the env var is missing", () => {
    expect(() => getTestDatabaseUrl()).toThrow(/TEST_DATABASE_URL/);
  });

  it("throws when the env var is the empty string", () => {
    process.env.TEST_DATABASE_URL = "";
    expect(() => getTestDatabaseUrl()).toThrow(/TEST_DATABASE_URL/);
  });
});
