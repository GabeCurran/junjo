import type { RoleId } from "@junjo/shared";
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
