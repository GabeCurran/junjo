import type { GameId, GroupId, RoleId, UserId } from "@junjo/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";

interface WireGroupSnapshot {
  id: string;
  gameId: string;
  kind: string;
  name: string;
  visibility: "public" | "invite-only" | "secret";
  metadata: Record<string, unknown>;
  defaultRoleId: string | null;
  parentGroupId: string | null;
  memberCount: number;
  hasPasscode: boolean;
  createdAt: string;
  updatedAt: string;
  softDeletedAt: string | null;
}

const wireFixture: WireGroupSnapshot = {
  id: "grp_1",
  gameId: "game_1",
  kind: "guild",
  name: "Crimson Wolves",
  visibility: "invite-only",
  metadata: {},
  defaultRoleId: null,
  parentGroupId: null,
  memberCount: 0,
  hasPasscode: false,
  createdAt: "2026-04-28T05:00:00.000Z",
  updatedAt: "2026-04-28T05:00:00.000Z",
  softDeletedAt: null,
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

describe("groups.create", () => {
  it("POSTs to /v1/groups with the auth header and JSON body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/groups");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toMatch(/application\/json/);
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ kind: "guild", name: "Crimson Wolves" });
      return jsonResponse(wireFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.create({ kind: "guild", name: "Crimson Wolves" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(group.id).toBe("grp_1");
    expect(group.gameId).toBe("game_1");
    expect(group.kind).toBe("guild");
    expect(group.name).toBe("Crimson Wolves");
    expect(group.visibility).toBe("invite-only");
    expect(group.memberCount).toBe(0);
    expect(group.defaultRoleId).toBeNull();
    expect(group.softDeletedAt).toBeNull();
    expect(group.createdAt).toBeInstanceOf(Date);
    expect(group.updatedAt).toBeInstanceOf(Date);
    expect(group.createdAt.toISOString()).toBe(wireFixture.createdAt);
  });

  it("forwards optional fields verbatim", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({
        kind: "clan",
        name: "Iron Hand",
        visibility: "public",
        metadata: { motto: "Together" },
        defaultRoleId: "role_xyz",
      });
      return jsonResponse(
        {
          ...wireFixture,
          kind: "clan",
          name: "Iron Hand",
          visibility: "public",
          metadata: { motto: "Together" },
          defaultRoleId: "role_xyz",
        },
        201,
      );
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.create({
      kind: "clan",
      name: "Iron Hand",
      visibility: "public",
      metadata: { motto: "Together" },
      defaultRoleId: "role_xyz" as RoleId,
    });

    expect(group.metadata).toEqual({ motto: "Together" });
    expect(group.defaultRoleId).toBe("role_xyz");
  });

  it("forwards creatorUserId verbatim in the request body", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({
        kind: "guild",
        name: "Founders",
        creatorUserId: "user_alice",
      });
      return jsonResponse({ ...wireFixture, name: "Founders" }, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.create({
      kind: "guild",
      name: "Founders",
      creatorUserId: "user_alice" as UserId,
    });
    expect(group.name).toBe("Founders");
  });

  it("throws JunjoError preserving the server's code, status, and message", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "bad_request", status: 400, message: "name: required" }, 400),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(junjo.groups.create({ kind: "guild", name: "" })).rejects.toMatchObject({
      name: "JunjoError",
      code: "bad_request",
      status: 400,
      message: "name: required",
    });
  });

  it("falls back to a generic error when the response body is not JSON", async () => {
    const fetchMock = makeFetch(
      async () => new Response("oops", { status: 502, statusText: "Bad Gateway" }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    let thrown: unknown = null;
    try {
      await junjo.groups.create({ kind: "guild", name: "x" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(JunjoError);
    expect((thrown as JunjoError).code).toBe("internal");
    expect((thrown as JunjoError).status).toBe(502);
  });

  it("strips trailing slashes from baseUrl when building the URL", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.url).toBe("https://example.test/v1/groups");
      return jsonResponse(wireFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "k",
      baseUrl: "https://example.test///",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.groups.create({ kind: "guild", name: "x" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("groups.get", () => {
  it("GETs /v1/groups/:id with the auth header and returns a Group", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_1");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toBeNull();
      return jsonResponse(wireFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.get("grp_1" as GroupId);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(group).not.toBeNull();
    if (!group) throw new Error("expected group");
    expect(group.id).toBe("grp_1");
    expect(group.gameId).toBe("game_1");
    expect(group.createdAt).toBeInstanceOf(Date);
    expect(group.updatedAt).toBeInstanceOf(Date);
    expect(group.softDeletedAt).toBeNull();
  });

  it("returns null on 404 not_found", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.get("grp_missing" as GroupId);
    expect(group).toBeNull();
  });

  it("throws JunjoError on non-404 errors", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "invalid_api_key", status: 401, message: "unknown API key" }, 401),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(junjo.groups.get("grp_1" as GroupId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "invalid_api_key",
      status: 401,
    });
  });

  it("encodes the group id in the URL", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash");
      return jsonResponse(wireFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.get("has/slash" as GroupId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("groups.list", () => {
  it("GETs /v1/groups with no query when no options are provided", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(req.method).toBe("GET");
      expect(url.pathname).toBe("/v1/groups");
      expect(url.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toBeNull();
      return jsonResponse({ items: [wireFixture], nextCursor: null }, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const page = await junjo.groups.list();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    const [first] = page.items;
    if (!first) throw new Error("expected one item");
    expect(first.id).toBe("grp_1");
    expect(first.createdAt).toBeInstanceOf(Date);
  });

  it("forwards limit, cursor, and gameId as query parameters", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups");
      expect(url.searchParams.get("limit")).toBe("25");
      expect(url.searchParams.get("cursor")).toBe("grp_xyz");
      expect(url.searchParams.get("gameId")).toBe("game_1");
      return jsonResponse({ items: [], nextCursor: null }, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.list({
      limit: 25,
      cursor: "grp_xyz",
      gameId: "game_1" as GameId,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns a Page with deserialized items and the server's nextCursor", async () => {
    const second = { ...wireFixture, id: "grp_2", name: "Iron Hand" };
    const fetchMock = makeFetch(async () =>
      jsonResponse({ items: [wireFixture, second], nextCursor: "grp_2" }, 200),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const page = await junjo.groups.list({ limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.items.map((i) => i.id)).toEqual(["grp_1", "grp_2"]);
    expect(page.items[0]?.createdAt).toBeInstanceOf(Date);
    expect(page.nextCursor).toBe("grp_2");
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "bad_request", status: 400, message: "limit: too big" }, 400),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(junjo.groups.list({ limit: 999 })).rejects.toMatchObject({
      name: "JunjoError",
      code: "bad_request",
      status: 400,
    });
  });
});

describe("groups.update", () => {
  it("PATCHes /v1/groups/:id with the auth header and a JSON body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("PATCH");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_1");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toMatch(/application\/json/);
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ name: "Renamed" });
      return jsonResponse({ ...wireFixture, name: "Renamed" }, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.update("grp_1" as GroupId, { name: "Renamed" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(group.name).toBe("Renamed");
    expect(group.createdAt).toBeInstanceOf(Date);
  });

  it("forwards null defaultRoleId verbatim", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ defaultRoleId: null });
      return jsonResponse({ ...wireFixture, defaultRoleId: null }, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.update("grp_1" as GroupId, { defaultRoleId: null });
    expect(group.defaultRoleId).toBeNull();
  });

  it("forwards a multi-field input verbatim and deserializes the result", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({
        name: "Iron Hand",
        visibility: "public",
        metadata: { motto: "Together" },
        defaultRoleId: "role_xyz",
      });
      return jsonResponse(
        {
          ...wireFixture,
          name: "Iron Hand",
          visibility: "public",
          metadata: { motto: "Together" },
          defaultRoleId: "role_xyz",
        },
        200,
      );
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.update("grp_1" as GroupId, {
      name: "Iron Hand",
      visibility: "public",
      metadata: { motto: "Together" },
      defaultRoleId: "role_xyz" as RoleId,
    });
    expect(group.name).toBe("Iron Hand");
    expect(group.visibility).toBe("public");
    expect(group.metadata).toEqual({ motto: "Together" });
    expect(group.defaultRoleId).toBe("role_xyz");
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.update("grp_missing" as GroupId, { name: "x" }),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });

  it("encodes the group id in the URL", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash");
      return jsonResponse(wireFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.update("has/slash" as GroupId, { name: "x" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("groups.delete", () => {
  it("DELETEs /v1/groups/:id with no query when soft-deleting", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(req.method).toBe("DELETE");
      expect(url.pathname).toBe("/v1/groups/grp_1");
      expect(url.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ ...wireFixture, softDeletedAt: "2026-04-28T05:00:00.000Z" }, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await junjo.groups.delete("grp_1" as GroupId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });

  it("appends ?hard=true when opts.hard is true", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups/grp_1");
      expect(url.searchParams.get("hard")).toBe("true");
      return new Response(null, { status: 204 });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.delete("grp_1" as GroupId, { hard: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(junjo.groups.delete("grp_missing" as GroupId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });

  it("encodes the group id in the URL", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash");
      return new Response(null, { status: 204 });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.delete("has/slash" as GroupId, { hard: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("groups.restore", () => {
  it("POSTs /v1/groups/:id/restore and returns the deserialized group", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(req.method).toBe("POST");
      expect(url.pathname).toBe("/v1/groups/grp_1/restore");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toBeNull();
      expect(await req.text()).toBe("");
      return jsonResponse(wireFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.restore("grp_1" as GroupId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(group.id).toBe("grp_1");
    expect(group.softDeletedAt).toBeNull();
    expect(group.createdAt).toBeInstanceOf(Date);
  });

  it("throws JunjoError when the restore window has expired", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        { code: "restore_window_expired", status: 410, message: "restore window expired" },
        410,
      ),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(junjo.groups.restore("grp_old" as GroupId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "restore_window_expired",
      status: 410,
    });
  });

  it("encodes the group id in the URL", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/restore");
      return jsonResponse(wireFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.restore("has/slash" as GroupId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

interface WireInvitationSnapshot {
  id: string;
  groupId: string;
  code: string;
  roleId: string | null;
  targetUserId: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  usedBy: string | null;
}

const inviteFixture: WireInvitationSnapshot = {
  id: "inv_1",
  groupId: "grp_1",
  code: "abcd1234abcd1234",
  roleId: null,
  targetUserId: "user_alice",
  createdBy: null,
  createdAt: "2026-04-28T05:00:00.000Z",
  expiresAt: null,
  usedAt: null,
  usedBy: null,
};

describe("groups.inviteByUserId", () => {
  it("POSTs to /v1/groups/:id/invitations with targetUserId", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_1/invitations");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toMatch(/application\/json/);
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ targetUserId: "user_alice" });
      return jsonResponse(inviteFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const invitation = await junjo.groups.inviteByUserId(
      "grp_1" as GroupId,
      "user_alice" as UserId,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(invitation.id).toBe("inv_1");
    expect(invitation.groupId).toBe("grp_1");
    expect(invitation.code).toBe("abcd1234abcd1234");
    expect(invitation.targetUserId).toBe("user_alice");
    expect(invitation.roleId).toBeNull();
    expect(invitation.createdBy).toBeNull();
    expect(invitation.createdAt).toBeInstanceOf(Date);
    expect(invitation.createdAt.toISOString()).toBe(inviteFixture.createdAt);
    expect(invitation.expiresAt).toBeNull();
    expect(invitation.usedAt).toBeNull();
    expect(invitation.usedBy).toBeNull();
  });

  it("includes roleId in the body when supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ targetUserId: "user_bob", roleId: "role_officer" });
      return jsonResponse(
        { ...inviteFixture, targetUserId: "user_bob", roleId: "role_officer" },
        201,
      );
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const invitation = await junjo.groups.inviteByUserId("grp_1" as GroupId, "user_bob" as UserId, {
      roleId: "role_officer" as RoleId,
    });
    expect(invitation.roleId).toBe("role_officer");
    expect(invitation.targetUserId).toBe("user_bob");
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.inviteByUserId("grp_missing" as GroupId, "user_x" as UserId),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });

  it("encodes the group id in the URL", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/invitations");
      return jsonResponse(inviteFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.inviteByUserId("has/slash" as GroupId, "user_x" as UserId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("deserializes optional timestamp fields when populated", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        {
          ...inviteFixture,
          expiresAt: "2026-05-05T05:00:00.000Z",
          usedAt: "2026-04-29T01:00:00.000Z",
          usedBy: "user_alice",
          createdBy: "user_admin",
          roleId: "role_officer",
        },
        201,
      ),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const invitation = await junjo.groups.inviteByUserId(
      "grp_1" as GroupId,
      "user_alice" as UserId,
    );
    expect(invitation.expiresAt).toBeInstanceOf(Date);
    expect(invitation.expiresAt?.toISOString()).toBe("2026-05-05T05:00:00.000Z");
    expect(invitation.usedAt).toBeInstanceOf(Date);
    expect(invitation.usedBy).toBe("user_alice");
    expect(invitation.createdBy).toBe("user_admin");
    expect(invitation.roleId).toBe("role_officer");
  });
});

describe("groups.inviteByCode", () => {
  const openInviteFixture = { ...inviteFixture, targetUserId: null };

  it("POSTs to /v1/groups/:id/invitations with an empty body when no input is supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_1/invitations");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({});
      return jsonResponse(openInviteFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const invitation = await junjo.groups.inviteByCode("grp_1" as GroupId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(invitation.targetUserId).toBeNull();
    expect(invitation.code).toBe("abcd1234abcd1234");
    expect(invitation.createdAt).toBeInstanceOf(Date);
  });

  it("forwards roleId and expiresIn", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ roleId: "role_recruit", expiresIn: "7d" });
      return jsonResponse(
        {
          ...openInviteFixture,
          roleId: "role_recruit",
          expiresAt: "2026-05-05T05:00:00.000Z",
        },
        201,
      );
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const invitation = await junjo.groups.inviteByCode("grp_1" as GroupId, {
      roleId: "role_recruit" as RoleId,
      expiresIn: "7d",
    });
    expect(invitation.roleId).toBe("role_recruit");
    expect(invitation.expiresAt).toBeInstanceOf(Date);
  });

  it("drops targetUserId from the body even when supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ roleId: "role_recruit" });
      expect(payload.targetUserId).toBeUndefined();
      return jsonResponse({ ...openInviteFixture, roleId: "role_recruit" }, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const invitation = await junjo.groups.inviteByCode("grp_1" as GroupId, {
      targetUserId: "user_x" as UserId,
      roleId: "role_recruit" as RoleId,
    });
    expect(invitation.targetUserId).toBeNull();
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "bad_request", status: 400, message: "expiresIn: bad format" }, 400),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.inviteByCode("grp_1" as GroupId, { expiresIn: "soon" }),
    ).rejects.toMatchObject({ name: "JunjoError", code: "bad_request", status: 400 });
  });

  it("encodes the group id in the URL", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/invitations");
      return jsonResponse(openInviteFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.inviteByCode("has/slash" as GroupId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("groups.inviteByLink", () => {
  const openInviteFixture = { ...inviteFixture, targetUserId: null };

  it("returns the invitation and a URL built from the invite base URL", async () => {
    const fetchMock = makeFetch(async () => jsonResponse(openInviteFixture, 201));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://api.example.test",
      inviteBaseUrl: "https://app.example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await junjo.groups.inviteByLink("grp_1" as GroupId);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.invitation.code).toBe("abcd1234abcd1234");
    expect(result.invitation.targetUserId).toBeNull();
    expect(result.url).toBe("https://app.example.test/invite/abcd1234abcd1234");
  });

  it("falls back to baseUrl when inviteBaseUrl is unset", async () => {
    const fetchMock = makeFetch(async () => jsonResponse(openInviteFixture, 201));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://api.example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const { url } = await junjo.groups.inviteByLink("grp_1" as GroupId);
    expect(url).toBe("https://api.example.test/invite/abcd1234abcd1234");
  });

  it("strips trailing slashes from inviteBaseUrl when building the URL", async () => {
    const fetchMock = makeFetch(async () => jsonResponse(openInviteFixture, 201));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://api.example.test",
      inviteBaseUrl: "https://app.example.test///",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const { url } = await junjo.groups.inviteByLink("grp_1" as GroupId);
    expect(url).toBe("https://app.example.test/invite/abcd1234abcd1234");
  });

  it("URL-encodes the invitation code in the link", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ ...openInviteFixture, code: "weird/code" }, 201),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://api.example.test",
      inviteBaseUrl: "https://app.example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const { url } = await junjo.groups.inviteByLink("grp_1" as GroupId);
    expect(url).toBe("https://app.example.test/invite/weird%2Fcode");
  });

  it("forwards roleId and expiresIn to the underlying request", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ roleId: "role_recruit", expiresIn: "1h" });
      return jsonResponse({ ...openInviteFixture, roleId: "role_recruit" }, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://api.example.test",
      inviteBaseUrl: "https://app.example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const { invitation } = await junjo.groups.inviteByLink("grp_1" as GroupId, {
      roleId: "role_recruit" as RoleId,
      expiresIn: "1h",
    });
    expect(invitation.roleId).toBe("role_recruit");
  });
});

interface WireMemberSnapshot {
  id: string;
  groupId: string;
  userId: string;
  status: string;
  roles: string[];
  metadata: Record<string, unknown>;
  notesPublic: string | null;
  notesPrivate: string | null;
  joinedAt: string;
  bannedUntil: string | null;
}

const memberFixture: WireMemberSnapshot = {
  id: "mem_1",
  groupId: "grp_1",
  userId: "user_alice",
  status: "active",
  roles: [],
  metadata: {},
  notesPublic: null,
  notesPrivate: null,
  joinedAt: "2026-04-28T06:00:00.000Z",
  bannedUntil: null,
};

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe("groups.acceptInvitation", () => {
  it("POSTs /v1/invitations/:code/accept with the userId in the body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/invitations/abcd1234abcd1234/accept");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toMatch(/application\/json/);
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ userId: "user_alice" });
      return jsonResponse(memberFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.groups.acceptInvitation("abcd1234abcd1234", "user_alice" as UserId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(member.id).toBe("mem_1");
    expect(member.groupId).toBe("grp_1");
    expect(member.userId).toBe("user_alice");
    expect(member.status).toBe("active");
    expect(member.roles).toEqual([]);
    expect(member.joinedAt).toBeInstanceOf(Date);
    expect(member.joinedAt.toISOString()).toBe(memberFixture.joinedAt);
  });

  it("URL-encodes the invitation code", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/invitations/weird%2Fcode/accept");
      return jsonResponse(memberFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.acceptInvitation("weird/code", "user_alice" as UserId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws JunjoError on invitation_used (410)", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        { code: "invitation_used", status: 410, message: "invitation already used" },
        410,
      ),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.acceptInvitation("usedcode", "user_alice" as UserId),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "invitation_used",
      status: 410,
    });
  });

  it("throws JunjoError on invitation_expired (410)", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "invitation_expired", status: 410, message: "invitation expired" }, 410),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.acceptInvitation("expiredcode", "user_alice" as UserId),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "invitation_expired",
    });
  });

  it("throws JunjoError on already_member (409)", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        { code: "already_member", status: 409, message: "user is already a member" },
        409,
      ),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.acceptInvitation("seatfilled", "user_alice" as UserId),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "already_member",
      status: 409,
    });
  });

  it("throws JunjoError on permission_denied (403)", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        {
          code: "permission_denied",
          status: 403,
          message: "this invitation is for a different user",
        },
        403,
      ),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.acceptInvitation("directcode", "user_bob" as UserId),
    ).rejects.toMatchObject({ name: "JunjoError", code: "permission_denied" });
  });
});

describe("groups.declineInvitation", () => {
  it("POSTs /v1/invitations/:code/decline with the userId when supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/invitations/abcd1234abcd1234/decline");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ userId: "user_alice" });
      return emptyResponse(204);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await junjo.groups.declineInvitation("abcd1234abcd1234", {
      userId: "user_alice" as UserId,
    });
    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("POSTs an empty body when no userId is supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({});
      return emptyResponse(204);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.declineInvitation("abcd1234abcd1234");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("URL-encodes the invitation code", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/invitations/weird%2Fcode/decline");
      return emptyResponse(204);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.declineInvitation("weird/code");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws JunjoError on invitation_used (410)", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        { code: "invitation_used", status: 410, message: "invitation already used" },
        410,
      ),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(junjo.groups.declineInvitation("usedcode")).rejects.toMatchObject({
      name: "JunjoError",
      code: "invitation_used",
    });
  });

  it("throws JunjoError on permission_denied (403) when the userId does not match a direct invite", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        {
          code: "permission_denied",
          status: 403,
          message: "this invitation is for a different user",
        },
        403,
      ),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.declineInvitation("directcode", { userId: "user_bob" as UserId }),
    ).rejects.toMatchObject({ name: "JunjoError", code: "permission_denied" });
  });
});

