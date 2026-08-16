import type { GroupId, PermissionKey, UserId } from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo } from "./index.js";
import { PermissionCache } from "./permissionCache.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(handler: (req: Request) => Response | Promise<Response>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = url instanceof URL ? url.toString() : (url as string);
    return handler(new Request(target, init));
  });
}

const ALICE = "user_alice" as UserId;
const GROUP = "grp_xyz" as GroupId;
const PERM = "guild.kick" as PermissionKey;

describe("PermissionCache", () => {
  it("returns null on miss", () => {
    const cache = new PermissionCache();
    expect(cache.get(cache.key("u", "g", "p", false))).toBeNull();
  });

  it("serves a value until the TTL elapses", () => {
    let now = 0;
    const cache = new PermissionCache({ ttlMs: 1000, now: () => now });
    const key = cache.key("u", "g", "p", false);
    cache.set(key, { allowed: true, source: "role" });

    now = 999;
    expect(cache.get(key)).toEqual({ allowed: true, source: "role" });
    now = 1000;
    expect(cache.get(key)).toBeNull();
  });

  it("stores nothing while disabled", () => {
    const cache = new PermissionCache({ enabled: false });
    const key = cache.key("u", "g", "p", false);
    cache.set(key, { allowed: true, source: "role" });
    expect(cache.get(key)).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it("separates inherited keys from direct ones", () => {
    const cache = new PermissionCache();
    expect(cache.key("u", "g", "p", true)).not.toBe(cache.key("u", "g", "p", false));
  });

  it("does not let one tuple encode to another tuple's key", () => {
    const cache = new PermissionCache();
    expect(cache.key("alice x", "g", "read", false)).not.toBe(
      cache.key("alice", "g", "x read", false),
    );
  });

  it("evicts the oldest entry past maxEntries", () => {
    const cache = new PermissionCache({ maxEntries: 2 });
    const keys = ["a", "b", "c"].map((p) => cache.key("u", "g", p, false));
    for (const k of keys) cache.set(k, { allowed: true, source: "role" });

    expect(cache.size()).toBe(2);
    expect(cache.get(keys[0] as string)).toBeNull();
    expect(cache.get(keys[2] as string)).not.toBeNull();
  });

  it("refreshing an entry moves it out of the eviction slot", () => {
    const cache = new PermissionCache({ maxEntries: 2 });
    const a = cache.key("u", "g", "a", false);
    const b = cache.key("u", "g", "b", false);
    const c = cache.key("u", "g", "c", false);
    cache.set(a, { allowed: true, source: "role" });
    cache.set(b, { allowed: true, source: "role" });
    cache.set(a, { allowed: true, source: "role" });
    cache.set(c, { allowed: true, source: "role" });

    // `b` is now the oldest insertion, so `a` survives.
    expect(cache.get(a)).not.toBeNull();
    expect(cache.get(b)).toBeNull();
  });

  it("serves an expired entry as stale inside the stale window", () => {
    let now = 0;
    const cache = new PermissionCache({
      ttlMs: 100,
      staleWhileRateLimitedMs: 900,
      now: () => now,
    });
    const key = cache.key("u", "g", "p", false);
    cache.set(key, { allowed: true, source: "role" });

    now = 500;
    expect(cache.get(key)).toBeNull();
    expect(cache.getStale(key)).toEqual({ allowed: true, source: "role" });

    now = 1000;
    expect(cache.getStale(key)).toBeNull();
  });

  it("returns no stale entry when serve-stale is off", () => {
    let now = 0;
    const cache = new PermissionCache({
      ttlMs: 100,
      serveStaleOnRateLimit: false,
      now: () => now,
    });
    const key = cache.key("u", "g", "p", false);
    cache.set(key, { allowed: true, source: "role" });
    now = 500;
    expect(cache.getStale(key)).toBeNull();
  });

  it("clear drops everything", () => {
    const cache = new PermissionCache();
    cache.set(cache.key("u", "g", "p", false), { allowed: true, source: "role" });
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe("Junjo permission cache integration", () => {
  function client(fetchMock: unknown, permissionCache?: Record<string, unknown>) {
    return new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as typeof fetch,
      ...(permissionCache ? { permissionCache } : {}),
    });
  }

  it("is on by default: a repeated check makes one request", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ allowed: true, source: "role" }));
    const junjo = client(fetchMock);
    expect(await junjo.can(ALICE, GROUP, PERM)).toBe(true);
    expect(await junjo.can(ALICE, GROUP, PERM)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("can be turned off", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ allowed: true, source: "role" }));
    const junjo = client(fetchMock, { enabled: false });
    await junjo.check(ALICE, GROUP, PERM);
    await junjo.check(ALICE, GROUP, PERM);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keys inherited answers separately from direct ones", async () => {
    const seen: (string | null)[] = [];
    const fetchMock = makeFetch(async (req) => {
      const inherit = new URL(req.url).searchParams.get("inherit");
      seen.push(inherit);
      return jsonResponse({ allowed: inherit === "true", source: "role" });
    });
    const junjo = client(fetchMock);

    expect(await junjo.can(ALICE, GROUP, PERM)).toBe(false);
    expect(await junjo.can(ALICE, GROUP, PERM, { inherit: true })).toBe(true);
    expect(seen).toEqual([null, "true"]);
  });

  it("does not answer one tuple from another tuple's entry", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ allowed: true, source: "role" }));
    const junjo = client(fetchMock);
    await junjo.can("alice x" as UserId, GROUP, "read" as PermissionKey);
    await junjo.can("alice" as UserId, GROUP, "x read" as PermissionKey);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clearPermissionCache sends the next check back to the server", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ allowed: true, source: "role" }));
    const junjo = client(fetchMock);
    await junjo.check(ALICE, GROUP, PERM);
    junjo.clearPermissionCache();
    await junjo.check(ALICE, GROUP, PERM);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rides out a 429 on a stale answer instead of surfacing a denial", async () => {
    let calls = 0;
    const fetchMock = makeFetch(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ allowed: true, source: "role" });
      return jsonResponse(
        { code: "rate_limit_exceeded", status: 429, message: "rate limit exceeded" },
        429,
      );
    });
    // ttlMs 0 expires the entry immediately, so the second call must
    // reach the server and hit the 429.
    const junjo = client(fetchMock, { ttlMs: 0 });

    expect(await junjo.can(ALICE, GROUP, PERM)).toBe(true);
    expect(await junjo.can(ALICE, GROUP, PERM)).toBe(true);
    expect(calls).toBe(2);
  });

  it("propagates a 429 when nothing stale is available", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        { code: "rate_limit_exceeded", status: 429, message: "rate limit exceeded" },
        429,
      ),
    );
    await expect(client(fetchMock).can(ALICE, GROUP, PERM)).rejects.toMatchObject({
      code: "rate_limit_exceeded",
    });
  });

  it("propagates a 429 when serve-stale is off", async () => {
    let calls = 0;
    const fetchMock = makeFetch(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ allowed: true, source: "role" });
      return jsonResponse(
        { code: "rate_limit_exceeded", status: 429, message: "rate limit exceeded" },
        429,
      );
    });
    const junjo = client(fetchMock, { ttlMs: 0, serveStaleOnRateLimit: false });
    await junjo.can(ALICE, GROUP, PERM);
    await expect(junjo.can(ALICE, GROUP, PERM)).rejects.toMatchObject({
      code: "rate_limit_exceeded",
    });
  });

  it("does not serve stale answers for other failures", async () => {
    let calls = 0;
    const fetchMock = makeFetch(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ allowed: true, source: "role" });
      return jsonResponse({ code: "internal", status: 500, message: "boom" }, 500);
    });
    const junjo = client(fetchMock, { ttlMs: 0 });
    await junjo.can(ALICE, GROUP, PERM);
    await expect(junjo.can(ALICE, GROUP, PERM)).rejects.toMatchObject({ code: "internal" });
  });
});
