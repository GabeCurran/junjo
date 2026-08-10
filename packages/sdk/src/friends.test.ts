import type { UserId } from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";

interface WireFriendRequestSnapshot {
  id: string;
  gameId: string;
  actorJunjoUserId: string;
  targetJunjoUserId: string;
  createdAt: string;
}

interface WireFriendshipSnapshot {
  id: string;
  gameId: string;
  junjoUserId: string;
  since: string;
}

const requestFixture: WireFriendRequestSnapshot = {
  id: "rel_req1",
  gameId: "game_1",
  actorJunjoUserId: "user_alice",
  targetJunjoUserId: "user_bob",
  createdAt: "2026-05-01T12:00:00.000Z",
};

const friendshipFixture: WireFriendshipSnapshot = {
  id: "rel_fr1",
  gameId: "game_1",
  junjoUserId: "user_bob",
  since: "2026-05-02T08:30:00.000Z",
};

const blockFixture = {
  id: "rel_blk1",
  gameId: "game_1",
  junjoUserId: "user_mallory",
  blockedAt: "2026-05-03T00:00:00.000Z",
};

const tagFixture = {
  id: "ftag_1",
  gameId: "game_1",
  junjoUserId: "user_alice",
  name: "guildmates",
  color: "#ff0000",
  createdAt: "2026-05-04T10:00:00.000Z",
};

const visibilityFixture = {
  gameId: "game_1",
  junjoUserId: "user_alice",
  friendsListVisibility: "friends-only",
  allowed: ["private", "friends-only", "public"],
  updatedAt: "2026-05-05T09:00:00.000Z",
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

function makeClient(fetchMock: ReturnType<typeof makeFetch>): Junjo {
  return new Junjo({
    apiKey: "test_key",
    baseUrl: "https://example.test",
    fetch: fetchMock as unknown as typeof fetch,
  });
}

describe("friends.requests.list", () => {
  it("GETs /v1/users/:id/friend-requests with no query and deserializes both directions", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/users/user_alice/friend-requests");
      expect(url.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({
        inbound: [requestFixture],
        outbound: [{ ...requestFixture, id: "rel_req2" }],
      });
    });
    const junjo = makeClient(fetchMock);

    const result = await junjo.friends.requests.list("user_alice" as UserId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.inbound).toHaveLength(1);
    expect(result.inbound[0]?.id).toBe("rel_req1");
    expect(result.inbound[0]?.createdAt).toBeInstanceOf(Date);
    expect(result.inbound[0]?.createdAt.toISOString()).toBe(requestFixture.createdAt);
    expect(result.outbound[0]?.id).toBe("rel_req2");
    expect(result.outbound[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("forwards the direction option as a query parameter", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/users/user_alice/friend-requests");
      expect(url.searchParams.get("direction")).toBe("in");
      return jsonResponse({ inbound: [requestFixture], outbound: [] });
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.requests.list("user_alice" as UserId, { direction: "in" });
  });

  it("URL-encodes the user id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/users/weird%2Fuser/friend-requests");
      return jsonResponse({ inbound: [], outbound: [] });
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.requests.list("weird/user" as UserId);
  });

  it("throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "no user" }, 404),
    );
    const junjo = makeClient(fetchMock);
    await expect(junjo.friends.requests.list("user_x" as UserId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
    });
  });
});

describe("friends.requests.send", () => {
  it("POSTs the target user id and deserializes a pending result", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/users/user_alice/friend-requests");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toBe("application/json");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ targetJunjoUserId: "user_bob" });
      return jsonResponse({ status: "pending", request: requestFixture });
    });
    const junjo = makeClient(fetchMock);

    const result = await junjo.friends.requests.send("user_alice" as UserId, "user_bob" as UserId);
    expect(result.status).toBe("pending");
    if (!result.request) throw new Error("expected request");
    expect(result.request.id).toBe("rel_req1");
    expect(result.request.createdAt).toBeInstanceOf(Date);
    expect(result.friendship).toBeUndefined();
  });

  it("deserializes an auto-accepted result carrying the friendship", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ status: "auto-accepted", friendship: friendshipFixture }),
    );
    const junjo = makeClient(fetchMock);

    const result = await junjo.friends.requests.send("user_alice" as UserId, "user_bob" as UserId);
    expect(result.status).toBe("auto-accepted");
    expect(result.request).toBeUndefined();
    if (!result.friendship) throw new Error("expected friendship");
    expect(result.friendship.id).toBe("rel_fr1");
    expect(result.friendship.since).toBeInstanceOf(Date);
    expect(result.friendship.since.toISOString()).toBe(friendshipFixture.since);
  });

  it("throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "banned", status: 403, message: "blocked" }, 403),
    );
    const junjo = makeClient(fetchMock);
    await expect(
      junjo.friends.requests.send("user_alice" as UserId, "user_mallory" as UserId),
    ).rejects.toBeInstanceOf(JunjoError);
  });
});

