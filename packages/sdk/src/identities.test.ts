import type { UserId } from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";

function makeFetch(handler: (req: Request) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input.clone() : new Request(input.toString(), init);
    return handler(req);
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(fetchMock: ReturnType<typeof makeFetch>): Junjo {
  return new Junjo({
    apiKey: "test_key",
    baseUrl: "https://example.test",
    fetch: fetchMock as unknown as typeof fetch,
  });
}

const gameIdentity = {
  userId: "game:7f3c",
  namespace: "game",
  linkedAt: "2026-11-01T10:00:00.000Z",
};

const webIdentity = {
  userId: "web:alice",
  namespace: "web",
  linkedAt: "2026-11-02T10:00:00.000Z",
};

const bareIdentity = {
  userId: "alice",
  namespace: null,
  linkedAt: "2026-11-03T10:00:00.000Z",
};

describe("client.identities.list", () => {
  it("GETs /v1/users/:userId/identities with the id encoded and unwraps items", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      const u = new URL(req.url);
      expect(u.pathname).toBe("/v1/users/game%3A7f3c/identities");
      expect(u.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ items: [gameIdentity, webIdentity, bareIdentity] });
    });
    const identities = await client(fetchMock).identities.list("game:7f3c" as UserId);
    expect(identities).toHaveLength(3);
    expect(identities[0]).toEqual({
      userId: "game:7f3c",
      namespace: "game",
      linkedAt: new Date("2026-11-01T10:00:00.000Z"),
    });
    expect(identities[1]?.linkedAt).toBeInstanceOf(Date);
    expect(identities[2]?.namespace).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns an empty array for a never-seen id", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ items: [] }));
    const identities = await client(fetchMock).identities.list("game:new" as UserId);
    expect(identities).toEqual([]);
  });

  it("throws JunjoError(invalid_wire_data) naming linkedAt on a malformed timestamp", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ items: [{ ...gameIdentity, linkedAt: "not-a-date" }] }),
    );
    await expect(client(fetchMock).identities.list("game:7f3c" as UserId)).rejects.toMatchObject({
      code: "invalid_wire_data",
      message: expect.stringContaining("linkedAt"),
    });
  });

  it("surfaces invalid_user_id from the server as a JunjoError", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        { code: "invalid_user_id", status: 400, message: "userId: not a valid game id" },
        400,
      ),
    );
    const err = await client(fetchMock)
      .identities.list("game:nope" as UserId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JunjoError);
    expect((err as JunjoError).code).toBe("invalid_user_id");
    expect((err as JunjoError).status).toBe(400);
  });

  it("maps a mid-flight abort to code 'cancelled'", async () => {
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const pending = junjo.identities.list("game:7f3c" as UserId, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "JunjoError", code: "cancelled" });
  });
});

describe("client.identities.requestLinkCode", () => {
  it("POSTs /v1/users/:userId/link-codes with no body and parses expiresAt", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      const u = new URL(req.url);
      expect(u.pathname).toBe("/v1/users/game%3A7f3c/link-codes");
      expect(req.headers.get("content-type")).toBeNull();
      expect(await req.text()).toBe("");
      return jsonResponse({ code: "ABCD-EFGH", expiresAt: "2026-11-05T10:05:00.000Z" }, 201);
    });
    const code = await client(fetchMock).identities.requestLinkCode("game:7f3c" as UserId);
    expect(code.code).toBe("ABCD-EFGH");
    expect(code.expiresAt).toBeInstanceOf(Date);
    expect(code.expiresAt.toISOString()).toBe("2026-11-05T10:05:00.000Z");
  });

  it("surfaces rate_limit_exceeded with retryAfterSeconds from Retry-After", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse(
        { code: "rate_limit_exceeded", status: 429, message: "too many link codes" },
        429,
        { "retry-after": "42" },
      ),
    );
    const err = await client(fetchMock)
      .identities.requestLinkCode("game:7f3c" as UserId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JunjoError);
    expect((err as JunjoError).code).toBe("rate_limit_exceeded");
    expect((err as JunjoError).retryAfterSeconds).toBe(42);
  });

  it("surfaces banned for a banned id", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "banned", status: 403, message: "banned" }, 403),
    );
    await expect(
      client(fetchMock).identities.requestLinkCode("game:7f3c" as UserId),
    ).rejects.toMatchObject({ code: "banned", status: 403 });
  });
});

describe("client.identities.redeemLinkCode", () => {
  it("POSTs /v1/link-codes/redeem with { code, userId } and deserializes the result", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      const u = new URL(req.url);
      expect(u.pathname).toBe("/v1/link-codes/redeem");
      expect(req.headers.get("content-type")).toBe("application/json");
      expect(await req.json()).toEqual({ code: "abcd efgh", userId: "web:alice" });
      return jsonResponse({
        userId: "game:7f3c",
        linkedUserId: "web:alice",
        identities: [gameIdentity, webIdentity],
      });
    });
    const result = await client(fetchMock).identities.redeemLinkCode({
      code: "abcd efgh",
      userId: "web:alice" as UserId,
    });
    expect(result.userId).toBe("game:7f3c");
    expect(result.linkedUserId).toBe("web:alice");
    expect(result.identities.map((i) => i.userId)).toEqual(["game:7f3c", "web:alice"]);
    expect(result.identities[1]?.linkedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["link_code_invalid", 400],
    ["link_refused", 409],
    ["banned", 403],
    ["bad_request", 400],
  ] as const)("surfaces %s (%i) as a JunjoError with that code", async (code, status) => {
    const fetchMock = makeFetch(async () => jsonResponse({ code, status, message: code }, status));
    const err = await client(fetchMock)
      .identities.redeemLinkCode({ code: "ABCD-EFGH", userId: "web:alice" as UserId })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JunjoError);
    expect((err as JunjoError).code).toBe(code);
    expect((err as JunjoError).status).toBe(status);
  });
});

describe("client.identities.unlink", () => {
  it("POSTs /v1/users/:userId/unlink with no body and deserializes the result", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      const u = new URL(req.url);
      expect(u.pathname).toBe("/v1/users/web%3Aalice/unlink");
      expect(await req.text()).toBe("");
      return jsonResponse({
        userId: "game:7f3c",
        unlinkedUserId: "web:alice",
        identities: [gameIdentity],
      });
    });
    const result = await client(fetchMock).identities.unlink("web:alice" as UserId);
    expect(result.userId).toBe("game:7f3c");
    expect(result.unlinkedUserId).toBe("web:alice");
    expect(result.identities).toEqual([
      { userId: "game:7f3c", namespace: "game", linkedAt: new Date(gameIdentity.linkedAt) },
    ]);
  });

  it("surfaces not_found for a never-seen id", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "user not found" }, 404),
    );
    await expect(client(fetchMock).identities.unlink("web:ghost" as UserId)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});
