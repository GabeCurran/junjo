import type { GroupId } from "@junjo/shared";
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

const wireEntry = {
  id: "audit_1",
  groupId: "grp_1",
  actorUserId: null,
  action: "group.created",
  targetId: "grp_1",
  payload: { kind: "guild", name: "Crimson Wolves" },
  createdAt: "2026-04-28T05:00:00.000Z",
};

describe("audit.list", () => {
  it("GETs /v1/groups/:id/audit with the auth header and no query when no opts supplied", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups/grp_1/audit");
      expect(url.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toBeNull();
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const page = await junjo.audit.list("grp_1" as GroupId);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards limit, before (as ISO 8601), and one query parameter per action", async () => {
    const before = new Date("2026-04-28T06:00:00.000Z");
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups/grp_1/audit");
      expect(url.searchParams.get("limit")).toBe("25");
      expect(url.searchParams.get("before")).toBe(before.toISOString());
      expect(url.searchParams.getAll("actions")).toEqual(["group.created", "group.updated"]);
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.audit.list("grp_1" as GroupId, {
      limit: 25,
      before,
      actions: ["group.created", "group.updated"],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rehydrates createdAt into Date and brand-casts ids", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({
        items: [
          wireEntry,
          {
            ...wireEntry,
            id: "audit_2",
            actorUserId: "user_alice",
            action: "member.invited",
            targetId: "user_bob",
            payload: { invitationId: "inv_1", code: "abc123" },
            createdAt: "2026-04-28T05:01:00.000Z",
          },
        ],
        nextCursor: "2026-04-28T05:00:00.000Z",
      }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const page = await junjo.audit.list("grp_1" as GroupId);
    expect(page.items).toHaveLength(2);
    const [first, second] = page.items;
    expect(first?.id).toBe("audit_1");
    expect(first?.groupId).toBe("grp_1");
    expect(first?.actorUserId).toBeNull();
    expect(first?.action).toBe("group.created");
    expect(first?.targetId).toBe("grp_1");
    expect(first?.payload).toEqual({ kind: "guild", name: "Crimson Wolves" });
    expect(first?.createdAt).toBeInstanceOf(Date);
    expect(first?.createdAt.toISOString()).toBe("2026-04-28T05:00:00.000Z");
    expect(second?.actorUserId).toBe("user_alice");
    expect(second?.targetId).toBe("user_bob");
    expect(second?.action).toBe("member.invited");
    expect(page.nextCursor).toBe("2026-04-28T05:00:00.000Z");
  });

  it("preserves null actorUserId and null targetId on entries", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({
        items: [
          {
            ...wireEntry,
            actorUserId: null,
            targetId: null,
            payload: {},
          },
        ],
        nextCursor: null,
      }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const page = await junjo.audit.list("grp_1" as GroupId);
    expect(page.items[0]?.actorUserId).toBeNull();
    expect(page.items[0]?.targetId).toBeNull();
    expect(page.items[0]?.payload).toEqual({});
  });

  it("URL-encodes the group id (slashes, spaces)", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/grp%2Fwith%20spaces/audit");
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.audit.list("grp/with spaces" as GroupId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws JunjoError on a non-2xx response with the server envelope preserved", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(junjo.audit.list("grp_1" as GroupId)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: "group not found",
    });
    await expect(junjo.audit.list("grp_1" as GroupId)).rejects.toBeInstanceOf(JunjoError);
  });

  it("emits no `before` or `actions` query params when those options are omitted", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.has("before")).toBe(false);
      expect(url.searchParams.has("actions")).toBe(false);
      expect(url.searchParams.get("limit")).toBe("10");
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.audit.list("grp_1" as GroupId, { limit: 10 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("emits an empty `actions` filter as no actions= params (server treats absence as no filter)", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.has("actions")).toBe(false);
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.audit.list("grp_1" as GroupId, { actions: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