describe("groups.leave", () => {
  const leftFixture = { ...memberFixture, status: "left" };

  it("POSTs /v1/groups/:id/leave with the userId in the body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_1/leave");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toMatch(/application\/json/);
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ userId: "user_alice" });
      return jsonResponse(leftFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.groups.leave("grp_1" as GroupId, "user_alice" as UserId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(member.status).toBe("left");
    expect(member.userId).toBe("user_alice");
    expect(member.joinedAt).toBeInstanceOf(Date);
  });

  it("URL-encodes the group id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/leave");
      return jsonResponse(leftFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.leave("has/slash" as GroupId, "user_alice" as UserId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws JunjoError on 404 not_found", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "member not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.leave("grp_1" as GroupId, "user_unknown" as UserId),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });
});

describe("groups.kick", () => {
  const kickedFixture = { ...memberFixture, status: "kicked" };

  it("POSTs /v1/groups/:id/members/:userId/kick with the reason in the body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_1/members/user_alice/kick");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toMatch(/application\/json/);
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ reason: "trolling" });
      return jsonResponse(kickedFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.groups.kick("grp_1" as GroupId, "user_alice" as UserId, {
      reason: "trolling",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(member.status).toBe("kicked");
    expect(member.userId).toBe("user_alice");
    expect(member.joinedAt).toBeInstanceOf(Date);
  });

  it("POSTs an empty body when no reason is supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({});
      return jsonResponse(kickedFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.kick("grp_1" as GroupId, "user_alice" as UserId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("URL-encodes the group id and user id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/members/weird%2Fuser/kick");
      return jsonResponse(kickedFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.kick("has/slash" as GroupId, "weird/user" as UserId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws JunjoError on 404 not_found", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "member not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.kick("grp_1" as GroupId, "user_unknown" as UserId, { reason: "x" }),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });
});

describe("groups.ban / groups.unban", () => {
  const bannedFixture = { ...memberFixture, status: "banned" };
  const leftFixture = { ...memberFixture, status: "left" };

  it("POSTs /v1/groups/:id/members/:userId/ban with reason + expiresAt", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_1/members/user_alice/ban");
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ reason: "trolling", expiresAt: "2026-06-01T00:00:00.000Z" });
      return jsonResponse(bannedFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.groups.ban("grp_1" as GroupId, "user_alice" as UserId, {
      reason: "trolling",
      expiresAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(member.status).toBe("banned");
  });

  it("POSTs an empty body when no opts supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({});
      return jsonResponse(bannedFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.groups.ban("grp_1" as GroupId, "user_alice" as UserId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards an ISO-string expiresAt verbatim (no re-parsing)", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload.expiresAt).toBe("2026-06-01T00:00:00.000Z");
      return jsonResponse(bannedFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.groups.ban("grp_1" as GroupId, "user_alice" as UserId, {
      expiresAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("forwards explicit null expiresAt to clear a prior expiry", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ expiresAt: null });
      return jsonResponse(bannedFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.groups.ban("grp_1" as GroupId, "user_alice" as UserId, { expiresAt: null });
  });

  it("DELETEs /v1/groups/:id/members/:userId/ban for unban", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_1/members/user_alice/ban");
      return jsonResponse(leftFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const member = await junjo.groups.unban("grp_1" as GroupId, "user_alice" as UserId);
    expect(member.status).toBe("left");
  });

  it("URL-encodes the group id and user id on ban", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/members/weird%2Fuser/ban");
      return jsonResponse(bannedFixture, 200);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.groups.ban("has/slash" as GroupId, "weird/user" as UserId);
  });

  it("propagates the server's `banned` error code on enforcement-time 403", async () => {
    // groups.ban itself doesn't 403, but groups.join after a ban does. Cover
    // that round-trip here too -- verifies the SDK preserves the new code
    // unchanged for consumer-side discrimination.
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "banned", status: 403, message: "user is banned from this group" }, 403),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      junjo.groups.join("grp_1" as GroupId, "user_alice" as UserId),
    ).rejects.toMatchObject({ name: "JunjoError", code: "banned", status: 403 });
  });
});

describe("groups.bulkInvite", () => {
  const okBody = { invited: 0, skipped: 0, errors: [] };

  it("POSTs the CSV body verbatim with text/csv content-type", async () => {
    const csv = "user_alice\nuser_bob\n";
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      const u = new URL(req.url);
      expect(u.pathname).toBe("/v1/groups/grp_1/bulk-invite");
      expect(u.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toMatch(/^text\/csv/);
      const text = await req.text();
      expect(text).toBe(csv);
      return jsonResponse({ invited: 2, skipped: 0, errors: [] });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await junjo.groups.bulkInvite("grp_1" as GroupId, csv);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ invited: 2, skipped: 0, errors: [] });
  });

  it("forwards an optional roleId via query string", async () => {
    const fetchMock = makeFetch(async (req) => {
      const u = new URL(req.url);
      expect(u.pathname).toBe("/v1/groups/grp_1/bulk-invite");
      expect(u.searchParams.get("roleId")).toBe("role_recruit");
      return jsonResponse(okBody);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.bulkInvite("grp_1" as GroupId, "user_x\n", {
      roleId: "role_recruit" as RoleId,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not encode the body as JSON", async () => {
    const csv = "user_alice\nuser_bob\n";
    const fetchMock = makeFetch(async (req) => {
      const text = await req.text();
      expect(text).toBe(csv);
      expect(text.startsWith('"')).toBe(false);
      return jsonResponse(okBody);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.bulkInvite("grp_1" as GroupId, csv);
  });

  it("passes a ReadableStream<Uint8Array> body through to fetch unchanged", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("user_alice\n"));
        controller.enqueue(encoder.encode("user_bob\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as ReadableStream<Uint8Array>;
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      const text = new TextDecoder().decode(merged);
      expect(text).toBe("user_alice\nuser_bob\n");
      return jsonResponse(okBody);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.bulkInvite("grp_1" as GroupId, stream);
  });

  it("deserializes the response shape verbatim", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({
        invited: 5,
        skipped: 2,
        errors: [{ row: 7, reason: "userId exceeds 255 characters" }],
      }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await junjo.groups.bulkInvite("grp_1" as GroupId, "user_x\n");
    expect(result.invited).toBe(5);
    expect(result.skipped).toBe(2);
    expect(result.errors).toEqual([{ row: 7, reason: "userId exceeds 255 characters" }]);
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.bulkInvite("grp_missing" as GroupId, "user_x\n"),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });

  it("URL-encodes the group id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/bulk-invite");
      return jsonResponse(okBody);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.bulkInvite("has/slash" as GroupId, "user_x\n");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

const relWireFixture = {
  groupAId: "grp_a",
  groupBId: "grp_b",
  type: "ally",
  since: "2026-04-28T05:00:00.000Z",
  setBy: null,
};

describe("groups.setRelationship", () => {
  it("PUTs to the relationships path with the type body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("PUT");
      const u = new URL(req.url);
      expect(u.pathname).toBe("/v1/groups/grp_a/relationships/grp_b");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ type: "ally" });
      return jsonResponse(relWireFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const rel = await junjo.groups.setRelationship("grp_a" as GroupId, "grp_b" as GroupId, "ally");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(rel.groupAId).toBe("grp_a");
    expect(rel.groupBId).toBe("grp_b");
    expect(rel.type).toBe("ally");
    expect(rel.since).toBeInstanceOf(Date);
    expect(rel.since.toISOString()).toBe(relWireFixture.since);
    expect(rel.setBy).toBeNull();
  });

  it("forwards mutual: true in the body when supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ type: "ally", mutual: true });
      return jsonResponse(relWireFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.setRelationship("grp_a" as GroupId, "grp_b" as GroupId, "ally", {
      mutual: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards mutual: false verbatim when supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ type: "ally", mutual: false });
      return jsonResponse(relWireFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.setRelationship("grp_a" as GroupId, "grp_b" as GroupId, "ally", {
      mutual: false,
    });
  });

  it("URL-encodes both group ids", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/relationships/has%20space");
      return jsonResponse(relWireFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.setRelationship("has/slash" as GroupId, "has space" as GroupId, "ally");
  });

  it("deserializes a relationship with a non-null setBy", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ ...relWireFixture, setBy: "user_alice" }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const rel = await junjo.groups.setRelationship("grp_a" as GroupId, "grp_b" as GroupId, "ally");
    const setBy: UserId | null = rel.setBy;
    expect(setBy).toBe("user_alice");
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "bad_request", status: 400, message: "self-rel" }, 400),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.setRelationship("grp_a" as GroupId, "grp_a" as GroupId, "ally"),
    ).rejects.toMatchObject({ name: "JunjoError", code: "bad_request", status: 400 });
  });
});

describe("groups.clearRelationship", () => {
  it("DELETEs the relationship path with the auth header", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      const u = new URL(req.url);
      expect(u.pathname).toBe("/v1/groups/grp_a/relationships/grp_b");
      expect(u.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return new Response(null, { status: 204 });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.clearRelationship("grp_a" as GroupId, "grp_b" as GroupId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards ?mutual=true when opts.mutual is true", async () => {
    const fetchMock = makeFetch(async (req) => {
      const u = new URL(req.url);
      expect(u.searchParams.get("mutual")).toBe("true");
      return new Response(null, { status: 204 });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.clearRelationship("grp_a" as GroupId, "grp_b" as GroupId, { mutual: true });
  });

  it("URL-encodes both group ids", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/relationships/has%20space");
      return new Response(null, { status: 204 });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.clearRelationship("has/slash" as GroupId, "has space" as GroupId);
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "missing" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.clearRelationship("grp_a" as GroupId, "grp_b" as GroupId),
    ).rejects.toMatchObject({ name: "JunjoError", code: "not_found", status: 404 });
  });
});

describe("groups.getRelationship", () => {
  it("GETs the relationship path and deserializes the wire shape", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_a/relationships/grp_b");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse(relWireFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const rel = await junjo.groups.getRelationship("grp_a" as GroupId, "grp_b" as GroupId);
    expect(rel).not.toBeNull();
    expect(rel?.type).toBe("ally");
    expect(rel?.since).toBeInstanceOf(Date);
  });

  it("returns null on 404 not_found", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "missing" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const rel = await junjo.groups.getRelationship("grp_a" as GroupId, "grp_b" as GroupId);
    expect(rel).toBeNull();
  });

  it("throws on non-404 errors", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "internal", status: 500, message: "boom" }, 500),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.getRelationship("grp_a" as GroupId, "grp_b" as GroupId),
    ).rejects.toMatchObject({ name: "JunjoError", code: "internal" });
  });

  it("URL-encodes both group ids", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/relationships/has%20space");
      return jsonResponse(relWireFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.getRelationship("has/slash" as GroupId, "has space" as GroupId);
  });
});

