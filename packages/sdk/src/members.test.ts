import type { GameId, GroupId, MemberId, RoleId, UserId } from "@junjo/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";

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
  joinedAt: "2026-04-28T05:00:00.000Z",
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

describe("members.get", () => {
  it("GETs /v1/groups/:id/members/:userId with the auth header and deserializes the wire shape", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups/grp_1/members/user_alice");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse(memberFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.members.get("grp_1" as GroupId, "user_alice" as UserId);
    expect(fetchMock).toHaveBeenCalledOnce();
    if (!member) throw new Error("expected member");
    expect(member.id).toBe("mem_1");
    expect(member.userId).toBe("user_alice");
    expect(member.status).toBe("active");
    expect(member.joinedAt).toBeInstanceOf(Date);
    expect(member.joinedAt.toISOString()).toBe(memberFixture.joinedAt);
  });

  it("returns null when the server responds with 404 not_found", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.members.get("grp_1" as GroupId, "user_alice" as UserId);
    expect(member).toBeNull();
  });

  it("rethrows non-404 errors as JunjoError", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "invalid_api_key", status: 401, message: "no key" }, 401),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      junjo.members.get("grp_1" as GroupId, "user_alice" as UserId),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "invalid_api_key",
      status: 401,
    });
  });

  it("URL-encodes the group id and user id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/members/weird%2Fuser");
      return jsonResponse(memberFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.get("has/slash" as GroupId, "weird/user" as UserId);
  });
});

describe("members.getById", () => {
  it("GETs /v1/members/:id and returns a deserialized Member", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/members/mem_1");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse(memberFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.members.getById("mem_1" as MemberId);
    if (!member) throw new Error("expected member");
    expect(member.id).toBe("mem_1");
    expect(member.joinedAt).toBeInstanceOf(Date);
  });

  it("returns null on 404 not_found", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const member = await junjo.members.getById("missing" as MemberId);
    expect(member).toBeNull();
  });

  it("URL-encodes the id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/members/has%2Fslash");
      return jsonResponse(memberFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.getById("has/slash" as MemberId);
  });
});

describe("members.list", () => {
  it("GETs /v1/groups/:id/members with no query when no options are provided", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups/grp_1/members");
      expect(url.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ items: [memberFixture], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const page = await junjo.members.list("grp_1" as GroupId);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("mem_1");
    expect(page.items[0]?.joinedAt).toBeInstanceOf(Date);
    expect(page.nextCursor).toBeNull();
  });

  it("forwards limit and cursor as query parameters", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("cursor")).toBe("mem_99");
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.list("grp_1" as GroupId, { limit: 10, cursor: "mem_99" });
  });

  it("propagates nextCursor and deserializes the page", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ items: [memberFixture], nextCursor: "mem_2" }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const page = await junjo.members.list("grp_1" as GroupId);
    expect(page.nextCursor).toBe("mem_2");
    expect(page.items[0]?.joinedAt).toBeInstanceOf(Date);
  });

  it("throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "no group" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(junjo.members.list("grp_x" as GroupId)).rejects.toBeInstanceOf(JunjoError);
  });

  it("URL-encodes the group id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/members");
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.list("has/slash" as GroupId);
  });
});

describe("members.listForUser", () => {
  it("GETs /v1/users/:userId/members and returns a Member[]", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/users/user_alice/members");
      expect(url.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse([memberFixture]);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const members = await junjo.members.listForUser("user_alice" as UserId);
    expect(members).toHaveLength(1);
    expect(members[0]?.id).toBe("mem_1");
    expect(members[0]?.joinedAt).toBeInstanceOf(Date);
  });

  it("forwards gameId as a query parameter when supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("gameId")).toBe("game_1");
      return jsonResponse([]);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.listForUser("user_alice" as UserId, { gameId: "game_1" as GameId });
  });

  it("returns an empty array verbatim", async () => {
    const fetchMock = makeFetch(async () => jsonResponse([]));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const members = await junjo.members.listForUser("user_unknown" as UserId);
    expect(members).toEqual([]);
  });

  it("throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "bad_request", status: 400, message: "wrong gameId" }, 400),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      junjo.members.listForUser("user_alice" as UserId, { gameId: "game_x" as GameId }),
    ).rejects.toBeInstanceOf(JunjoError);
  });

  it("URL-encodes the userId path parameter", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/users/weird%2Fuser/members");
      return jsonResponse([]);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.listForUser("weird/user" as UserId);
  });
});

describe("members.setMetadata", () => {
  it("PATCHes /v1/groups/:id/members/:userId with the metadata body and auth header", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("PATCH");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups/grp_1/members/user_alice");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toBe("application/json");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ metadata: { rank: "officer" } });
      return jsonResponse({
        ...memberFixture,
        metadata: { rank: "officer" },
      });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.members.setMetadata("grp_1" as GroupId, "user_alice" as UserId, {
      rank: "officer",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(member.metadata).toEqual({ rank: "officer" });
    expect(member.joinedAt).toBeInstanceOf(Date);
  });

  it("sends an empty metadata object verbatim", async () => {
    const fetchMock = makeFetch(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ metadata: {} });
      return jsonResponse({ ...memberFixture, metadata: {} });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.setMetadata("grp_1" as GroupId, "user_alice" as UserId, {});
  });

  it("throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "no member" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      junjo.members.setMetadata("grp_1" as GroupId, "user_alice" as UserId, { x: 1 }),
    ).rejects.toMatchObject({ name: "JunjoError", code: "not_found" });
  });

  it("URL-encodes the group id and user id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/members/weird%2Fuser");
      return jsonResponse(memberFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.setMetadata("has/slash" as GroupId, "weird/user" as UserId, {});
  });
});

