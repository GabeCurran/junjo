import type {
  GroupId,
  MemberImportRowError,
  PermissionKey,
  RoleId,
  UserId,
  WebhookEndpointId,
} from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { JunjoError, isNotActive, memberImportErrors } from "./errors.js";
import { type ConditionalWriteOptions, writeOptions } from "./http.js";
import { Junjo } from "./index.js";

const G = "grp_1" as GroupId;
const U = "user_alice" as UserId;
const R = "role_1" as RoleId;
const P = "guild.invite" as PermissionKey;

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

interface Captured {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

// Records every request and answers each with `respond` (default: a
// 500 envelope, which every method surfaces as a rejection).
function makeClient(respond?: (req: Captured) => Response) {
  const calls: Captured[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input.toString(), init);
    const captured: Captured = {
      method: req.method,
      path: new URL(req.url).pathname,
      headers: req.headers,
      body: init?.body === undefined || init.body === null ? "" : await req.text(),
    };
    calls.push(captured);
    return respond
      ? respond(captured)
      : jsonResponse({ code: "internal", status: 500, message: "boom" }, 500);
  });
  const junjo = new Junjo({
    apiKey: "jk_test.secret",
    baseUrl: "https://example.test",
    inviteBaseUrl: "https://play.example.test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { junjo, calls };
}

async function rejection(p: Promise<unknown>): Promise<JunjoError> {
  const err = await p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(JunjoError);
  return err as JunjoError;
}

const wireMember = {
  id: "mem_1",
  groupId: G,
  userId: U,
  status: "active",
  roles: [R],
  metadata: {},
  notesPublic: null,
  notesPrivate: null,
  joinedAt: "2026-04-28T12:00:00.000Z",
  bannedUntil: null,
  version: 7,
};

const wireBan = {
  id: "ban_1",
  gameId: "game_1",
  userId: U,
  bannedAt: "2026-05-09T17:00:00.000Z",
  expiresAt: null,
  reason: "griefing",
  bannedBy: null,
  issuer: "console",
  version: 3,
};

describe("writeOptions", () => {
  it("sends no headers when neither option is set", () => {
    expect(writeOptions(undefined).headers).toEqual({});
    expect(writeOptions({ timeoutMs: 5 })).toEqual({
      signal: undefined,
      timeoutMs: 5,
      headers: {},
    });
  });

  it.each<[ConditionalWriteOptions["ifMatch"], string]>([
    [7, '"7"'],
    [0, '"0"'],
    ["7", '"7"'],
    ['"7"', '"7"'],
    [" 12 ", '"12"'],
  ])("quotes ifMatch %j as %s", (ifMatch, header) => {
    expect(writeOptions({ ifMatch }).headers).toEqual({ "if-match": header });
  });

  it("passes the idempotency key through verbatim", () => {
    expect(writeOptions({ idempotencyKey: "queue-42:unban" }).headers).toEqual({
      "idempotency-key": "queue-42:unban",
    });
  });
});

// Every method that writes, called with an idempotency key. The table
// is the contract: a write method missing from it, or ignoring the
// option, fails here.
type WriteCall = (junjo: Junjo, o: ConditionalWriteOptions) => Promise<unknown>;
const WRITES: Record<string, WriteCall> = {
  "groups.create": (j, o) => j.groups.create({ kind: "guild", name: "G" }, o),
  "groups.update": (j, o) => j.groups.update(G, { name: "H" }, o),
  "groups.delete": (j, o) => j.groups.delete(G, o),
  "groups.restore": (j, o) => j.groups.restore(G, o),
  "groups.inviteByUserId": (j, o) => j.groups.inviteByUserId(G, U, o),
  "groups.inviteByCode": (j, o) => j.groups.inviteByCode(G, undefined, o),
  "groups.inviteByLink": (j, o) => j.groups.inviteByLink(G, undefined, o),
  "groups.bulkInvite": (j, o) => j.groups.bulkInvite(G, "user_a\n", o),
  "groups.acceptInvitation": (j, o) => j.groups.acceptInvitation("CODE", U, o),
  "groups.declineInvitation": (j, o) => j.groups.declineInvitation("CODE", o),
  "groups.leave": (j, o) => j.groups.leave(G, U, o),
  "groups.join": (j, o) => j.groups.join(G, U, o),
  "groups.kick": (j, o) => j.groups.kick(G, U, o),
  "groups.ban": (j, o) => j.groups.ban(G, U, o),
  "groups.unban": (j, o) => j.groups.unban(G, U, o),
  "groups.setRelationship": (j, o) => j.groups.setRelationship(G, "grp_2" as GroupId, "ally", o),
  "groups.clearRelationship": (j, o) => j.groups.clearRelationship(G, "grp_2" as GroupId, o),
  "groups.setParent": (j, o) => j.groups.setParent(G, null, o),
  "members.add": (j, o) => j.members.add(G, U, o),
  "members.import": (j, o) => j.members.import(G, { members: [{ userId: U }] }, o),
  "members.setMetadata": (j, o) => j.members.setMetadata(G, U, { a: 1 }, o),
  "members.setNotes": (j, o) => j.members.setNotes(G, U, { notesPublic: "hi" }, o),
  "members.assignRole": (j, o) => j.members.assignRole(G, U, R, o),
  "members.removeRole": (j, o) => j.members.removeRole(G, U, R, o),
  "members.overridePermission": (j, o) => j.members.overridePermission(G, U, P, true, o),
  "members.clearPermissionOverride": (j, o) => j.members.clearPermissionOverride(G, U, P, o),
  "roles.create": (j, o) => j.roles.create(G, { name: "Officer", priority: 10 }, o),
  "roles.update": (j, o) => j.roles.update(R, { name: "Captain" }, o),
  "roles.delete": (j, o) => j.roles.delete(R, o),
  "roles.grantPermission": (j, o) => j.roles.grantPermission(R, P, o),
  "roles.setEntries": (j, o) => j.roles.setEntries(R, [], o),
  "roles.setParents": (j, o) => j.roles.setParents(R, [], o),
  "roles.revokePermission": (j, o) => j.roles.revokePermission(R, P, o),
  "bans.add": (j, o) => j.bans.add({ userId: U }, o),
  "bans.remove": (j, o) => j.bans.remove(U, o),
  "sanctions.add": (j, o) => j.sanctions.add(U, { type: "mute" }, o),
  "sanctions.remove": (j, o) => j.sanctions.remove(U, "mute", o),
  "invitations.revoke": (j, o) => j.invitations.revoke("CODE", o),
  "identities.requestLinkCode": (j, o) => j.identities.requestLinkCode(U, o),
  "identities.redeemLinkCode": (j, o) =>
    j.identities.redeemLinkCode({ code: "ABC", userId: "web:alice" as UserId }, o),
  "identities.unlink": (j, o) => j.identities.unlink(U, o),
  "identities.setDisplayName": (j, o) => j.identities.setDisplayName(U, "Alice", o),
  "friends.requests.send": (j, o) => j.friends.requests.send(U, "user_bob" as UserId, o),
  "friends.requests.accept": (j, o) => j.friends.requests.accept("req_1", o),
  "friends.requests.decline": (j, o) => j.friends.requests.decline("req_1", o),
  "friends.requests.cancel": (j, o) => j.friends.requests.cancel("req_1", o),
  "friends.blocks.add": (j, o) => j.friends.blocks.add(U, "user_bob" as UserId, o),
  "friends.blocks.remove": (j, o) => j.friends.blocks.remove(U, "user_bob" as UserId, o),
  "friends.tags.create": (j, o) => j.friends.tags.create(U, { name: "raid" }, o),
  "friends.tags.update": (j, o) => j.friends.tags.update("tag_1", { name: "pvp" }, o),
  "friends.tags.delete": (j, o) => j.friends.tags.delete("tag_1", o),
  "friends.tags.assign": (j, o) => j.friends.tags.assign(U, "user_bob" as UserId, [], o),
  "friends.visibility.set": (j, o) => j.friends.visibility.set(U, "public", o),
  "friends.remove": (j, o) => j.friends.remove(U, "user_bob" as UserId, o),
  "webhooks.endpoints.create": (j, o) =>
    j.webhooks.endpoints.create({ url: "https://hooks.example.test" }, o),
  "webhooks.endpoints.update": (j, o) =>
    j.webhooks.endpoints.update("whe_1" as WebhookEndpointId, { disabled: true }, o),
  "webhooks.endpoints.delete": (j, o) =>
    j.webhooks.endpoints.delete("whe_1" as WebhookEndpointId, o),
};

// The writes the server checks `If-Match` on.
const CONDITIONAL: Record<string, WriteCall> = {
  "members.setMetadata": WRITES["members.setMetadata"] as WriteCall,
  "members.setNotes": WRITES["members.setNotes"] as WriteCall,
  "members.assignRole": WRITES["members.assignRole"] as WriteCall,
  "members.removeRole": WRITES["members.removeRole"] as WriteCall,
  "members.overridePermission": WRITES["members.overridePermission"] as WriteCall,
  "members.clearPermissionOverride": WRITES["members.clearPermissionOverride"] as WriteCall,
  "groups.kick": WRITES["groups.kick"] as WriteCall,
  "groups.ban": WRITES["groups.ban"] as WriteCall,
  "groups.unban": WRITES["groups.unban"] as WriteCall,
  "bans.add": WRITES["bans.add"] as WriteCall,
  "bans.remove": WRITES["bans.remove"] as WriteCall,
  "sanctions.add": WRITES["sanctions.add"] as WriteCall,
  "sanctions.remove": WRITES["sanctions.remove"] as WriteCall,
};

describe("idempotencyKey on every write", () => {
  it.each(Object.entries(WRITES))("%s sends Idempotency-Key", async (_name, call) => {
    const { junjo, calls } = makeClient();
    await rejection(call(junjo, { idempotencyKey: "key-123" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("idempotency-key")).toBe("key-123");
    expect(calls[0]?.headers.get("if-match")).toBeNull();
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jk_test.secret");
  });

  it.each(Object.entries(WRITES))("%s sends no Idempotency-Key by default", async (_name, call) => {
    const { junjo, calls } = makeClient();
    await rejection(call(junjo, {}));
    expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
  });

  it("keeps bulkInvite's CSV content type next to the key", async () => {
    const { junjo, calls } = makeClient();
    await rejection(junjo.groups.bulkInvite(G, "user_a\n", { idempotencyKey: "csv-1" }));
    expect(calls[0]?.headers.get("content-type")).toBe("text/csv");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("csv-1");
  });
});

describe("ifMatch on conditional writes", () => {
  it.each(Object.entries(CONDITIONAL))("%s sends a quoted If-Match", async (_name, call) => {
    const { junjo, calls } = makeClient();
    await rejection(call(junjo, { ifMatch: 7, idempotencyKey: "k" }));
    expect(calls[0]?.headers.get("if-match")).toBe('"7"');
    expect(calls[0]?.headers.get("idempotency-key")).toBe("k");
  });

  it("surfaces a stale version as precondition_failed", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse(
        { code: "precondition_failed", status: 412, message: 'If-Match "6" does not match' },
        412,
      ),
    );
    const err = await rejection(junjo.members.assignRole(G, U, R, { ifMatch: 6 }));
    expect(err.code).toBe("precondition_failed");
    expect(err.status).toBe(412);
  });

  it("surfaces idempotency errors with their codes and Retry-After", async () => {
    const reused = makeClient(() =>
      jsonResponse({ code: "idempotency_key_reused", status: 422, message: "reused" }, 422),
    );
    const e1 = await rejection(reused.junjo.groups.leave(G, U, { idempotencyKey: "k" }));
    expect(e1.code).toBe("idempotency_key_reused");

    const running = makeClient(() =>
      jsonResponse({ code: "idempotency_key_in_progress", status: 409, message: "running" }, 409, {
        "retry-after": "1",
      }),
    );
    const e2 = await rejection(running.junjo.groups.leave(G, U, { idempotencyKey: "k" }));
    expect(e2.code).toBe("idempotency_key_in_progress");
    expect(e2.retryAfterSeconds).toBe(1);
  });
});

describe("JunjoError.details", () => {
  it("carries an object details field from the envelope", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse(
        { code: "not_found", status: 404, message: "no ban", details: { reason: "not_active" } },
        404,
      ),
    );
    const err = await rejection(junjo.bans.remove(U));
    expect(err.details).toEqual({ reason: "not_active" });
  });

  it.each([null, "text", 3, ["a"]])("drops a non-object details value (%j)", async (details) => {
    const { junjo } = makeClient(() =>
      jsonResponse({ code: "bad_request", status: 400, message: "x", details }, 400),
    );
    const err = await rejection(junjo.groups.leave(G, U));
    expect(err.details).toBeUndefined();
  });
});