describe("groups.listRelationships", () => {
  it("GETs the list path and deserializes each row", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_a/relationships");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse([
        relWireFixture,
        { ...relWireFixture, groupBId: "grp_c", type: "enemy" },
      ]);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const list = await junjo.groups.listRelationships("grp_a" as GroupId);
    expect(list).toHaveLength(2);
    expect(list[0]?.groupBId).toBe("grp_b");
    expect(list[0]?.type).toBe("ally");
    expect(list[0]?.since).toBeInstanceOf(Date);
    expect(list[1]?.groupBId).toBe("grp_c");
    expect(list[1]?.type).toBe("enemy");
  });

  it("returns an empty array verbatim", async () => {
    const fetchMock = makeFetch(async () => jsonResponse([]));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const list = await junjo.groups.listRelationships("grp_a" as GroupId);
    expect(list).toEqual([]);
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "missing" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(junjo.groups.listRelationships("grp_missing" as GroupId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });

  it("URL-encodes the group id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/relationships");
      return jsonResponse([]);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.listRelationships("has/slash" as GroupId);
  });
});

describe("groups.setParent", () => {
  it("PUTs to /v1/groups/:id/parent with the auth header and JSON body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("PUT");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_child/parent");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toMatch(/application\/json/);
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ parentGroupId: "grp_parent" });
      return jsonResponse({ ...wireFixture, id: "grp_child", parentGroupId: "grp_parent" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.setParent("grp_child" as GroupId, "grp_parent" as GroupId);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(group.id).toBe("grp_child");
    expect(group.parentGroupId).toBe("grp_parent");
  });

  it("forwards null verbatim when clearing the parent", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ parentGroupId: null });
      return jsonResponse({ ...wireFixture, parentGroupId: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.setParent("grp_child" as GroupId, null);
    expect(group.parentGroupId).toBeNull();
  });

  it("throws JunjoError on 400 parent_cycle", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        { code: "parent_cycle", status: 400, message: "setting this parent would create a cycle" },
        400,
      ),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.setParent("grp_a" as GroupId, "grp_b" as GroupId),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "parent_cycle",
      status: 400,
    });
  });

  it("throws JunjoError on 404 when the parent or child group is missing", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.groups.setParent("grp_a" as GroupId, "grp_missing" as GroupId),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });

  it("URL-encodes the child group id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/parent");
      return jsonResponse({ ...wireFixture, parentGroupId: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.setParent("has/slash" as GroupId, null);
  });

  it("deserializes parentGroupId into the branded GroupId type", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ ...wireFixture, parentGroupId: "grp_parent" }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const group = await junjo.groups.setParent("grp_child" as GroupId, "grp_parent" as GroupId);
    const checked: GroupId | null = group.parentGroupId;
    expect(checked).toBe("grp_parent");
  });
});

describe("groups.listChildren", () => {
  it("GETs the children path and deserializes each row", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp_parent/children");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse([
        { ...wireFixture, id: "grp_child_1", name: "First", parentGroupId: "grp_parent" },
        { ...wireFixture, id: "grp_child_2", name: "Second", parentGroupId: "grp_parent" },
      ]);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const children = await junjo.groups.listChildren("grp_parent" as GroupId);
    expect(children).toHaveLength(2);
    expect(children[0]?.id).toBe("grp_child_1");
    expect(children[0]?.name).toBe("First");
    expect(children[0]?.parentGroupId).toBe("grp_parent");
    expect(children[0]?.createdAt).toBeInstanceOf(Date);
    expect(children[1]?.id).toBe("grp_child_2");
  });

  it("returns an empty array verbatim", async () => {
    const fetchMock = makeFetch(async () => jsonResponse([]));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const children = await junjo.groups.listChildren("grp_parent" as GroupId);
    expect(children).toEqual([]);
  });

  it("throws JunjoError on 404 when the parent group is missing", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(junjo.groups.listChildren("grp_missing" as GroupId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });

  it("URL-encodes the parent group id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/children");
      return jsonResponse([]);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.groups.listChildren("has/slash" as GroupId);
  });
});
