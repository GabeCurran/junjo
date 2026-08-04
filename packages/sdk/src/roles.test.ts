import type { GroupId, RoleId } from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";

interface WireRoleSnapshot {
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  permissions: string[];
  createdAt: string;
}

const roleFixture: WireRoleSnapshot = {
  id: "role_1",
  groupId: "grp_1",
  name: "Officer",
  priority: 80,
  color: "#ff5050",
  isDefault: false,
  permissions: [],
  createdAt: "2026-04-28T05:00:00.000Z",
};

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

function newClient(fetchMock: ReturnType<typeof makeFetch>): Junjo {
  return new Junjo({
    apiKey: "test_key",
    baseUrl: "https://example.test",
    fetch: fetchMock as unknown as typeof fetch,
  });
}

describe("roles.create", () => {
  it("POSTs /v1/groups/:groupId/roles with the auth header and JSON body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_1/roles");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toMatch(/application\/json/);
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ name: "Officer", priority: 80 });
      return jsonResponse(roleFixture, 201);
    });
    const junjo = newClient(fetchMock);

    const role = await junjo.roles.create("grp_1" as GroupId, { name: "Officer", priority: 80 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(role.id).toBe("role_1");
    expect(role.groupId).toBe("grp_1");
    expect(role.name).toBe("Officer");
    expect(role.priority).toBe(80);
    expect(role.color).toBe("#ff5050");
    expect(role.isDefault).toBe(false);
    expect(role.permissions).toEqual([]);
    expect(role.createdAt).toBeInstanceOf(Date);
    expect(role.createdAt.toISOString()).toBe(roleFixture.createdAt);
  });

  it("forwards optional fields verbatim", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({
        name: "Recruit",
        priority: 10,
        color: "#aabbcc",
        isDefault: true,
      });
      return jsonResponse(
        {
          ...roleFixture,
          name: "Recruit",
          priority: 10,
          color: "#aabbcc",
          isDefault: true,
        },
        201,
      );
    });
    const junjo = newClient(fetchMock);
    const role = await junjo.roles.create("grp_1" as GroupId, {
      name: "Recruit",
      priority: 10,
      color: "#aabbcc",
      isDefault: true,
    });
    expect(role.name).toBe("Recruit");
    expect(role.isDefault).toBe(true);
    expect(role.color).toBe("#aabbcc");
  });

  it("strips permissions from the request body (use grantPermission to populate them)", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ name: "Officer", priority: 80 });
      expect(payload.permissions).toBeUndefined();
      return jsonResponse(roleFixture, 201);
    });
    const junjo = newClient(fetchMock);
    await junjo.roles.create("grp_1" as GroupId, {
      name: "Officer",
      priority: 80,
      permissions: ["invite_member", "kick_member"],
    });
  });

  it("URL-encodes the group id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/roles");
      return jsonResponse(roleFixture, 201);
    });
    const junjo = newClient(fetchMock);
    await junjo.roles.create("has/slash" as GroupId, { name: "Officer", priority: 80 });
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "role_name_taken", status: 409, message: "name taken" }, 409),
    );
    const junjo = newClient(fetchMock);
    await expect(
      junjo.roles.create("grp_1" as GroupId, { name: "Officer", priority: 80 }),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "role_name_taken",
    });
  });
});

describe("roles.get", () => {
  it("GETs /v1/roles/:id and deserializes the wire shape", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/roles/role_1");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse(roleFixture);
    });
    const junjo = newClient(fetchMock);
    const role = await junjo.roles.get("role_1" as RoleId);
    if (!role) throw new Error("expected role");
    expect(role.id).toBe("role_1");
    expect(role.priority).toBe(80);
  });

  it("returns null when the server responds with 404 not_found", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "not found" }, 404),
    );
    const junjo = newClient(fetchMock);
    expect(await junjo.roles.get("role_xyz" as RoleId)).toBeNull();
  });

  it("throws on non-404 errors", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "invalid_api_key", status: 401, message: "" }, 401),
    );
    const junjo = newClient(fetchMock);
    await expect(junjo.roles.get("role_xyz" as RoleId)).rejects.toBeInstanceOf(JunjoError);
  });

  it("URL-encodes the id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/roles/has%2Fslash");
      return jsonResponse(roleFixture);
    });
    const junjo = newClient(fetchMock);
    await junjo.roles.get("has/slash" as RoleId);
  });
});

describe("roles.update", () => {
  it("PATCHes /v1/roles/:id with the partial body and returns the deserialized role", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("PATCH");
      expect(new URL(req.url).pathname).toBe("/v1/roles/role_1");
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ priority: 90 });
      return jsonResponse({ ...roleFixture, priority: 90 });
    });
    const junjo = newClient(fetchMock);
    const role = await junjo.roles.update("role_1" as RoleId, { priority: 90 });
    expect(role.priority).toBe(90);
  });

  it("forwards null verbatim to clear color", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ color: null });
      return jsonResponse({ ...roleFixture, color: null });
    });
    const junjo = newClient(fetchMock);
    const role = await junjo.roles.update("role_1" as RoleId, { color: null });
    expect(role.color).toBeNull();
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "" }, 404),
    );
    const junjo = newClient(fetchMock);
    await expect(
      junjo.roles.update("role_xyz" as RoleId, { name: "Captain" }),
    ).rejects.toBeInstanceOf(JunjoError);
  });

  it("URL-encodes the id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/roles/has%2Fslash");
      return jsonResponse(roleFixture);
    });
    const junjo = newClient(fetchMock);
    await junjo.roles.update("has/slash" as RoleId, { name: "Captain" });
  });
});