describe("isNotActive", () => {
  it("is true only for not_found with details.reason not_active", () => {
    const opts = { details: { reason: "not_active" } };
    expect(isNotActive(new JunjoError("x", "not_found", 404, opts))).toBe(true);
    expect(isNotActive(new JunjoError("x", "not_found", 404))).toBe(false);
    expect(
      isNotActive(new JunjoError("x", "not_found", 404, { details: { reason: "gone" } })),
    ).toBe(false);
    expect(isNotActive(new JunjoError("x", "bad_request", 400, opts))).toBe(false);
    expect(isNotActive(new Error("not_active"))).toBe(false);
    expect(isNotActive(undefined)).toBe(false);
  });

  it("recognises a replayed group unban with nothing to lift", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse(
        { code: "not_found", status: 404, message: "no ban", details: { reason: "not_active" } },
        404,
      ),
    );
    const err = await rejection(junjo.groups.unban(G, U, { ifMatch: 4, idempotencyKey: "k" }));
    expect(isNotActive(err)).toBe(true);
  });

  it("recognises a replayed sanction lift with nothing to lift", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse(
        { code: "not_found", status: 404, message: "none", details: { reason: "not_active" } },
        404,
      ),
    );
    const err = await rejection(junjo.sanctions.remove(U, "mute", { ifMatch: 2 }));
    expect(isNotActive(err)).toBe(true);
  });
});

