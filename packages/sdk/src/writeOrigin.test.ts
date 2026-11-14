import type { GroupId, UserId } from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { JunjoError } from "./errors.js";
import { deserializeEvent } from "./events.js";
import { Junjo } from "./index.js";

const G = "grp_1" as GroupId;
const H = "grp_2" as GroupId;

const WIRE_GROUP = {
  id: G,
  gameId: "game_1",
  kind: "guild",
  name: "Red",
  visibility: "public",
  metadata: {},
  defaultRoleId: null,
  parentGroupId: null,
  memberCount: 0,
  hasPasscode: false,
  createdAt: "2026-11-14T00:00:00.000Z",
  updatedAt: "2026-11-14T00:00:00.000Z",
  softDeletedAt: null,
};

interface Captured {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

function makeClient(respond: (req: Captured) => Response, writeTag?: string) {
  const calls: Captured[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input.toString(), init);
    const captured: Captured = {
      method: req.method,
      url: new URL(req.url),
      headers: req.headers,
      body: init?.body === undefined || init.body === null ? "" : await req.text(),
    };
    calls.push(captured);
    return respond(captured);
  });
  const junjo = new Junjo({
    apiKey: "jk_test.secret",
    baseUrl: "https://example.test",
    fetch: fetchMock as unknown as typeof fetch,
    ...(writeTag === undefined ? {} : { writeTag }),
  });
  return { junjo, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("write tags", () => {
  it("sends the client's tag on every request and lets a write override it", async () => {
    const { junjo, calls } = makeClient(() => json({ ...WIRE_GROUP, version: "3" }), "server-1");
    await junjo.groups.update(G, { name: "Red" });
    await junjo.groups.update(G, { name: "Red" }, { writeTag: "other" });
    expect(calls[0]?.headers.get("junjo-write-tag")).toBe("server-1");
    expect(calls[1]?.headers.get("junjo-write-tag")).toBe("other");
  });

  it("sends no tag by default", async () => {
    const { junjo, calls } = makeClient(() => json(WIRE_GROUP));
    await junjo.groups.update(G, { name: "Red" });
    expect(calls[0]?.headers.has("junjo-write-tag")).toBe(false);
  });

  it("refuses a malformed client tag", () => {
    for (const tag of ["", "has space", "x".repeat(129)]) {
      expect(() => makeClient(() => json({}), tag)).toThrow(JunjoError);
    }
  });
});

describe("event origin", () => {
  const base = {
    id: "evt_1",
    gameId: "game_1",
    groupId: G,
    occurredAt: "2026-11-14T00:00:00.000Z",
  };

  it("parses the origin and defaults it when the server sends none", () => {
    const tagged = deserializeEvent({
      ...base,
      type: "group.deleted",
      origin: { apiKeyId: "key_1", tag: "server-1" },
      actorUserId: "leader",
    } as never);
    expect(tagged.origin).toEqual({ apiKeyId: "key_1", tag: "server-1" });
    expect(tagged.type === "group.deleted" && tagged.actorUserId).toBe("leader");

    const old = deserializeEvent({ ...base, type: "group.deleted" } as never);
    expect(old.origin).toEqual({ apiKeyId: null, tag: null });
    expect(old.type === "group.deleted" && old.actorUserId).toBeNull();
  });
});

describe("group versions and actors", () => {
  it("reads the version and sends it back as If-Match", async () => {
    const { junjo, calls } = makeClient(() => json({ ...WIRE_GROUP, version: "42" }));
    const group = await junjo.groups.update(
      G,
      { metadata: { motd: "hi" }, actorUserId: "leader" as UserId },
      { ifMatch: "41" },
    );
    expect(group.version).toBe("42");
    expect(calls[0]?.headers.get("if-match")).toBe('"41"');
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      metadata: { motd: "hi" },
      actorUserId: "leader",
    });
  });

  it("leaves version off a group the server sent without one", async () => {
    const { junjo } = makeClient(() => json(WIRE_GROUP));
    const group = await junjo.groups.update(G, { name: "Red" });
    expect(group).not.toHaveProperty("version");
  });

  it("puts delete's options in the query", async () => {
    const { junjo, calls } = makeClient(() => new Response(null, { status: 204 }));
    await junjo.groups.delete(G, { hard: true, actorUserId: "leader" as UserId, ifMatch: "7" });
    await junjo.groups.delete(G);
    expect(calls[0]?.url.search).toBe("?hard=true&actorUserId=leader");
    expect(calls[0]?.headers.get("if-match")).toBe('"7"');
    expect(calls[1]?.url.search).toBe("");
  });

  it("sends the actor on kick and on relationship writes", async () => {
    const { junjo, calls } = makeClient((req) =>
      req.method === "DELETE"
        ? new Response(null, { status: 204 })
        : req.url.pathname.endsWith("/kick")
          ? json({
              id: "mem_1",
              groupId: G,
              userId: "alice",
              status: "kicked",
              roles: [],
              metadata: {},
              notesPublic: null,
              notesPrivate: null,
              joinedAt: "2026-11-14T00:00:00.000Z",
              bannedUntil: null,
              version: 2,
            })
          : json({
              groupAId: G,
              groupBId: H,
              type: "ally",
              since: "2026-11-14T00:00:00.000Z",
              setBy: "leader",
            }),
    );
    await junjo.groups.kick(G, "alice" as UserId, { actorUserId: "mod" as UserId });
    const rel = await junjo.groups.setRelationship(G, H, "ally", {
      mutual: true,
      actorUserId: "leader" as UserId,
    });
    await junjo.groups.clearRelationship(G, H, { mutual: true, actorUserId: "leader" as UserId });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ actorUserId: "mod" });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      type: "ally",
      mutual: true,
      actorUserId: "leader",
    });
    expect(rel.setBy).toBe("leader");
    expect(calls[2]?.url.search).toBe("?mutual=true&actorUserId=leader");
  });
});