describe("roles.delete", () => {
  it("DELETEs /v1/roles/:id and resolves to void on 204", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/v1/roles/role_1");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return new Response(null, { status: 204 });
    });
    const junjo = newClient(fetchMock);
    await expect(junjo.roles.delete("role_1" as RoleId)).resolves.toBeUndefined();
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "role_has_members", status: 409, message: "" }, 409),
    );
    const junjo = newClient(fetchMock);
    await expect(junjo.roles.delete("role_xyz" as RoleId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "role_has_members",
    });
  });

  it("URL-encodes the id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/roles/has%2Fslash");
      return new Response(null, { status: 204 });
    });
    const junjo = newClient(fetchMock);
    await junjo.roles.delete("has/slash" as RoleId);
  });
});

describe("roles.list", () => {
  it("GETs /v1/groups/:groupId/roles and deserializes each item", async () => {
    const second = { ...roleFixture, id: "role_2", name: "Recruit", priority: 10 };
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_1/roles");
      return jsonResponse([roleFixture, second]);
    });
    const junjo = newClient(fetchMock);
    const roles = await junjo.roles.list("grp_1" as GroupId);
    expect(roles).toHaveLength(2);
    expect(roles[0]?.id).toBe("role_1");
    expect(roles[1]?.id).toBe("role_2");
    expect(roles[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("returns an empty array when the group has no roles", async () => {
    const fetchMock = makeFetch(async () => jsonResponse([]));
    const junjo = newClient(fetchMock);
    expect(await junjo.roles.list("grp_1" as GroupId)).toEqual([]);
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "" }, 404),
    );
    const junjo = newClient(fetchMock);
    await expect(junjo.roles.list("grp_xyz" as GroupId)).rejects.toBeInstanceOf(JunjoError);
  });

  it("URL-encodes the group id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/roles");
      return jsonResponse([]);
    });
    const junjo = newClient(fetchMock);
    await junjo.roles.list("has/slash" as GroupId);
  });
});

describe("roles.grantPermission", () => {
  it("POSTs /v1/roles/:id/permissions with the auth header and JSON body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/roles/role_1/permissions");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toMatch(/application\/json/);
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ permission: "invite_member" });
      return jsonResponse({ ...roleFixture, permissions: ["invite_member"] });
    });
    const junjo = newClient(fetchMock);
    const role = await junjo.roles.grantPermission("role_1" as RoleId, "invite_member");
    expect(role.permissions).toEqual(["invite_member"]);
    expect(role.id).toBe("role_1");
    expect(role.createdAt).toBeInstanceOf(Date);
  });

  it("URL-encodes the role id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/roles/has%2Fslash/permissions");
      return jsonResponse(roleFixture);
    });
    const junjo = newClient(fetchMock);
    await junjo.roles.grantPermission("has/slash" as RoleId, "invite_member");
  });

  it("forwards the permission verbatim (no JSON-encoded path traversal)", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ permission: "scope:with-colon" });
      return jsonResponse({ ...roleFixture, permissions: ["scope:with-colon"] });
    });
    const junjo = newClient(fetchMock);
    await junjo.roles.grantPermission("role_1" as RoleId, "scope:with-colon");
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "" }, 404),
    );
    const junjo = newClient(fetchMock);
    await expect(
      junjo.roles.grantPermission("role_xyz" as RoleId, "invite_member"),
    ).rejects.toBeInstanceOf(JunjoError);
  });
});

describe("roles.revokePermission", () => {
  it("DELETEs /v1/roles/:id/permissions/:permission with the auth header", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/v1/roles/role_1/permissions/invite_member");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ ...roleFixture, permissions: [] });
    });
    const junjo = newClient(fetchMock);
    const role = await junjo.roles.revokePermission("role_1" as RoleId, "invite_member");
    expect(role.permissions).toEqual([]);
    expect(role.id).toBe("role_1");
  });

  it("returns the role unchanged when the server reports a no-op", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ ...roleFixture, permissions: ["kick_member"] }),
    );
    const junjo = newClient(fetchMock);
    const role = await junjo.roles.revokePermission("role_1" as RoleId, "never_seen");
    expect(role.permissions).toEqual(["kick_member"]);
  });

  it("URL-encodes the role id and the permission", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe(
        "/v1/roles/has%2Fslash/permissions/scope%2Fwith-slash",
      );
      return jsonResponse(roleFixture);
    });
    const junjo = newClient(fetchMock);
    await junjo.roles.revokePermission("has/slash" as RoleId, "scope/with-slash");
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "" }, 404),
    );
    const junjo = newClient(fetchMock);
    await expect(
      junjo.roles.revokePermission("role_xyz" as RoleId, "invite_member"),
    ).rejects.toBeInstanceOf(JunjoError);
  });
});
