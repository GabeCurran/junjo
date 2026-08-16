import { describe, expect, it } from "vitest";
import { PERMISSION_CACHE_TTL_MS, PermissionCache } from "./permissionCache.js";

describe("PermissionCache", () => {
  it("returns null on miss", () => {
    const cache = new PermissionCache();
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toBeNull();
  });

  it("stores and returns a value before the TTL expires", () => {
    let now = 0;
    const cache = new PermissionCache({ now: () => now });
    const result = { allowed: true, source: "role" as const };
    cache.set("g1", "grp_1", "user_alice", "guild.kick", result);
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toEqual(result);
    now = PERMISSION_CACHE_TTL_MS - 1;
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toEqual(result);
  });

  it("evicts entries past the TTL", () => {
    let now = 0;
    const cache = new PermissionCache({ now: () => now });
    cache.set("g1", "grp_1", "user_alice", "guild.kick", { allowed: false, source: "default" });
    now = PERMISSION_CACHE_TTL_MS;
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it("scopes entries by gameId, groupId, userId, and permission", () => {
    const cache = new PermissionCache();
    const a = { allowed: true, source: "role" as const };
    const b = { allowed: false, source: "default" as const };
    cache.set("g1", "grp_1", "user_alice", "guild.kick", a);
    cache.set("g2", "grp_1", "user_alice", "guild.kick", b);
    cache.set("g1", "grp_2", "user_alice", "guild.kick", b);
    cache.set("g1", "grp_1", "user_bob", "guild.kick", b);
    cache.set("g1", "grp_1", "user_alice", "guild.invite", b);
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toEqual(a);
    expect(cache.get("g2", "grp_1", "user_alice", "guild.kick")).toEqual(b);
    expect(cache.get("g1", "grp_2", "user_alice", "guild.kick")).toEqual(b);
    expect(cache.get("g1", "grp_1", "user_bob", "guild.kick")).toEqual(b);
    expect(cache.get("g1", "grp_1", "user_alice", "guild.invite")).toEqual(b);
  });

  it("invalidateGroup removes every entry for that group only", () => {
    const cache = new PermissionCache();
    cache.set("g1", "grp_1", "user_alice", "guild.kick", { allowed: true, source: "role" });
    cache.set("g1", "grp_1", "user_bob", "guild.kick", { allowed: true, source: "role" });
    cache.set("g1", "grp_2", "user_alice", "guild.kick", { allowed: true, source: "role" });
    cache.invalidateGroup("grp_1");
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toBeNull();
    expect(cache.get("g1", "grp_1", "user_bob", "guild.kick")).toBeNull();
    expect(cache.get("g1", "grp_2", "user_alice", "guild.kick")).toEqual({
      allowed: true,
      source: "role",
    });
  });

  it("invalidateGroup is a no-op for unknown group ids", () => {
    const cache = new PermissionCache();
    cache.set("g1", "grp_1", "user_alice", "guild.kick", { allowed: true, source: "role" });
    expect(() => cache.invalidateGroup("grp_unknown")).not.toThrow();
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toEqual({
      allowed: true,
      source: "role",
    });
  });

  it("clear removes every entry", () => {
    const cache = new PermissionCache();
    cache.set("g1", "grp_1", "user_alice", "guild.kick", { allowed: true, source: "role" });
    cache.set("g2", "grp_2", "user_bob", "guild.kick", { allowed: false, source: "default" });
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toBeNull();
  });

  it("supports a custom TTL", () => {
    let now = 0;
    const cache = new PermissionCache({ ttlMs: 500, now: () => now });
    cache.set("g1", "grp_1", "user_alice", "guild.kick", { allowed: true, source: "role" });
    now = 499;
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).not.toBeNull();
    now = 500;
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toBeNull();
  });

  it("preserves viaRoleId on round-trip", () => {
    const cache = new PermissionCache();
    cache.set("g1", "grp_1", "user_alice", "guild.kick", {
      allowed: true,
      source: "role",
      viaRoleId: "role_officer" as never,
    });
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toMatchObject({
      allowed: true,
      source: "role",
      viaRoleId: "role_officer",
    });
  });

  it("does not let one tuple encode to another tuple's key", () => {
    const cache = new PermissionCache();
    const granted = { allowed: true, source: "role" as const };
    // Same characters, different split between userId and permission.
    // A delimiter-joined key would collide and hand the second tuple
    // the first tuple's verdict.
    cache.set("g1", "grp_1", "alice x", "read", granted);
    expect(cache.get("g1", "grp_1", "alice", "x read")).toBeNull();
    expect(cache.get("g1", "grp_1", "alice x", "read")).toEqual(granted);
  });

  it("keys inherited answers separately from direct ones", () => {
    const cache = new PermissionCache();
    const direct = { allowed: false, source: "default" as const };
    const inherited = { allowed: true, source: "role" as const };
    cache.set("g1", "grp_child", "user_alice", "guild.kick", direct);
    cache.set("g1", "grp_child", "user_alice", "guild.kick", inherited, { inherit: true });
    expect(cache.get("g1", "grp_child", "user_alice", "guild.kick")).toEqual(direct);
    expect(cache.get("g1", "grp_child", "user_alice", "guild.kick", { inherit: true })).toEqual(
      inherited,
    );
  });

  it("drops an inherited answer when any group it depends on is invalidated", () => {
    const cache = new PermissionCache();
    const result = { allowed: true, source: "role" as const };
    cache.set("g1", "grp_child", "user_alice", "guild.kick", result, {
      inherit: true,
      dependsOn: ["grp_child", "grp_parent", "grp_root"],
    });

    cache.invalidateGroup("grp_parent");
    expect(cache.get("g1", "grp_child", "user_alice", "guild.kick", { inherit: true })).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it("prunes an invalidated key from the index sets of its other dependencies", () => {
    const cache = new PermissionCache();
    cache.set(
      "g1",
      "grp_child",
      "user_alice",
      "guild.kick",
      { allowed: true, source: "role" },
      {
        inherit: true,
        dependsOn: ["grp_child", "grp_parent"],
      },
    );

    // Invalidating one dependency must leave nothing behind for the
    // other to resurrect or leak.
    cache.invalidateGroup("grp_child");
    expect(cache.size()).toBe(0);
    cache.invalidateGroup("grp_parent");
    expect(cache.size()).toBe(0);

    cache.set("g1", "grp_child", "user_alice", "guild.kick", { allowed: false, source: "default" });
    cache.invalidateGroup("grp_parent");
    expect(cache.get("g1", "grp_child", "user_alice", "guild.kick")).not.toBeNull();
  });

  it("defaults dependsOn to the queried group", () => {
    const cache = new PermissionCache();
    cache.set("g1", "grp_1", "user_alice", "guild.kick", { allowed: true, source: "role" });
    cache.invalidateGroup("grp_1");
    expect(cache.get("g1", "grp_1", "user_alice", "guild.kick")).toBeNull();
  });

  it("rewrites dependencies when a key is set again with a shorter chain", () => {
    const cache = new PermissionCache();
    const first = { allowed: true, source: "role" as const };
    const second = { allowed: false, source: "default" as const };
    cache.set("g1", "grp_child", "user_alice", "guild.kick", first, {
      inherit: true,
      dependsOn: ["grp_child", "grp_parent"],
    });
    cache.set("g1", "grp_child", "user_alice", "guild.kick", second, {
      inherit: true,
      dependsOn: ["grp_child"],
    });

    // grp_parent is no longer on the chain, so its invalidation must
    // not drop the newer answer.
    cache.invalidateGroup("grp_parent");
    expect(cache.get("g1", "grp_child", "user_alice", "guild.kick", { inherit: true })).toEqual(
      second,
    );
  });
});
