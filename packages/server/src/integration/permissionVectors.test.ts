import { readFileSync } from "node:fs";
import type { PermissionMode } from "@junjo.io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { permissionCache } from "../permissionCache";
import { normalizePermissionKey } from "../permissionResolve";
import { createApiKey, createGame } from "../seed";

// Runs the shared conformance vectors through the database-backed
// check routes, so the server's loading path (reachable-role CTE,
// candidate-key filtering, override short-circuit) is held to the same
// answers as the pure resolver.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "MemberRole", "RoleParent", "RolePermission", "PermissionDef", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

interface VectorCase {
  name: string;
  modes: PermissionMode[];
  roles: Record<string, { priority: number; entries: Record<string, boolean>; parents?: string[] }>;
  member: { roles: string[]; overrides?: Record<string, boolean> };
  checks: { permission: string; allowed: boolean; source: string; via?: string }[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../shared/conformance/permission-vectors.json", import.meta.url),
    "utf8",
  ),
) as { cases: VectorCase[] };

const USER = "vector-user";

describe.skipIf(!TEST_DATABASE_URL)("permission conformance vectors over the database", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    permissionCache.clear();
    const game = await createGame("Vectors", prisma);
    gameId = game.id;
    authHeader = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Role ids are the vector's own ids so the id-descending tie-break
  // orders them exactly as the vectors expect.
  async function seedCase(vc: VectorCase, mode: PermissionMode): Promise<string> {
    await prisma.game.update({
      where: { id: gameId },
      data: { config: { permissions: { mode } } },
    });
    const group = await prisma.group.create({
      data: { gameId, kind: "network", name: "net", visibility: "public", metadata: {} },
    });
    for (const [id, role] of Object.entries(vc.roles)) {
      await prisma.role.create({
        data: { id, groupId: group.id, name: id, priority: role.priority },
      });
      const entries = Object.entries(role.entries).map(([k, value]) => ({
        roleId: id,
        permissionKey: normalizePermissionKey(mode, k),
        value,
      }));
      if (entries.length > 0) await prisma.rolePermission.createMany({ data: entries });
    }
    for (const [id, role] of Object.entries(vc.roles)) {
      for (const parent of role.parents ?? []) {
        await prisma.roleParent.create({ data: { roleId: id, parentRoleId: parent } });
      }
    }
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: USER },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: group.id, junjoUserId: user.id, status: "active" },
    });
    for (const roleId of vc.member.roles) {
      await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId } });
    }
    for (const [k, grant] of Object.entries(vc.member.overrides ?? {})) {
      await prisma.memberPermissionOverride.create({
        data: { groupMemberId: member.id, permissionKey: normalizePermissionKey(mode, k), grant },
      });
    }
    return group.id;
  }

  function expected(check: VectorCase["checks"][number]): Record<string, unknown> {
    const out: Record<string, unknown> = { allowed: check.allowed, source: check.source };
    if (check.via !== undefined) out.viaRoleId = check.via;
    return out;
  }

  for (const vc of vectors.cases) {
    for (const mode of vc.modes) {
      it(`[${mode}] ${vc.name}`, async () => {
        const groupId = await seedCase(vc, mode);

        for (const check of vc.checks) {
          const qs = new URLSearchParams({ userId: USER, groupId, permission: check.permission });
          const res = await app.request(`/v1/permissions/check?${qs}`, {
            headers: { authorization: authHeader },
          });
          expect(res.status).toBe(200);
          expect(await res.json(), `single ${check.permission}`).toEqual(expected(check));
        }

        permissionCache.clear();
        const batch = await app.request("/v1/permissions/check-batch", {
          method: "POST",
          headers: { authorization: authHeader, "content-type": "application/json" },
          body: JSON.stringify({
            checks: vc.checks.map((c) => ({ userId: USER, groupId, permission: c.permission })),
            inherit: true,
          }),
        });
        expect(batch.status).toBe(200);
        const { results } = (await batch.json()) as { results: Record<string, unknown>[] };
        vc.checks.forEach((check, i) => {
          const want = expected(check);
          // An inherited check names the deciding group when it decides.
          if (check.source === "role" || check.source === "override") want.viaGroupId = groupId;
          expect(results[i], `inherited ${check.permission}`).toEqual(want);
        });
      });
    }
  }
});
