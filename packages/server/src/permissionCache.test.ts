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
});