describe("friends.requests.accept", () => {
  it("POSTs /v1/friend-requests/:id/accept with no body and returns the Friendship", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/friend-requests/rel_req1/accept");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toBeNull();
      expect(await req.text()).toBe("");
      return jsonResponse(friendshipFixture);
    });
    const junjo = makeClient(fetchMock);

    const friendship = await junjo.friends.requests.accept("rel_req1");
    expect(friendship.id).toBe("rel_fr1");
    expect(friendship.junjoUserId).toBe("user_bob");
    expect(friendship.since).toBeInstanceOf(Date);
  });

  it("URL-encodes the request id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/friend-requests/has%2Fslash/accept");
      return jsonResponse(friendshipFixture);
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.requests.accept("has/slash");
  });

  it("throws JunjoError on 404", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "no request" }, 404),
    );
    const junjo = makeClient(fetchMock);
    await expect(junjo.friends.requests.accept("ghost")).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
    });
  });
});

describe("friends.requests.decline", () => {
  it("POSTs /v1/friend-requests/:id/decline and resolves void", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/friend-requests/rel_req1/decline");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return new Response(null, { status: 204 });
    });
    const junjo = makeClient(fetchMock);

    await expect(junjo.friends.requests.decline("rel_req1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "no request" }, 404),
    );
    const junjo = makeClient(fetchMock);
    await expect(junjo.friends.requests.decline("ghost")).rejects.toBeInstanceOf(JunjoError);
  });
});

describe("friends.requests.cancel", () => {
  it("DELETEs /v1/friend-requests/:id and resolves void", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/v1/friend-requests/rel_req1");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return new Response(null, { status: 204 });
    });
    const junjo = makeClient(fetchMock);

    await expect(junjo.friends.requests.cancel("rel_req1")).resolves.toBeUndefined();
  });

  it("URL-encodes the request id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/friend-requests/has%2Fslash");
      return new Response(null, { status: 204 });
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.requests.cancel("has/slash");
  });
});

describe("friends.list", () => {
  it("GETs /v1/users/:id/friends with no query and deserializes the page", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/users/user_alice/friends");
      expect(url.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ items: [friendshipFixture], nextCursor: "rel_fr1" });
    });
    const junjo = makeClient(fetchMock);

    const page = await junjo.friends.list("user_alice" as UserId);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("rel_fr1");
    expect(page.items[0]?.since).toBeInstanceOf(Date);
    expect(page.items[0]?.since.toISOString()).toBe(friendshipFixture.since);
    expect(page.nextCursor).toBe("rel_fr1");
  });

  it("forwards limit, cursor, tagId, and viewer as query parameters", async () => {
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("limit")).toBe("25");
      expect(url.searchParams.get("cursor")).toBe("rel_fr0");
      expect(url.searchParams.get("tagId")).toBe("ftag_1");
      expect(url.searchParams.get("viewer")).toBe("user_carol");
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.list("user_alice" as UserId, {
      limit: 25,
      cursor: "rel_fr0",
      tagId: "ftag_1",
      viewer: "user_carol" as UserId,
    });
  });

  it("URL-encodes the user id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/users/weird%2Fuser/friends");
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.list("weird/user" as UserId);
  });

  it("throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "permission_denied", status: 403, message: "private list" }, 403),
    );
    const junjo = makeClient(fetchMock);
    await expect(junjo.friends.list("user_alice" as UserId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "permission_denied",
      status: 403,
    });
  });

  it("throws JunjoError code invalid_wire_data when a 2xx body is not valid JSON", async () => {
    const fetchMock = makeFetch(
      async () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const junjo = makeClient(fetchMock);
    await expect(junjo.friends.list("user_alice" as UserId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "invalid_wire_data",
      status: 200,
    });
  });
});

