import { EXPORT_RECORD_KINDS } from "@junjo.io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";
import { EXPORT_BATCH_SIZE } from "./export";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-export";
const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "LinkCode", "UserRelationshipTag", "FriendTag", "UserRelationship", "MemberPermissionOverride", "MemberRole", "RoleParent", "RolePermission", "GroupRelationship", "GroupMember", "GameBan", "BanHistory", "Sanction", "SanctionHistory", "ModerationState", "IdempotencyRecord", "EventLog", "GameEventCounter", "Invitation", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

type Line = Record<string, unknown> & { kind: string };

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/export", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let gameId: string;
  let exportKey: string;
  let plainKey: string;
  let plainKeyId: string;
  let keySecret: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Export", prisma);
    gameId = game.id;
    const exporter = await createApiKey(game.id, prisma);
    await prisma.apiKey.update({ where: { id: exporter.apiKey.id }, data: { canExport: true } });
    exportKey = `Bearer ${exporter.raw.full}`;
    keySecret = exporter.raw.full.split(".")[1] ?? "";
    const plain = await createApiKey(game.id, prisma);
    plainKey = `Bearer ${plain.raw.full}`;
    plainKeyId = plain.apiKey.id;
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  async function call(method: string, path: string, body?: unknown, auth = exportKey) {
    return app.request(path, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // Reads the whole body with a bounded deadline, cancelling the reader
  // if it stalls.
  async function readExport(res: Response): Promise<{ text: string; lines: Line[] }> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 30_000;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("export did not finish in time");
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("export read timed out")), remaining),
          ),
        ]);
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const lines = text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Line);
    return { text, lines };
  }

  async function seedEverything(): Promise<void> {
    const ok = async (res: Response | Promise<Response>, status = [200, 201, 204]) => {
      const r = await res;
      expect(status, `${r.status} ${await r.clone().text()}`).toContain(r.status);
      return r;
    };
    const group = (await (
      await ok(
        call("POST", "/v1/groups", {
          kind: "guild",
          name: "Alpha",
          visibility: "public",
          passcode: "secret-passcode",
        }),
      )
    ).json()) as { id: string };
    const other = (await (
      await ok(call("POST", "/v1/groups", { kind: "guild", name: "Beta" }))
    ).json()) as { id: string };
    const role = (await (
      await ok(call("POST", `/v1/groups/${group.id}/roles`, { name: "officer", priority: 5 }))
    ).json()) as { id: string };
    await ok(
      call("PUT", `/v1/roles/${role.id}/entries`, {
        entries: [{ permission: "invite", value: true }],
      }),
    );
    await ok(
      call("POST", `/v1/groups/${group.id}/members`, { userId: "mc:alice", roleId: role.id }),
    );
    await ok(call("PUT", "/v1/users/mc%3Aalice/display-name", { displayName: "Alice" }));
    await ok(call("POST", `/v1/groups/${group.id}/invitations`, { targetUserId: "bob" }));
    await ok(call("PUT", `/v1/groups/${group.id}/relationships/${other.id}`, { type: "ally" }));
    await ok(call("POST", "/v1/bans", { userId: "cheater", reason: "aimbot" }));
    await ok(call("POST", "/v1/sanctions", { userId: "mc:alice", type: "mute" }));
    await ok(call("POST", "/v1/users/carol/friend-requests", { targetJunjoUserId: "dave" }));
    await prisma.game.update({
      where: { id: gameId },
      data: { config: { friends: { requestsRequired: true } } },
    });
    await ok(call("POST", "/v1/users/erin/blocks", { targetJunjoUserId: "frank" }));
    await ok(call("POST", "/v1/users/carol/friend-tags", { name: "raid" }));
    await prisma.webhookEndpoint.create({
      data: { gameId, url: "https://example.test/hook", secret: "webhook-secret-value-123456" },
    });
    await ok(call("POST", "/v1/users/mc%3Aalice/link-codes"));
  }

  it("refuses a key without canExport", async () => {
    const res = await call("GET", "/v1/export", undefined, plainKey);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("permission_denied");
  });

  it("streams a header, every kind in order, and an end line with counts", async () => {
    await seedEverything();
    const position = (await prisma.gameEventCounter.findUnique({ where: { gameId } }))?.seq;
    const res = await call("GET", "/v1/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const { text, lines } = await readExport(res);

    const header = lines[0];
    expect(header).toMatchObject({
      kind: "header",
      format: "junjo-export",
      version: 1,
      gameId,
      position: String(position),
    });
    expect(Date.parse(String(header?.exportedAt))).not.toBeNaN();

    const end = lines[lines.length - 1];
    expect(end?.kind).toBe("end");
    const body = lines.slice(1, -1);

    // Kinds appear in the documented order, each in one run.
    const order = body.map((l) => l.kind).filter((k, i, all) => all[i - 1] !== k);
    const expected = EXPORT_RECORD_KINDS.filter((k) => order.includes(k));
    expect(order).toEqual(expected);

    const counts = end?.counts as Record<string, number>;
    expect(Object.keys(counts).sort()).toEqual([...EXPORT_RECORD_KINDS].sort());
    for (const kind of EXPORT_RECORD_KINDS) {
      expect(counts[kind], kind).toBe(body.filter((l) => l.kind === kind).length);
    }
    for (const kind of [
      "game",
      "person",
      "group",
      "role",
      "member",
      "invitation",
      "relationship",
      "ban",
      "banHistory",
      "sanction",
      "sanctionHistory",
      "friendRequest",
      "block",
      "friendTag",
      "audit",
    ]) {
      expect(counts[kind], kind).toBeGreaterThan(0);
    }

    const game = body.find((l) => l.kind === "game");
    expect(game).toMatchObject({ id: gameId, name: "Export", networkId: null });
    const alice = body.find(
      (l) =>
        l.kind === "person" &&
        (l.identities as { userId: string }[]).some((i) => i.userId === "mc:alice"),
    );
    expect(alice?.identities).toEqual([
      expect.objectContaining({ userId: "mc:alice", namespace: "mc", displayName: "Alice" }),
    ]);
    const member = body.find((l) => l.kind === "member");
    expect(member).toMatchObject({ personId: alice?.id, userId: "mc:alice", status: "active" });
    expect((member?.roles as string[]).length).toBe(1);
    const group = body.find((l) => l.kind === "group" && l.name === "Alpha");
    expect(group).toMatchObject({ groupKind: "guild", hasPasscode: true });
    const role = body.find((l) => l.kind === "role");
    expect(role?.entries).toEqual([{ permission: "invite", value: true }]);
    const sanction = body.find((l) => l.kind === "sanction");
    expect(sanction).toMatchObject({ type: "mute", userId: "mc:alice", personId: alice?.id });

    // Credentials and excluded tables never appear.
    for (const secret of [keySecret, "webhook-secret-value-123456", "secret-passcode"]) {
      expect(text).not.toContain(secret);
    }
    for (const field of ["hashedSecret", "passcodeHash", "codeHash", "fingerprint", "prefix"]) {
      expect(text).not.toContain(`"${field}"`);
    }
    expect(text).not.toContain("example.test/hook");
    expect(text).not.toContain(plainKeyId);
  });

  it("reads in batches and keeps every row of a large kind", async () => {
    const total = EXPORT_BATCH_SIZE + 37;
    await prisma.junjoUser.createMany({
      data: Array.from({ length: total }, (_, i) => ({ id: `p${String(i).padStart(5, "0")}` })),
    });
    await prisma.externalIdentity.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        gameId,
        junjoUserId: `p${String(i).padStart(5, "0")}`,
        externalUserId: `u${i}`,
      })),
    });
    // A second id for some people must not split or duplicate them.
    await prisma.externalIdentity.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        gameId,
        junjoUserId: `p${String(EXPORT_BATCH_SIZE - 2 + i).padStart(5, "0")}`,
        externalUserId: `alt${i}`,
      })),
    });
    await prisma.auditEntry.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        gameId,
        action: "group.created",
        targetId: `t${i}`,
      })),
    });
    const { lines } = await readExport(await call("GET", "/v1/export"));
    const people = lines.filter((l) => l.kind === "person");
    expect(people).toHaveLength(total);
    expect(new Set(people.map((p) => p.id)).size).toBe(total);
    const multi = people.filter((p) => (p.identities as unknown[]).length === 2);
    expect(multi).toHaveLength(5);
    expect(lines.filter((l) => l.kind === "audit")).toHaveLength(total);
    const end = lines[lines.length - 1];
    expect(end?.counts).toMatchObject({ person: total, audit: total });
  });

  it("lets the admin PATCH and mint set canExport", async () => {
    const patched = await app.request(`/v1/admin/games/${gameId}/api-keys/${plainKeyId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ canExport: true }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { canExport: boolean }).canExport).toBe(true);
    expect((await call("GET", "/v1/export", undefined, plainKey)).status).toBe(200);

    const revoke = await app.request(`/v1/admin/games/${gameId}/api-keys/${plainKeyId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ canExport: false }),
    });
    expect(((await revoke.json()) as { canExport: boolean }).canExport).toBe(false);
    expect((await call("GET", "/v1/export", undefined, plainKey)).status).toBe(403);

    const minted = await app.request(`/v1/admin/games/${gameId}/api-keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ canExport: true }),
    });
    expect(minted.status).toBe(201);
    const created = (await minted.json()) as { canExport: boolean; key: string };
    expect(created.canExport).toBe(true);
    expect((await call("GET", "/v1/export", undefined, `Bearer ${created.key}`)).status).toBe(200);

    const listed = await app.request(`/v1/admin/games/${gameId}/api-keys`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const items = ((await listed.json()) as { items: { canExport: boolean }[] }).items;
    expect(items.every((k) => typeof k.canExport === "boolean")).toBe(true);
  });
});
