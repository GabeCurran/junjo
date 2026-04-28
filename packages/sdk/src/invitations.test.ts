import type { GroupId } from "@junjo/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";

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
  targetUserId: null,
  createdBy: null,
  createdAt: "2026-04-28T05:00:00.000Z",
  expiresAt: null,
  usedAt: null,
  usedBy: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function makeFetch(handler: (req: Request) => Response | Promise<Response>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = url instanceof URL ? url.toString() : (url as string);
    const req = new Request(target, init);
    return handler(req);
  });
}

describe("invitations.list", () => {
  it("GETs /v1/groups/:id/invitations with the auth header and no query when no options are provided", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/groups/grp_1/invitations");
      expect(url.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ items: [inviteFixture], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const page = await junjo.invitations.list("grp_1" as GroupId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.code).toBe("abcd1234abcd1234");
    expect(page.items[0]?.createdAt).toBeInstanceOf(Date);
    expect(page.nextCursor).toBeNull();
  });

  it("forwards limit, cursor, includeExpired, and includeUsed as query parameters", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("cursor")).toBe("inv_99");
      expect(url.searchParams.get("includeExpired")).toBe("true");
      expect(url.searchParams.get("includeUsed")).toBe("false");
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.invitations.list("grp_1" as GroupId, {
      limit: 10,
      cursor: "inv_99",
      includeExpired: true,
      includeUsed: false,
    });
  });

  it("returns a Page with deserialized items and the server's nextCursor", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({
        items: [
          inviteFixture,
          { ...inviteFixture, id: "inv_2", code: "0000111100001111", createdBy: "user_admin" },
        ],
        nextCursor: "inv_2",
      }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const page = await junjo.invitations.list("grp_1" as GroupId);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.id).toBe("inv_1");
    expect(page.items[1]?.id).toBe("inv_2");
    expect(page.items[1]?.createdBy).toBe("user_admin");
    expect(page.nextCursor).toBe("inv_2");
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

    await expect(junjo.invitations.list("grp_x" as GroupId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });

  it("encodes the group id in the URL", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/groups/has%2Fslash/invitations");
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.invitations.list("has/slash" as GroupId);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("invitations.get", () => {
  it("GETs /v1/invitations/:code and returns a deserialized Invitation", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/invitations/abcd1234abcd1234");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse(inviteFixture);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const invitation = await junjo.invitations.get("abcd1234abcd1234");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(invitation?.id).toBe("inv_1");
    expect(invitation?.code).toBe("abcd1234abcd1234");
    expect(invitation?.createdAt).toBeInstanceOf(Date);
  });

  it("returns null on 404 not_found", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "invitation not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const invitation = await junjo.invitations.get("missing");
    expect(invitation).toBeNull();
  });

  it("throws JunjoError on non-404 errors", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "internal", status: 500, message: "boom" }, 500),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(junjo.invitations.get("abcd1234abcd1234")).rejects.toBeInstanceOf(JunjoError);
  });

  it("encodes the code in the URL", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/invitations/weird%2Fcode");
      return jsonResponse({ ...inviteFixture, code: "weird/code" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const invitation = await junjo.invitations.get("weird/code");
    expect(invitation?.code).toBe("weird/code");
  });
});

describe("invitations.revoke", () => {
  it("DELETEs /v1/invitations/:code and resolves to undefined on 204", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/v1/invitations/abcd1234abcd1234");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return emptyResponse(204);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await junjo.invitations.revoke("abcd1234abcd1234");
    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws JunjoError on non-2xx responses", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "invitation not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(junjo.invitations.revoke("abcd1234abcd1234")).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });

  it("encodes the code in the URL", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/invitations/weird%2Fcode");
      return emptyResponse(204);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await junjo.invitations.revoke("weird/code");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