describe("members.import", () => {
  it("POSTs the input to the import route and returns the typed result", async () => {
    const result = {
      created: 1,
      reactivated: 0,
      updated: 1,
      unchanged: 0,
      items: [
        { userId: "mc:a", status: "created", version: 1 },
        { userId: "mc:b", status: "updated", version: 5 },
      ],
    };
    const { junjo, calls } = makeClient(() => jsonResponse(result));
    const input = {
      members: [
        {
          userId: "mc:a" as UserId,
          roleIds: [R],
          overrides: [{ permission: "fly" as PermissionKey, value: true }],
          metadata: { prefix: "[VIP]" },
        },
        { userId: "mc:b" as UserId },
      ],
      allowBanned: true,
      actorUserId: "mc:admin" as UserId,
    };
    const out = await junjo.members.import(G, input, { idempotencyKey: "import-1" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/v1/groups/grp_1/members/import");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual(input);
    expect(calls[0]?.headers.get("idempotency-key")).toBe("import-1");
    expect(out).toEqual(result);
  });

  it("exposes every failing row through memberImportErrors", async () => {
    const rows: MemberImportRowError[] = [
      { index: 0, userId: "mc:a" as UserId, code: "banned", message: "banned from the game" },
      { index: 3, userId: "bad id" as UserId, code: "invalid_user_id", message: "invalid" },
    ];
    const { junjo } = makeClient(() =>
      jsonResponse(
        { code: "bad_request", status: 400, message: "2 rows failed", details: { rows } },
        400,
      ),
    );
    const err = await rejection(junjo.members.import(G, { members: [] }));
    expect(err.code).toBe("bad_request");
    expect(memberImportErrors(err)).toEqual(rows);
  });

  it("memberImportErrors is empty for errors without rows", () => {
    expect(memberImportErrors(new JunjoError("x", "bad_request", 400))).toEqual([]);
    expect(
      memberImportErrors(new JunjoError("x", "bad_request", 400, { details: { rows: "no" } })),
    ).toEqual([]);
    expect(memberImportErrors(new Error("x"))).toEqual([]);
  });
});

describe("versions on reads and writes", () => {
  it("decodes Member.version from member responses", async () => {
    const { junjo } = makeClient(() => jsonResponse(wireMember));
    const member = await junjo.members.setMetadata(G, U, { a: 1 }, { ifMatch: 6 });
    expect(member.version).toBe(7);
    const got = await junjo.members.get(G, U);
    expect(got?.version).toBe(7);
  });

  it("decodes MemberAccess.version", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse({
        groupId: G,
        userId: U,
        status: "active",
        roleIds: [],
        overrides: [],
        version: 9,
      }),
    );
    const access = await junjo.members.getAccess(G, U);
    expect(access?.version).toBe(9);
  });

  it("decodes version and issuer on game bans", async () => {
    const { junjo } = makeClient(() => jsonResponse({ items: [wireBan], nextCursor: null }));
    const page = await junjo.bans.list();
    expect(page.items[0]?.version).toBe(3);
    expect(page.items[0]?.issuer).toBe("console");
  });

  it("decodes issuer on ban history rows", async () => {
    const row = {
      id: "bh_1",
      gameId: "game_1",
      userId: U,
      scope: "game",
      groupId: null,
      kind: "set",
      reason: null,
      expiresAt: null,
      eventAt: "2026-05-09T17:00:00.000Z",
      actorUserId: null,
      issuer: "old-staff",
    };
    const { junjo } = makeClient(() => jsonResponse({ items: [row], nextCursor: null }));
    const page = await junjo.bans.history(U);
    expect(page.items[0]?.issuer).toBe("old-staff");
  });
});

