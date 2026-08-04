import type { GroupId, PermissionKey, RoleId, UserId } from "@junjo-io/shared";
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
