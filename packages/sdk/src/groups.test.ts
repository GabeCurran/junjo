import type { GameId, GroupId, RoleId } from "@junjo/shared";
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
  memberCount: number;
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
  memberCount: 0,
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
