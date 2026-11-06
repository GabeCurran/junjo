import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { permissionContextKey } from "./index.js";
import { contextQuery } from "./permissionContext.js";

interface EntryContextVector {
  context: Record<string, string>;
  valid: boolean;
  canonical?: string;
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../shared/conformance/permission-vectors.json", import.meta.url),
    "utf8",
  ),
) as { entryContexts: EntryContextVector[] };

describe("permissionContextKey", () => {
  const canonical = vectors.entryContexts.filter((v) => v.valid && v.canonical !== undefined);

  it("has conformance vectors to check against", () => {
    expect(canonical.length).toBeGreaterThan(0);
  });

  for (const vector of canonical) {
    it(`matches the canonical key for ${JSON.stringify(vector.context)}`, () => {
      expect(permissionContextKey(vector.context)).toBe(vector.canonical);
    });
  }

  it("is empty for an absent or empty context", () => {
    expect(permissionContextKey(undefined)).toBe("");
    expect(permissionContextKey({})).toBe("");
  });

  it("does not depend on key order", () => {
    expect(permissionContextKey({ world: "a", server: "b" })).toBe(
      permissionContextKey({ server: "b", world: "a" }),
    );
  });

  it("folds ASCII letters only", () => {
    expect(permissionContextKey({ world: "NetherÉ" })).toBe('[["world","netherÉ"]]');
  });
});

describe("contextQuery", () => {
  it("is empty for a global context", () => {
    expect(contextQuery(undefined)).toBe("");
    expect(contextQuery({})).toBe("");
  });

  it("encodes one context.<key> parameter per key, sorted by key", () => {
    expect(contextQuery({ world: "a&b", server: "eu west" })).toBe(
      "?context.server=eu+west&context.world=a%26b",
    );
  });
});