describe("friends.remove", () => {
  it("DELETEs /v1/users/:id/friends/:otherId and resolves void", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/v1/users/user_alice/friends/user_bob");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return new Response(null, { status: 204 });
    });
    const junjo = makeClient(fetchMock);

    await expect(
      junjo.friends.remove("user_alice" as UserId, "user_bob" as UserId),
    ).resolves.toBeUndefined();
  });

  it("URL-encodes both user ids", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/users/weird%2Fuser/friends/other%2Fuser");
      return new Response(null, { status: 204 });
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.remove("weird/user" as UserId, "other/user" as UserId);
  });

  it("throws JunjoError on 404", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "not friends" }, 404),
    );
    const junjo = makeClient(fetchMock);
    await expect(
      junjo.friends.remove("user_alice" as UserId, "user_bob" as UserId),
    ).rejects.toBeInstanceOf(JunjoError);
  });
});

describe("friends.getRelationship", () => {
  it("GETs /v1/users/:viewer/friends/:other/relationship and parses since as a Date", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/users/user_alice/friends/user_bob/relationship");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ state: "friends", since: "2026-05-02T08:30:00.000Z" });
    });
    const junjo = makeClient(fetchMock);

    const rel = await junjo.friends.getRelationship("user_alice" as UserId, "user_bob" as UserId);
    expect(rel.state).toBe("friends");
    expect(rel.since).toBeInstanceOf(Date);
    expect(rel.since?.toISOString()).toBe("2026-05-02T08:30:00.000Z");
  });

  it("maps a null since to undefined", async () => {
    const fetchMock = makeFetch(async () => jsonResponse({ state: "none", since: null }));
    const junjo = makeClient(fetchMock);

    const rel = await junjo.friends.getRelationship("user_alice" as UserId, "user_bob" as UserId);
    expect(rel.state).toBe("none");
    expect(rel.since).toBeUndefined();
  });

  it("URL-encodes both user ids", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe(
        "/v1/users/weird%2Fuser/friends/other%2Fuser/relationship",
      );
      return jsonResponse({ state: "none", since: null });
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.getRelationship("weird/user" as UserId, "other/user" as UserId);
  });

  it("throws JunjoError code invalid_wire_data on an invalid since timestamp", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ state: "friends", since: "not-a-date" }),
    );
    const junjo = makeClient(fetchMock);
    await expect(
      junjo.friends.getRelationship("user_alice" as UserId, "user_bob" as UserId),
    ).rejects.toMatchObject({ name: "JunjoError", code: "invalid_wire_data" });
  });
});

describe("friends.suggestions", () => {
  it("GETs /v1/users/:id/friends/suggestions and returns the items verbatim", async () => {
    const suggestion = {
      junjoUserId: "user_dave",
      mutualCount: 3,
      sampleMutualJunjoUserIds: ["user_bob", "user_carol"],
    };
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/users/user_alice/friends/suggestions");
      expect(url.search).toBe("");
      return jsonResponse({ items: [suggestion] });
    });
    const junjo = makeClient(fetchMock);

    const suggestions = await junjo.friends.suggestions("user_alice" as UserId);
    expect(suggestions).toEqual([suggestion]);
  });

  it("forwards limit as a query parameter", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).searchParams.get("limit")).toBe("5");
      return jsonResponse({ items: [] });
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.suggestions("user_alice" as UserId, { limit: 5 });
  });

  it("throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "permission_denied", status: 403, message: "discovery disabled" }, 403),
    );
    const junjo = makeClient(fetchMock);
    await expect(junjo.friends.suggestions("user_alice" as UserId)).rejects.toBeInstanceOf(
      JunjoError,
    );
  });
});

