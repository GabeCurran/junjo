import type { GroupId, PermissionKey, RoleId, UserId } from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(handler: (req: Request) => Response | Promise<Response>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = url instanceof URL ? url.toString() : (url as string);
    const req = new Request(target, init);
    return handler(req);
  });
}

describe("junjo.check", () => {
  it("GETs /v1/permissions/check with the auth header and forwards query params", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/permissions/check");
      expect(url.searchParams.get("userId")).toBe("user_alice");
      expect(url.searchParams.get("groupId")).toBe("grp_xyz");
      expect(url.searchParams.get("permission")).toBe("guild.kick");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ allowed: true, source: "role", viaRoleId: "role_officer" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await junjo.check(
      "user_alice" as UserId,
      "grp_xyz" as GroupId,
      "guild.kick" as PermissionKey,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      allowed: true,
      source: "role",
      viaRoleId: "role_officer",
    });
  });

  it("returns viaRoleId only when the server includes it", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ allowed: false, source: "default" }));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await junjo.check(
      "user_alice" as UserId,
      "grp_xyz" as GroupId,
      "guild.kick" as PermissionKey,
    );
    expect(result).toEqual({ allowed: false, source: "default" });
    expect(result.viaRoleId).toBeUndefined();
  });

  it("brands viaRoleId as RoleId on the result", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ allowed: true, source: "role", viaRoleId: "role_xyz" }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await junjo.check(
      "user_alice" as UserId,
      "grp_xyz" as GroupId,
      "guild.kick" as PermissionKey,
    );
    const branded: RoleId | undefined = result.viaRoleId;
    expect(branded).toBe("role_xyz");
  });

  it("throws JunjoError on 404", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.check("user_alice" as UserId, "grp_xyz" as GroupId, "guild.kick" as PermissionKey),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });

  it("throws JunjoError on 400 bad_request", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "bad_request", status: 400, message: "invalid query" }, 400),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.check("" as UserId, "grp_xyz" as GroupId, "guild.kick" as PermissionKey),
    ).rejects.toBeInstanceOf(JunjoError);
  });

  it("URL-encodes query parameters that need escaping", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("userId")).toBe("user/alice");
      expect(url.searchParams.get("groupId")).toBe("grp xyz");
      expect(url.searchParams.get("permission")).toBe("guild.kick&extra");
      expect(req.url).toContain("user%2Falice");
      expect(req.url).toContain("grp+xyz");
      return jsonResponse({ allowed: false, source: "default" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.check(
      "user/alice" as UserId,
      "grp xyz" as GroupId,
      "guild.kick&extra" as PermissionKey,
    );
  });
});

describe("junjo.can", () => {
  it("returns the allowed boolean from check()", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ allowed: true, source: "role", viaRoleId: "role_officer" }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const allowed = await junjo.can(
      "user_alice" as UserId,
      "grp_xyz" as GroupId,
      "guild.kick" as PermissionKey,
    );
    expect(allowed).toBe(true);
  });

  it("returns false when the server denies the check", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ allowed: false, source: "default" }));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const allowed = await junjo.can(
      "user_alice" as UserId,
      "grp_xyz" as GroupId,
      "guild.kick" as PermissionKey,
    );
    expect(allowed).toBe(false);
  });

  it("propagates JunjoError from check()", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.can("user_alice" as UserId, "grp_xyz" as GroupId, "guild.kick" as PermissionKey),
    ).rejects.toBeInstanceOf(JunjoError);
  });
});

describe("junjo.check inherit", () => {
  function client(fetchMock: unknown) {
    return new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as typeof fetch,
      permissionCache: { enabled: false },
    });
  }

  it("omits the inherit param by default", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).searchParams.has("inherit")).toBe(false);
      return jsonResponse({ allowed: false, source: "default" });
    });
    await client(fetchMock).check(
      "user_alice" as UserId,
      "grp_xyz" as GroupId,
      "guild.kick" as PermissionKey,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends inherit=true and surfaces viaGroupId", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).searchParams.get("inherit")).toBe("true");
      return jsonResponse({
        allowed: true,
        source: "role",
        viaRoleId: "role_admin",
        viaGroupId: "grp_parent",
      });
    });
    const result = await client(fetchMock).check(
      "user_alice" as UserId,
      "grp_child" as GroupId,
      "guild.kick" as PermissionKey,
      { inherit: true },
    );
    expect(result).toEqual({
      allowed: true,
      source: "role",
      viaRoleId: "role_admin",
      viaGroupId: "grp_parent",
    });
  });

  it("omits viaGroupId when the server does not send it", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ allowed: false, source: "none" }));
    const result = await client(fetchMock).check(
      "user_alice" as UserId,
      "grp_xyz" as GroupId,
      "guild.kick" as PermissionKey,
      { inherit: true },
    );
    expect(result).not.toHaveProperty("viaGroupId");
  });

  it("passes inherit through can()", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).searchParams.get("inherit")).toBe("true");
      return jsonResponse({ allowed: true, source: "role", viaGroupId: "grp_parent" });
    });
    const allowed = await client(fetchMock).can(
      "user_alice" as UserId,
      "grp_child" as GroupId,
      "guild.kick" as PermissionKey,
      { inherit: true },
    );
    expect(allowed).toBe(true);
  });
});