describe("members.setNotes", () => {
  it("PATCHes /v1/groups/:id/members/:userId with notesPublic alone", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("PATCH");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups/grp_1/members/user_alice");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ notesPublic: "great healer" });
      return jsonResponse({ ...memberFixture, notesPublic: "great healer" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.members.setNotes("grp_1" as GroupId, "user_alice" as UserId, {
      notesPublic: "great healer",
    });
    expect(member.notesPublic).toBe("great healer");
    expect(member.notesPrivate).toBeNull();
  });

  it("PATCHes both notes fields when both are supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ notesPublic: "pub", notesPrivate: "priv" });
      return jsonResponse({ ...memberFixture, notesPublic: "pub", notesPrivate: "priv" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.members.setNotes("grp_1" as GroupId, "user_alice" as UserId, {
      notesPublic: "pub",
      notesPrivate: "priv",
    });
  });

  it("sends notesPublic: null verbatim to clear it", async () => {
    const fetchMock = makeFetch(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ notesPublic: null });
      return jsonResponse({ ...memberFixture, notesPublic: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.members.setNotes("grp_1" as GroupId, "user_alice" as UserId, {
      notesPublic: null,
    });
  });

  it("omits undefined fields from the body", async () => {
    const fetchMock = makeFetch(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ notesPrivate: "x" });
      expect("notesPublic" in body).toBe(false);
      return jsonResponse({ ...memberFixture, notesPrivate: "x" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.members.setNotes("grp_1" as GroupId, "user_alice" as UserId, {
      notesPrivate: "x",
    });
  });

  it("throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "bad_request", status: 400, message: "too long" }, 400),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      junjo.members.setNotes("grp_1" as GroupId, "user_alice" as UserId, { notesPublic: "x" }),
    ).rejects.toBeInstanceOf(JunjoError);
  });

  it("URL-encodes the group id and user id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/members/weird%2Fuser");
      return jsonResponse(memberFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.setNotes("has/slash" as GroupId, "weird/user" as UserId, {
      notesPublic: "x",
    });
  });
});

describe("members.assignRole", () => {
  it("POSTs /v1/groups/:groupId/members/:userId/roles/:roleId with the auth header and no body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups/grp_1/members/user_alice/roles/role_1");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toBeNull();
      const text = await req.text();
      expect(text).toBe("");
      return jsonResponse({ ...memberFixture, roles: ["role_1"] });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.members.assignRole(
      "grp_1" as GroupId,
      "user_alice" as UserId,
      "role_1" as RoleId,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(member.roles).toEqual(["role_1"]);
    expect(member.joinedAt).toBeInstanceOf(Date);
  });

  it("throws JunjoError on role_group_mismatch (400)", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "role_group_mismatch", status: 400, message: "wrong group" }, 400),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      junjo.members.assignRole("grp_1" as GroupId, "user_alice" as UserId, "role_2" as RoleId),
    ).rejects.toMatchObject({
      name: "JunjoError",
      code: "role_group_mismatch",
      status: 400,
    });
  });

  it("throws JunjoError on 404", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "no role" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      junjo.members.assignRole("grp_1" as GroupId, "user_alice" as UserId, "ghost" as RoleId),
    ).rejects.toBeInstanceOf(JunjoError);
  });

  it("URL-encodes group id, user id, and role id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe(
        "/v1/groups/has%2Fslash/members/weird%2Fuser/roles/role%2Fa",
      );
      return jsonResponse(memberFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.assignRole(
      "has/slash" as GroupId,
      "weird/user" as UserId,
      "role/a" as RoleId,
    );
  });
});

describe("members.removeRole", () => {
  it("DELETEs /v1/groups/:groupId/members/:userId/roles/:roleId with the auth header", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups/grp_1/members/user_alice/roles/role_1");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ ...memberFixture, roles: [] });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const member = await junjo.members.removeRole(
      "grp_1" as GroupId,
      "user_alice" as UserId,
      "role_1" as RoleId,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(member.roles).toEqual([]);
    expect(member.joinedAt).toBeInstanceOf(Date);
  });

  it("returns the member when the server reports a no-op (still 200)", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ ...memberFixture, roles: [] }));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const member = await junjo.members.removeRole(
      "grp_1" as GroupId,
      "user_alice" as UserId,
      "role_x" as RoleId,
    );
    expect(member.roles).toEqual([]);
  });

  it("throws JunjoError on 404", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "no member" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      junjo.members.removeRole("grp_1" as GroupId, "user_alice" as UserId, "role_1" as RoleId),
    ).rejects.toBeInstanceOf(JunjoError);
  });

  it("URL-encodes group id, user id, and role id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe(
        "/v1/groups/has%2Fslash/members/weird%2Fuser/roles/role%2Fa",
      );
      return jsonResponse(memberFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.members.removeRole(
      "has/slash" as GroupId,
      "weird/user" as UserId,
      "role/a" as RoleId,
    );
  });
});
