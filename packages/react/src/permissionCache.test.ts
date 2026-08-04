import type { GroupId, PermissionKey, UserId } from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { MAX_ENTRIES, PermissionCache, makeCacheKey } from "./permissionCache.js";

const USER_A = "user_a" as UserId;
const USER_B = "user_b" as UserId;
const GROUP_A = "grp_alpha" as GroupId;
const GROUP_B = "grp_beta" as GroupId;
const PERMISSION = "invite_member" as PermissionKey;

describe("makeCacheKey", () => {
  it("does not collide when ids contain spaces", () => {
    // With a space delimiter both triples would flatten to the same
    // "user a grp perm" string.
    const shifted = makeCacheKey("user a" as UserId, "grp" as GroupId, "perm" as PermissionKey);
    const original = makeCacheKey("user" as UserId, "a grp" as GroupId, "perm" as PermissionKey);
    expect(shifted).not.toBe(original);
  });
});

describe("PermissionCache scoped invalidation", () => {
  interface Seeded {
    cache: PermissionCache;
    keys: { aA: string; aB: string; bA: string; bB: string };
    listeners: {
      aA: ReturnType<typeof vi.fn>;
      aB: ReturnType<typeof vi.fn>;
      bA: ReturnType<typeof vi.fn>;
      bB: ReturnType<typeof vi.fn>;
    };
  }

  async function seeded(): Promise<Seeded> {
    const cache = new PermissionCache();
    const keys = {
      aA: makeCacheKey(USER_A, GROUP_A, PERMISSION),
      aB: makeCacheKey(USER_A, GROUP_B, PERMISSION),
      bA: makeCacheKey(USER_B, GROUP_A, PERMISSION),
      bB: makeCacheKey(USER_B, GROUP_B, PERMISSION),
    };
    const listeners = { aA: vi.fn(), aB: vi.fn(), bA: vi.fn(), bB: vi.fn() };
    for (const name of ["aA", "aB", "bA", "bB"] as const) {
      await cache.prefetch(keys[name], async () => true);
      cache.subscribe(keys[name], listeners[name]);
    }
    return { cache, keys, listeners };
  }

  it("invalidateUser sweeps only that user's keys and notifies their listeners", async () => {
    const { cache, keys, listeners } = await seeded();

    cache.invalidateUser(USER_A);

    expect(cache.has(keys.aA)).toBe(false);
    expect(cache.has(keys.aB)).toBe(false);
    expect(cache.has(keys.bA)).toBe(true);
    expect(cache.has(keys.bB)).toBe(true);
    expect(listeners.aA).toHaveBeenCalledTimes(1);
    expect(listeners.aB).toHaveBeenCalledTimes(1);
    expect(listeners.bA).not.toHaveBeenCalled();
    expect(listeners.bB).not.toHaveBeenCalled();
  });

  it("invalidateGroup sweeps only that group's keys and notifies their listeners", async () => {
    const { cache, keys, listeners } = await seeded();

    cache.invalidateGroup(GROUP_B);

    expect(cache.has(keys.aA)).toBe(true);
    expect(cache.has(keys.aB)).toBe(false);
    expect(cache.has(keys.bA)).toBe(true);
    expect(cache.has(keys.bB)).toBe(false);
    expect(listeners.aA).not.toHaveBeenCalled();
    expect(listeners.aB).toHaveBeenCalledTimes(1);
    expect(listeners.bA).not.toHaveBeenCalled();
    expect(listeners.bB).toHaveBeenCalledTimes(1);
  });

  it("invalidateUser does not match a userId that only appears as the groupId segment", async () => {
    const cache = new PermissionCache();
    const key = makeCacheKey(USER_A, "user_b" as GroupId, PERMISSION);
    await cache.prefetch(key, async () => true);

    cache.invalidateUser(USER_B);

    expect(cache.has(key)).toBe(true);
  });
});

describe("PermissionCache eviction", () => {
  const keyFor = (i: number) => makeCacheKey(`user_${i}` as UserId, GROUP_A, PERMISSION);

  it("evicts the oldest entries once MAX_ENTRIES is exceeded", async () => {
    const cache = new PermissionCache();
    for (let i = 0; i < MAX_ENTRIES + 2; i++) {
      await cache.prefetch(keyFor(i), async () => true);
    }

    expect(cache.has(keyFor(0))).toBe(false);
    expect(cache.has(keyFor(1))).toBe(false);
    expect(cache.has(keyFor(2))).toBe(true);
    expect(cache.has(keyFor(MAX_ENTRIES + 1))).toBe(true);
  });

  it("evicted keys are refetchable through prefetch again", async () => {
    const cache = new PermissionCache();
    for (let i = 0; i < MAX_ENTRIES + 1; i++) {
      await cache.prefetch(keyFor(i), async () => true);
    }
    expect(cache.has(keyFor(0))).toBe(false);

    const fetcher = vi.fn(async () => false);
    await cache.prefetch(keyFor(0), fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.get(keyFor(0))).toBe(false);
  });
});

describe("PermissionCache invalidation races", () => {
  const KEY = makeCacheKey(USER_A, GROUP_A, PERMISSION);

  interface Deferred {
    promise: Promise<boolean>;
    resolve: (v: boolean) => void;
    reject: (e: Error) => void;
  }

  function deferred(): Deferred {
    let resolve!: (v: boolean) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<boolean>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("a fetch that settles after invalidate() does not overwrite the newer fetch's result", async () => {
    const cache = new PermissionCache();
    const stale = deferred();
    const staleResult = cache.prefetch(KEY, () => stale.promise);

    cache.invalidate(KEY);
    await cache.prefetch(KEY, async () => true);
    expect(cache.get(KEY)).toBe(true);

    stale.resolve(false);
    await staleResult;

    expect(cache.get(KEY)).toBe(true);
  });

  it("a fetch that fails after invalidate() does not evict the newer in-flight fetch", async () => {
    const cache = new PermissionCache();
    const stale = deferred();
    const staleResult = cache.prefetch(KEY, () => stale.promise);

    cache.invalidate(KEY);
    const fresh = deferred();
    const freshResult = cache.prefetch(KEY, () => fresh.promise);

    stale.reject(new Error("network down"));
    await staleResult;

    // The fresh fetch must still own the inflight slot: a third prefetch
    // joins it instead of starting a duplicate request.
    const joiner = vi.fn(async () => false);
    const joined = cache.prefetch(KEY, joiner);
    expect(joiner).not.toHaveBeenCalled();

    fresh.resolve(true);
    await Promise.all([freshResult, joined]);
    expect(cache.get(KEY)).toBe(true);
  });

  it("a stale settle after invalidate() does not notify listeners", async () => {
    const cache = new PermissionCache();
    const stale = deferred();
    const staleResult = cache.prefetch(KEY, () => stale.promise);

    cache.invalidate(KEY);
    const listener = vi.fn();
    cache.subscribe(KEY, listener);

    stale.resolve(false);
    await staleResult;

    expect(listener).not.toHaveBeenCalled();
    expect(cache.has(KEY)).toBe(false);
  });
});