describe("junjo.checkBatch", () => {
  const CHECKS = [
    {
      userId: "user_alice" as UserId,
      groupId: "grp_a" as GroupId,
      permission: "kick" as PermissionKey,
    },
    {
      userId: "user_bob" as UserId,
      groupId: "grp_b" as GroupId,
      permission: "invite" as PermissionKey,
    },
  ];

  function client(fetchMock: unknown, cache = false) {
    return new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as typeof fetch,
      permissionCache: { enabled: cache },
    });
  }

  it("POSTs one request and returns results positionally", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/permissions/check-batch");
      const body = (await req.json()) as { checks: unknown[]; inherit?: boolean };
      expect(body.checks).toHaveLength(2);
      expect(body.inherit).toBeUndefined();
      return jsonResponse({
        results: [
          { allowed: true, source: "role", viaRoleId: "role_a" },
          { allowed: false, source: "none" },
        ],
      });
    });

    const results = await client(fetchMock).checkBatch(CHECKS);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(results).toEqual([
      { allowed: true, source: "role", viaRoleId: "role_a" },
      { allowed: false, source: "none" },
    ]);
  });

  it("returns an empty array without a request for no checks", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ results: [] }));
    expect(await client(fetchMock).checkBatch([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards inherit", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(((await req.json()) as { inherit?: boolean }).inherit).toBe(true);
      return jsonResponse({ results: [{ allowed: true, source: "role", viaGroupId: "grp_p" }] });
    });
    const first = CHECKS[0];
    if (!first) throw new Error("fixture missing");
    const results = await client(fetchMock).checkBatch([first], { inherit: true });
    expect(results[0]).toMatchObject({ viaGroupId: "grp_p" });
  });

  it("splits inputs longer than the server cap across requests", async () => {
    const checks = Array.from({ length: 250 }, (_, i) => ({
      userId: `user_${i}` as UserId,
      groupId: "grp_a" as GroupId,
      permission: "kick" as PermissionKey,
    }));
    const batchSizes: number[] = [];
    const fetchMock = makeFetch(async (req) => {
      const body = (await req.json()) as { checks: unknown[] };
      batchSizes.push(body.checks.length);
      return jsonResponse({
        results: body.checks.map(() => ({ allowed: true, source: "role" })),
      });
    });

    const results = await client(fetchMock).checkBatch(checks);
    expect(batchSizes).toEqual([100, 100, 50]);
    expect(results).toHaveLength(250);
    expect(results.every((r) => r.allowed)).toBe(true);
  });

  it("throws when the server returns a mismatched result count", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ results: [] }));
    await expect(client(fetchMock).checkBatch(CHECKS)).rejects.toMatchObject({
      code: "invalid_wire_data",
    });
  });

  it("propagates a not_found for an unknown group", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        { code: "not_found", status: 404, message: "group for checks[1] not found" },
        404,
      ),
    );
    await expect(client(fetchMock).checkBatch(CHECKS)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("answers cached entries locally and sends only the rest", async () => {
    let sentBatches = 0;
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/permissions/check") {
        return jsonResponse({ allowed: true, source: "role" });
      }
      sentBatches++;
      const body = (await req.json()) as { checks: unknown[] };
      expect(body.checks).toHaveLength(1);
      return jsonResponse({ results: [{ allowed: false, source: "none" }] });
    });

    const junjo = client(fetchMock, true);
    const first = CHECKS[0];
    if (!first) throw new Error("fixture missing");
    // Warm the cache for the first tuple through the single check.
    await junjo.check(first.userId, first.groupId, first.permission);

    const results = await junjo.checkBatch(CHECKS);
    expect(sentBatches).toBe(1);
    expect(results[0]).toMatchObject({ allowed: true });
    expect(results[1]).toMatchObject({ allowed: false });
  });
});