describe("bans.add import fields", () => {
  it("sends bannedAt as ISO and issuer verbatim", async () => {
    const { junjo, calls } = makeClient(() => jsonResponse(wireBan, 201));
    const ban = await junjo.bans.add(
      {
        userId: U,
        bannedAt: new Date("2025-01-02T03:04:05.000Z"),
        issuer: "console",
        actorUserId: "user_mod" as UserId,
      },
      { ifMatch: 0, idempotencyKey: "ban-1" },
    );
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      userId: U,
      bannedAt: "2025-01-02T03:04:05.000Z",
      issuer: "console",
      actorUserId: "user_mod",
    });
    expect(calls[0]?.headers.get("if-match")).toBe('"0"');
    expect(ban.version).toBe(3);
    expect(ban.issuer).toBe("console");
  });

  it("passes a string bannedAt through and omits absent fields", async () => {
    const { junjo, calls } = makeClient(() => jsonResponse(wireBan, 201));
    await junjo.bans.add({ userId: U, bannedAt: "2025-01-02T03:04:05Z" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      userId: U,
      bannedAt: "2025-01-02T03:04:05Z",
    });
  });
});

describe("bans.moderation", () => {
  it("GETs the moderation route and decodes the active ban", async () => {
    const { junjo, calls } = makeClient(() =>
      jsonResponse({ userId: U, version: 3, ban: wireBan }),
    );
    const state = await junjo.bans.moderation(U);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/v1/users/user_alice/moderation");
    expect(state.userId).toBe(U);
    expect(state.version).toBe(3);
    expect(state.ban?.bannedAt).toBeInstanceOf(Date);
    expect(state.ban?.version).toBe(3);
  });

  it("returns version 0 and a null ban for a person never moderated", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse({ userId: "mc:new", version: 0, ban: null, sanctions: [] }),
    );
    const state = await junjo.bans.moderation("mc:new" as UserId);
    expect(state).toEqual({ userId: "mc:new", version: 0, ban: null, sanctions: [] });
  });

  it("decodes the active sanctions", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse({
        userId: U,
        version: 5,
        ban: null,
        sanctions: [
          {
            id: "san_1",
            userId: U,
            type: "mute",
            reason: "spam",
            issuer: null,
            issuedBy: "mod_1",
            startedAt: "2026-05-09T17:00:00.000Z",
            expiresAt: "2026-05-09T18:00:00.000Z",
            version: 5,
          },
        ],
      }),
    );
    const state = await junjo.bans.moderation(U);
    expect(state.sanctions).toHaveLength(1);
    expect(state.sanctions[0]?.type).toBe("mute");
    expect(state.sanctions[0]?.issuedBy).toBe("mod_1");
    expect(state.sanctions[0]?.startedAt).toBeInstanceOf(Date);
    expect(state.sanctions[0]?.expiresAt).toEqual(new Date("2026-05-09T18:00:00.000Z"));
  });

  it("reads a missing sanctions field as none", async () => {
    const { junjo } = makeClient(() => jsonResponse({ userId: U, version: 1, ban: null }));
    const state = await junjo.bans.moderation(U);
    expect(state.sanctions).toEqual([]);
  });

  it("encodes the user id in the path", async () => {
    const { junjo, calls } = makeClient(() =>
      jsonResponse({ userId: "a/b", version: 0, ban: null }),
    );
    await junjo.bans.moderation("a/b" as UserId);
    expect(calls[0]?.path).toBe("/v1/users/a%2Fb/moderation");
  });
});
