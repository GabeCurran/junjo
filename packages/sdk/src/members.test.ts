import type { GameId, GroupId, MemberId, UserId } from "@junjo/shared";
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
