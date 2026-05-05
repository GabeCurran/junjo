import { describe, expect, it } from "vitest";
import { DEFAULT_GAME_CONFIG, mergeGameConfig, resolveGameConfig } from "./defaults.js";

describe("resolveGameConfig", () => {
  it("returns DEFAULT_GAME_CONFIG when input is null", () => {
    expect(resolveGameConfig(null)).toEqual(DEFAULT_GAME_CONFIG);
  });

  it("returns DEFAULT_GAME_CONFIG when input is undefined", () => {
    expect(resolveGameConfig(undefined)).toEqual(DEFAULT_GAME_CONFIG);
  });

  it("returns DEFAULT_GAME_CONFIG when input is the empty object (the row's default value)", () => {
    expect(resolveGameConfig({})).toEqual(DEFAULT_GAME_CONFIG);
  });

  it("overrides only the fields the partial sets", () => {
    const result = resolveGameConfig({ friends: { enabled: false } });
    expect(result.friends.enabled).toBe(false);
    expect(result.friends.scope).toBe("per-game");
    expect(result.friends.maxFriends).toBe(1000);
    expect(result.blocks.enabled).toBe(true);
  });

  it("deep-merges the friends.tags branch", () => {
    const result = resolveGameConfig({ friends: { tags: { maxPerUser: 5 } } });
    expect(result.friends.tags.maxPerUser).toBe(5);
    expect(result.friends.tags.enabled).toBe(true);
  });

  it("canonicalizes visibility.allowed (de-dupes, stable order)", () => {
    const result = resolveGameConfig({
      friends: { visibility: { allowed: ["public", "private", "public"] } },
    });
    expect(result.friends.visibility.allowed).toEqual(["private", "public"]);
  });

  it("falls back default to first allowed when stored default is no longer in allowed", () => {
    // A game that previously allowed all three visibilities and chose
    // "public" as default; an admin then narrowed allowed to ["private"].
    // The default should snap to "private".
    const result = resolveGameConfig({
      friends: {
        visibility: { allowed: ["private"], default: "public" },
      },
    });
    expect(result.friends.visibility.default).toBe("private");
  });

  it("keeps the default when it is in the allowed set", () => {
    const result = resolveGameConfig({
      friends: {
        visibility: {
          allowed: ["private", "friends-only", "public"],
          default: "public",
        },
      },
    });
    expect(result.friends.visibility.default).toBe("public");
  });

  it("ignores unknown branches (defensive against operator hand-edits)", () => {
    const result = resolveGameConfig({
      // biome-ignore lint/suspicious/noExplicitAny: testing hand-crafted partial
      friends: { foo: "bar" } as any,
    });
    expect(result.friends.enabled).toBe(true);
  });
});

describe("mergeGameConfig", () => {
  it("returns the patch when existing is null", () => {
    const result = mergeGameConfig(null, { friends: { enabled: false } });
    expect(result).toEqual({ friends: { enabled: false } });
  });

  it("preserves existing branches the patch does not touch", () => {
    const existing = { friends: { enabled: false, maxFriends: 50 } };
    const result = mergeGameConfig(existing, { blocks: { enabled: false } });
    expect(result.friends).toEqual(existing.friends);
    expect(result.blocks).toEqual({ enabled: false });
  });

  it("deep-merges the friends.tags branch", () => {
    const existing = { friends: { tags: { enabled: true, maxPerUser: 20 } } };
    const result = mergeGameConfig(existing, {
      friends: { tags: { maxPerUser: 5 } },
    });
    expect(result.friends?.tags).toEqual({ enabled: true, maxPerUser: 5 });
  });

  it("overwrites scalar fields at the friends level", () => {
    const existing = { friends: { enabled: true, maxFriends: 100 } };
    const result = mergeGameConfig(existing, { friends: { maxFriends: 200 } });
    expect(result.friends).toEqual({ enabled: true, maxFriends: 200 });
  });

  it("supports a no-op patch (empty object)", () => {
    const existing = { friends: { enabled: false } };
    expect(mergeGameConfig(existing, {})).toEqual(existing);
  });
});