describe("friends.blocks", () => {
  it("list GETs /v1/users/:id/blocks and deserializes blockedAt", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/users/user_alice/blocks");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ items: [blockFixture] });
    });
    const junjo = makeClient(fetchMock);

    const blocks = await junjo.friends.blocks.list("user_alice" as UserId);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe("rel_blk1");
    expect(blocks[0]?.junjoUserId).toBe("user_mallory");
    expect(blocks[0]?.blockedAt).toBeInstanceOf(Date);
    expect(blocks[0]?.blockedAt.toISOString()).toBe(blockFixture.blockedAt);
  });

  it("add POSTs the target user id and returns the Block", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/users/user_alice/blocks");
      expect(req.headers.get("content-type")).toBe("application/json");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ targetJunjoUserId: "user_mallory" });
      return jsonResponse(blockFixture);
    });
    const junjo = makeClient(fetchMock);

    const block = await junjo.friends.blocks.add("user_alice" as UserId, "user_mallory" as UserId);
    expect(block.id).toBe("rel_blk1");
    expect(block.blockedAt).toBeInstanceOf(Date);
  });

  it("remove DELETEs /v1/users/:id/blocks/:otherId and resolves void", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/v1/users/user_alice/blocks/user_mallory");
      return new Response(null, { status: 204 });
    });
    const junjo = makeClient(fetchMock);

    await expect(
      junjo.friends.blocks.remove("user_alice" as UserId, "user_mallory" as UserId),
    ).resolves.toBeUndefined();
  });

  it("remove URL-encodes both user ids", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/users/weird%2Fuser/blocks/other%2Fuser");
      return new Response(null, { status: 204 });
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.blocks.remove("weird/user" as UserId, "other/user" as UserId);
  });

  it("list throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "no user" }, 404),
    );
    const junjo = makeClient(fetchMock);
    await expect(junjo.friends.blocks.list("user_x" as UserId)).rejects.toBeInstanceOf(JunjoError);
  });
});

describe("friends.tags", () => {
  it("list GETs /v1/users/:id/friend-tags and deserializes createdAt", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/users/user_alice/friend-tags");
      return jsonResponse({ items: [tagFixture] });
    });
    const junjo = makeClient(fetchMock);

    const tags = await junjo.friends.tags.list("user_alice" as UserId);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.id).toBe("ftag_1");
    expect(tags[0]?.name).toBe("guildmates");
    expect(tags[0]?.color).toBe("#ff0000");
    expect(tags[0]?.createdAt).toBeInstanceOf(Date);
    expect(tags[0]?.createdAt.toISOString()).toBe(tagFixture.createdAt);
  });

  it("create POSTs the tag input verbatim", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/users/user_alice/friend-tags");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ name: "guildmates", color: "#ff0000" });
      return jsonResponse(tagFixture);
    });
    const junjo = makeClient(fetchMock);

    const tag = await junjo.friends.tags.create("user_alice" as UserId, {
      name: "guildmates",
      color: "#ff0000",
    });
    expect(tag.id).toBe("ftag_1");
    expect(tag.createdAt).toBeInstanceOf(Date);
  });

  it("update PATCHes /v1/friend-tags/:tagId with the patch body", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("PATCH");
      expect(new URL(req.url).pathname).toBe("/v1/friend-tags/ftag_1");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ name: "raid team", color: null });
      return jsonResponse({ ...tagFixture, name: "raid team", color: null });
    });
    const junjo = makeClient(fetchMock);

    const tag = await junjo.friends.tags.update("ftag_1", { name: "raid team", color: null });
    expect(tag.name).toBe("raid team");
    expect(tag.color).toBeNull();
  });

  it("delete DELETEs /v1/friend-tags/:tagId and URL-encodes the id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/v1/friend-tags/has%2Fslash");
      return new Response(null, { status: 204 });
    });
    const junjo = makeClient(fetchMock);

    await expect(junjo.friends.tags.delete("has/slash")).resolves.toBeUndefined();
  });

  it("assign PUTs the tag id list and returns the assignment verbatim", async () => {
    const assignment = { friendJunjoUserId: "user_bob", tagIds: ["ftag_1", "ftag_2"] };
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("PUT");
      expect(new URL(req.url).pathname).toBe("/v1/users/user_alice/friends/user_bob/tags");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ tagIds: ["ftag_1", "ftag_2"] });
      return jsonResponse(assignment);
    });
    const junjo = makeClient(fetchMock);

    const result = await junjo.friends.tags.assign("user_alice" as UserId, "user_bob" as UserId, [
      "ftag_1",
      "ftag_2",
    ]);
    expect(result).toEqual(assignment);
  });

  it("assign URL-encodes both user ids", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/users/weird%2Fuser/friends/other%2Fuser/tags");
      return jsonResponse({ friendJunjoUserId: "other/user", tagIds: [] });
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.tags.assign("weird/user" as UserId, "other/user" as UserId, []);
  });

  it("create throws JunjoError on a non-2xx response", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "bad_request", status: 400, message: "too many tags" }, 400),
    );
    const junjo = makeClient(fetchMock);
    await expect(
      junjo.friends.tags.create("user_alice" as UserId, { name: "x" }),
    ).rejects.toMatchObject({ name: "JunjoError", code: "bad_request", status: 400 });
  });
});