describe("export filters", () => {
  it("puts records and groupKinds in the query", async () => {
    const lines = [
      {
        kind: "header",
        format: "junjo-export",
        version: 1,
        gameId: "game_1",
        exportedAt: "2026-11-14T00:00:00.000Z",
        position: "9",
        records: ["group"],
        groupKinds: ["faction:a"],
      },
      { kind: "game", id: "game_1" },
      { kind: "group", id: G, version: "9" },
      { kind: "end", counts: { game: 1, group: 1 } },
    ];
    const { junjo, calls } = makeClient(
      () =>
        new Response(lines.map((l) => JSON.stringify(l)).join("\n"), {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }),
    );
    const seen: string[] = [];
    for await (const record of junjo.export({ records: ["group"], groupKinds: ["faction:a"] })) {
      seen.push(record.kind);
    }
    expect(calls[0]?.url.searchParams.get("records")).toBe("group");
    expect(calls[0]?.url.searchParams.get("groupKinds")).toBe("faction:a");
    expect(seen).toEqual(["header", "game", "group", "end"]);
  });
});

describe("group batch", () => {
  it("posts the ops with If-Match and parses each result by its op", async () => {
    const member = {
      id: "mem_1",
      groupId: G,
      userId: "alice",
      status: "active",
      roles: ["role_l"],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
      joinedAt: "2026-11-14T00:00:00.000Z",
      bannedUntil: null,
      version: 3,
    };
    const { junjo, calls } = makeClient(() =>
      json({ version: "12", results: [member, { ...WIRE_GROUP, name: "Crimson" }, null] }),
    );
    const out = await junjo.groups.batch(
      G,
      [
        { op: "member.role.add", userId: "alice" as UserId, roleId: "role_l" as never },
        { op: "group.update", name: "Crimson" },
        { op: "relationship.clear", otherGroupId: H },
      ],
      { ifMatch: "11", writeTag: "server-1" },
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe(`/v1/groups/${G}/batch`);
    expect(calls[0]?.headers.get("if-match")).toBe('"11"');
    expect(calls[0]?.headers.get("junjo-write-tag")).toBe("server-1");
    expect(JSON.parse(calls[0]?.body ?? "{}").ops).toHaveLength(3);
    expect(out.version).toBe("12");
    expect((out.results[0] as { joinedAt: Date }).joinedAt).toBeInstanceOf(Date);
    expect((out.results[1] as { name: string }).name).toBe("Crimson");
    expect(out.results[2]).toBeNull();
  });
});
