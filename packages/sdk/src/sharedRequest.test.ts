import type { GroupId, PermissionKey, UserId } from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo } from "./index.js";
import { SharedRequests } from "./sharedRequest.js";

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

// A fetch whose responses are released by hand, recording the signal
// each request was sent with.
function heldFetch() {
  const signals: (AbortSignal | undefined)[] = [];
  const releases: ((res: Response) => void)[] = [];
  const fetchMock = vi.fn(
    (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        signals.push(init?.signal ?? undefined);
        releases.push(resolve);
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  );
  return { fetchMock, signals, releases };
}

const ALICE = "user_alice" as UserId;
const BOB = "user_bob" as UserId;
const GROUP = "grp_xyz" as GroupId;
const PERM = "guild.kick" as PermissionKey;
const ALLOW = { allowed: true, source: "role" };

function client(fetchMock: unknown, permissionCache?: Record<string, unknown>) {
  return new Junjo({
    apiKey: "test_key",
    baseUrl: "https://example.test",
    fetch: fetchMock as typeof fetch,
    ...(permissionCache ? { permissionCache } : {}),
  });
}

describe("SharedRequests", () => {
  it("drops the entry once the request settles", async () => {
    const shared = new SharedRequests<number>();
    const result = shared.run("k", async () => 1, { timeoutMs: 0 });
    expect(shared.size()).toBe(1);
    expect(await result).toBe(1);
    expect(shared.size()).toBe(0);
  });

  it("turns a synchronous throw from start into a rejection", async () => {
    const shared = new SharedRequests<number>();
    const start = () => {
      throw new Error("sync");
    };
    await expect(shared.run("k", start, { timeoutMs: 0 })).rejects.toThrow("sync");
    expect(shared.size()).toBe(0);
  });
});

describe("Junjo concurrent permission checks", () => {
  it("shares one request between concurrent identical checks", async () => {
    const { fetchMock, releases } = heldFetch();
    const junjo = client(fetchMock);
    const first = junjo.can(ALICE, GROUP, PERM);
    const second = junjo.can(ALICE, GROUP, PERM);
    expect(fetchMock).toHaveBeenCalledOnce();
    releases[0]?.(jsonResponse(ALLOW));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    // The shared answer filled the cache.
    expect(await junjo.can(ALICE, GROUP, PERM)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("starts a fresh request after a shared one fails", async () => {
    let calls = 0;
    const fetchMock = makeFetch(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse({ code: "internal", status: 500, message: "boom" }, 500);
      }
      return jsonResponse(ALLOW);
    });
    const junjo = client(fetchMock);
    const both = await Promise.allSettled([
      junjo.can(ALICE, GROUP, PERM),
      junjo.can(ALICE, GROUP, PERM),
    ]);
    expect(both.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(calls).toBe(1);
    expect(await junjo.can(ALICE, GROUP, PERM)).toBe(true);
    expect(calls).toBe(2);
  });

  it("ends only the aborting caller's wait", async () => {
    const { fetchMock, signals, releases } = heldFetch();
    const junjo = client(fetchMock);
    const controller = new AbortController();
    const aborted = junjo.can(ALICE, GROUP, PERM, { signal: controller.signal });
    const kept = junjo.can(ALICE, GROUP, PERM);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "cancelled" });
    expect(signals[0]?.aborted).toBe(false);
    releases[0]?.(jsonResponse(ALLOW));
    expect(await kept).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("ends only the timed-out caller's wait", async () => {
    const { fetchMock, signals, releases } = heldFetch();
    const junjo = client(fetchMock);
    const timed = junjo.can(ALICE, GROUP, PERM, { timeoutMs: 5 });
    const kept = junjo.can(ALICE, GROUP, PERM, { timeoutMs: 0 });
    await expect(timed).rejects.toMatchObject({ code: "timeout" });
    expect(signals[0]?.aborted).toBe(false);
    releases[0]?.(jsonResponse(ALLOW));
    expect(await kept).toBe(true);
  });

  it("applies the client-level timeout to a caller without its own", async () => {
    const { fetchMock } = heldFetch();
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 5,
    });
    await expect(junjo.can(ALICE, GROUP, PERM)).rejects.toMatchObject({ code: "timeout" });
  });

  it("aborts the shared request once every caller has stopped waiting", async () => {
    const { fetchMock, signals, releases } = heldFetch();
    const junjo = client(fetchMock);
    const a = new AbortController();
    const b = new AbortController();
    const first = junjo.can(ALICE, GROUP, PERM, { signal: a.signal });
    const second = junjo.can(ALICE, GROUP, PERM, { signal: b.signal });
    a.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(signals[0]?.aborted).toBe(false);
    b.abort();
    await expect(second).rejects.toMatchObject({ code: "cancelled" });
    expect(signals[0]?.aborted).toBe(true);

    // The abandoned request is gone; the next check starts its own.
    const next = junjo.can(ALICE, GROUP, PERM);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    releases[1]?.(jsonResponse(ALLOW));
    expect(await next).toBe(true);
  });

  it("rejects at once for a caller whose signal is already aborted", async () => {
    const { fetchMock, releases } = heldFetch();
    const junjo = client(fetchMock);
    const kept = junjo.can(ALICE, GROUP, PERM);
    await expect(
      junjo.can(ALICE, GROUP, PERM, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "cancelled" });
    releases[0]?.(jsonResponse(ALLOW));
    expect(await kept).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not share requests while the cache is off", async () => {
    const fetchMock = makeFetch(async () => jsonResponse(ALLOW));
    const junjo = client(fetchMock, { enabled: false });
    await Promise.all([junjo.can(ALICE, GROUP, PERM), junjo.can(ALICE, GROUP, PERM)]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps different checks on separate requests", async () => {
    const fetchMock = makeFetch(async () => jsonResponse(ALLOW));
    const junjo = client(fetchMock);
    await Promise.all([
      junjo.can(ALICE, GROUP, PERM),
      junjo.can(ALICE, GROUP, PERM, { inherit: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an answer in flight across clearPermissionCache out of the cache", async () => {
    const { fetchMock, releases } = heldFetch();
    const junjo = client(fetchMock);
    const before = junjo.can(ALICE, GROUP, PERM);
    junjo.clearPermissionCache();
    releases[0]?.(jsonResponse(ALLOW));
    expect(await before).toBe(true);
    const after = junjo.can(ALICE, GROUP, PERM);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    releases[1]?.(jsonResponse({ allowed: false, source: "none" }));
    expect(await after).toBe(false);
  });

  it("rides out a 429 on a stale answer for every caller sharing the request", async () => {
    let calls = 0;
    const fetchMock = makeFetch(async () => {
      calls++;
      if (calls === 1) return jsonResponse(ALLOW);
      return jsonResponse(
        { code: "rate_limit_exceeded", status: 429, message: "rate limit exceeded" },
        429,
      );
    });
    const junjo = client(fetchMock, { ttlMs: 0 });
    await junjo.can(ALICE, GROUP, PERM);
    expect(
      await Promise.all([junjo.can(ALICE, GROUP, PERM), junjo.can(ALICE, GROUP, PERM)]),
    ).toEqual([true, true]);
    expect(calls).toBe(2);
  });
});

describe("Junjo checkBatch repeated entries", () => {
  it("sends a repeated check once and answers every position", async () => {
    let sent: unknown[] = [];
    const fetchMock = makeFetch(async (req) => {
      sent = ((await req.json()) as { checks: unknown[] }).checks;
      return jsonResponse({
        results: [
          { allowed: true, source: "role" },
          { allowed: false, source: "none" },
        ],
      });
    });
    const results = await client(fetchMock).checkBatch([
      { userId: ALICE, groupId: GROUP, permission: PERM },
      { userId: BOB, groupId: GROUP, permission: PERM },
      { userId: ALICE, groupId: GROUP, permission: PERM },
      { userId: BOB, groupId: GROUP, permission: PERM },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      { userId: ALICE, groupId: GROUP, permission: PERM },
      { userId: BOB, groupId: GROUP, permission: PERM },
    ]);
    expect(results.map((r) => r.allowed)).toEqual([true, false, true, false]);
  });

  it("dedupes repeats with the cache off too", async () => {
    let sent = 0;
    const fetchMock = makeFetch(async (req) => {
      sent = ((await req.json()) as { checks: unknown[] }).checks.length;
      return jsonResponse({ results: [{ allowed: true, source: "role" }] });
    });
    const results = await client(fetchMock, { enabled: false }).checkBatch([
      { userId: ALICE, groupId: GROUP, permission: PERM },
      { userId: ALICE, groupId: GROUP, permission: PERM },
    ]);
    expect(sent).toBe(1);
    expect(results.map((r) => r.allowed)).toEqual([true, true]);
  });
});