describe("friends.visibility", () => {
  it("get GETs /v1/users/:id/visibility and deserializes updatedAt as a Date", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v1/users/user_alice/visibility");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse(visibilityFixture);
    });
    const junjo = makeClient(fetchMock);

    const settings = await junjo.friends.visibility.get("user_alice" as UserId);
    expect(settings.friendsListVisibility).toBe("friends-only");
    expect(settings.allowed).toEqual(["private", "friends-only", "public"]);
    expect(settings.updatedAt).toBeInstanceOf(Date);
    expect(settings.updatedAt?.toISOString()).toBe(visibilityFixture.updatedAt);
  });

  it("get keeps a null updatedAt as null", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ ...visibilityFixture, updatedAt: null }),
    );
    const junjo = makeClient(fetchMock);

    const settings = await junjo.friends.visibility.get("user_alice" as UserId);
    expect(settings.updatedAt).toBeNull();
  });

  it("set PATCHes the new visibility value and returns the updated settings", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("PATCH");
      expect(new URL(req.url).pathname).toBe("/v1/users/user_alice/visibility");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ friendsListVisibility: "public" });
      return jsonResponse({ ...visibilityFixture, friendsListVisibility: "public" });
    });
    const junjo = makeClient(fetchMock);

    const settings = await junjo.friends.visibility.set("user_alice" as UserId, "public");
    expect(settings.friendsListVisibility).toBe("public");
  });

  it("set URL-encodes the user id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/users/weird%2Fuser/visibility");
      return jsonResponse(visibilityFixture);
    });
    const junjo = makeClient(fetchMock);
    await junjo.friends.visibility.set("weird/user" as UserId, "private");
  });

  it("set throws JunjoError when the value is not allowed", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "bad_request", status: 400, message: "not in allowlist" }, 400),
    );
    const junjo = makeClient(fetchMock);
    await expect(
      junjo.friends.visibility.set("user_alice" as UserId, "public"),
    ).rejects.toMatchObject({ name: "JunjoError", code: "bad_request" });
  });
});

describe("friends cancellation via AbortSignal", () => {
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
    const pending = junjo.friends.list("user_alice" as UserId, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "JunjoError", code: "cancelled" });
  });
});

describe("friends.listAll", () => {
  it("walks every page, feeding nextCursor back as cursor and forwarding filters", async () => {
    const seenCursors: Array<string | null> = [];
    const fetchMock = makeFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/users/user_alice/friends");
      expect(url.searchParams.get("limit")).toBe("2");
      expect(url.searchParams.get("tagId")).toBe("ftag_1");
      expect(url.searchParams.get("viewer")).toBe("user_bob");
      seenCursors.push(url.searchParams.get("cursor"));
      if (seenCursors.length === 1) {
        return jsonResponse({
          items: [friendshipFixture, { ...friendshipFixture, id: "rel_fr2" }],
          nextCursor: "rel_fr2",
        });
      }
      return jsonResponse({
        items: [{ ...friendshipFixture, id: "rel_fr3" }],
        nextCursor: null,
      });
    });
    const junjo = makeClient(fetchMock);

    const ids: string[] = [];
    for await (const friendship of junjo.friends.listAll("user_alice" as UserId, {
      limit: 2,
      tagId: "ftag_1",
      viewer: "user_bob" as UserId,
    })) {
      ids.push(friendship.id);
      expect(friendship.since).toBeInstanceOf(Date);
    }

    expect(ids).toEqual(["rel_fr1", "rel_fr2", "rel_fr3"]);
    expect(seenCursors).toEqual([null, "rel_fr2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
