// Comprehensive demo seed. Wipes the connected DB and creates a
// representative dataset that exercises every dashboard surface:
// groups (3 kinds + 3 visibilities), roles + permissions + overrides,
// members in every status, sub-group hierarchy, group relationships
// (ally / enemy / neutral), invitations in every lifecycle state,
// 50+ audit entries, 3 webhook endpoints (junjo / discord / slack),
// webhook deliveries in every status.
//
// Run with: npm run db:seed:demo
// (Always wipes the dev DB first; use a separate DATABASE_URL than
// your prod data.)
//
// Uses console.* (not pino) so the operator can copy the printed API
// key out of the terminal cleanly.

import { randomBytes } from "node:crypto";
import { generateApiKey } from "./apiKey.js";
import { disconnectPrisma, prisma } from "./db.js";

const DEMO_GAME_NAME = "Demo Game (junjo seed)";

// ----- helpers -------------------------------------------------------

function hex(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

function pick<T>(arr: readonly T[], i: number): T {
  const v = arr[i % arr.length];
  if (v === undefined) throw new Error("pick: empty array");
  return v;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}

// ----- wipe ---------------------------------------------------------

async function wipe(): Promise<void> {
  // Cascade order matters: child rows first, parents last. Most have
  // ON DELETE CASCADE on Game, so deleting Games would clear most;
  // explicit order documents the dependency graph.
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.auditEntry.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.memberPermissionOverride.deleteMany();
  await prisma.memberRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.groupRelationship.deleteMany();
  await prisma.groupMember.deleteMany();
  await prisma.role.deleteMany();
  await prisma.permissionDef.deleteMany();
  await prisma.group.deleteMany();
  await prisma.externalIdentity.deleteMany();
  await prisma.junjoUser.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.game.deleteMany();
}

// ----- main ---------------------------------------------------------

async function main(): Promise<void> {
  console.log("[seed:demo] wiping DB...");
  await wipe();

  // 1. Game + API key
  console.log("[seed:demo] creating game + API key...");
  const game = await prisma.game.create({ data: { name: DEMO_GAME_NAME } });
  const rawKey = await generateApiKey();
  const apiKey = await prisma.apiKey.create({
    data: { gameId: game.id, prefix: rawKey.prefix, hashedSecret: rawKey.hashedSecret },
  });

  // 2. Permission catalog
  console.log("[seed:demo] permission definitions...");
  const PERM_KEYS = [
    { key: "members.kick", description: "Kick a member from the group" },
    { key: "members.invite", description: "Invite a new member" },
    { key: "members.assign-role", description: "Change member roles" },
    { key: "roles.manage", description: "Create / edit / delete roles" },
    { key: "groups.edit", description: "Rename and reconfigure the group" },
    { key: "groups.delete", description: "Soft-delete the group" },
    { key: "audit.view", description: "View the group audit log" },
    { key: "webhooks.manage", description: "Create / revoke webhook endpoints" },
  ] as const;
  for (const p of PERM_KEYS) {
    await prisma.permissionDef.create({
      data: { gameId: game.id, key: p.key, description: p.description },
    });
  }

  // 3. JunjoUsers + ExternalIdentities (the dev's "users")
  console.log("[seed:demo] users + external identities...");
  const USER_NAMES = [
    "azura", "boran", "cyrus", "dax", "elara", "fenris", "garan", "hilde",
    "io", "jorah", "kira", "lyric", "mira", "nyx", "orin", "petra",
    "quill", "raven", "syrah", "thane", "umi", "vale", "wren", "xan",
    "yara", "zev",
  ] as const;
  const users = await Promise.all(
    USER_NAMES.map(async (name) => {
      const user = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId: game.id, junjoUserId: user.id, externalUserId: `ext_${name}` },
      });
      return { id: user.id, name };
    }),
  );

  // 4. Groups: 5 of varying kind + visibility, with a parent/child
  console.log("[seed:demo] groups...");
  const GROUP_SPECS = [
    { kind: "guild", name: "Crimson Dawn", visibility: "public" },
    { kind: "guild", name: "Storm Riders", visibility: "invite-only" },
    { kind: "party", name: "Dungeon Crawl #14", visibility: "secret" },
    { kind: "clan", name: "House Vex", visibility: "public" },
    { kind: "clan", name: "House Vex - Inner Council", visibility: "invite-only" },
  ] as const;
  const groups = await Promise.all(
    GROUP_SPECS.map((spec) => prisma.group.create({ data: { gameId: game.id, ...spec } })),
  );
  // Make "House Vex - Inner Council" a child of "House Vex"
  const houseVex = groups[3];
  const innerCouncil = groups[4];
  if (!houseVex || !innerCouncil) throw new Error("group order changed");
  await prisma.group.update({
    where: { id: innerCouncil.id },
    data: { parentGroupId: houseVex.id },
  });

  // 5. Roles + permissions per group
  console.log("[seed:demo] roles + role-permissions...");
  const ROLE_SPECS = [
    { name: "Owner", priority: 100, color: "#ef4444", isDefault: false, perms: PERM_KEYS.map((p) => p.key) },
    { name: "Officer", priority: 75, color: "#f59e0b", isDefault: false, perms: ["members.kick", "members.invite", "members.assign-role", "audit.view"] },
    { name: "Member", priority: 25, color: "#3b82f6", isDefault: true, perms: ["members.invite"] },
    { name: "Recruit", priority: 10, color: "#6b7280", isDefault: false, perms: [] },
  ] as const;
  // groupId -> role-name -> Role
  const rolesByGroup = new Map<string, Map<string, { id: string }>>();
  for (const group of groups) {
    const map = new Map<string, { id: string }>();
    for (const spec of ROLE_SPECS) {
      const role = await prisma.role.create({
        data: {
          groupId: group.id,
          name: spec.name,
          priority: spec.priority,
          color: spec.color,
          isDefault: spec.isDefault,
        },
      });
      map.set(spec.name, { id: role.id });
      for (const permKey of spec.perms) {
        await prisma.rolePermission.create({
          data: { roleId: role.id, permissionKey: permKey },
        });
      }
    }
    rolesByGroup.set(group.id, map);
    // Set defaultRoleId on the group (Member is default)
    const memberRole = map.get("Member");
    if (memberRole) {
      await prisma.group.update({ where: { id: group.id }, data: { defaultRoleId: memberRole.id } });
    }
  }

  // 6. Members + role assignments
  console.log("[seed:demo] members + role assignments...");
  // Distribute users across groups with varied status. Keep first user
  // as Owner of every group so a single login can administer them all.
  const MEMBER_STATUSES = ["active", "active", "active", "active", "left", "kicked"] as const;
  const ownerUser = users[0];
  if (!ownerUser) throw new Error("no users seeded");
  for (const [groupIdx, group] of groups.entries()) {
    const groupRoles = rolesByGroup.get(group.id);
    if (!groupRoles) continue;
    // Owner first (always active)
    const ownerMember = await prisma.groupMember.create({
      data: { groupId: group.id, junjoUserId: ownerUser.id, status: "active", joinedAt: daysAgo(180) },
    });
    const ownerRole = groupRoles.get("Owner");
    if (ownerRole) {
      await prisma.memberRole.create({ data: { groupMemberId: ownerMember.id, roleId: ownerRole.id } });
    }
    // Then 6-8 other members per group with varied status / roles / dates
    const memberCount = 6 + (groupIdx % 3);
    const usersForGroup = users.slice(1, 1 + memberCount);
    for (const [i, user] of usersForGroup.entries()) {
      const status = pick(MEMBER_STATUSES, i + groupIdx);
      const joined = daysAgo(60 - i * 4);
      const left = status === "left" || status === "kicked" ? hoursAgo(i * 6 + 2) : null;
      const member = await prisma.groupMember.create({
        data: {
          groupId: group.id,
          junjoUserId: user.id,
          status,
          joinedAt: joined,
          leftAt: left,
          notesPublic: i % 4 === 0 ? `Joined during the ${["spring", "summer", "fall", "winter"][groupIdx % 4]} push` : null,
        },
      });
      // Assign a role only to active members
      if (status === "active") {
        const roleName = i === 0 ? "Officer" : i < 3 ? "Member" : "Recruit";
        const role = groupRoles.get(roleName);
        if (role) {
          await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });
        }
      }
    }
  }

  // 7. A few permission overrides (member-level allow/deny)
  console.log("[seed:demo] permission overrides...");
  const firstGroup = groups[0];
  if (firstGroup) {
    const someActiveMembers = await prisma.groupMember.findMany({
      where: { groupId: firstGroup.id, status: "active" },
      take: 3,
    });
    const overrides = [
      { perm: "members.kick", grant: true },
      { perm: "groups.delete", grant: false },
      { perm: "webhooks.manage", grant: true },
    ] as const;
    for (const [i, m] of someActiveMembers.entries()) {
      const ov = overrides[i % overrides.length];
      if (!ov) continue;
      await prisma.memberPermissionOverride.create({
        data: { groupMemberId: m.id, permissionKey: ov.perm, grant: ov.grant },
      });
    }
  }

  // 8. Group relationships (ally / enemy / neutral)
  console.log("[seed:demo] group relationships...");
  const [crimson, storm, , vex] = groups;
  if (crimson && storm && vex) {
    await prisma.groupRelationship.create({
      data: { groupAId: crimson.id, groupBId: storm.id, type: "ally" },
    });
    await prisma.groupRelationship.create({
      data: { groupAId: storm.id, groupBId: crimson.id, type: "ally" },
    });
    await prisma.groupRelationship.create({
      data: { groupAId: crimson.id, groupBId: vex.id, type: "enemy" },
    });
    await prisma.groupRelationship.create({
      data: { groupAId: vex.id, groupBId: storm.id, type: "neutral" },
    });
  }

  // 9. Invitations: pending / used / expired / revoked / direct-push
  console.log("[seed:demo] invitations...");
  if (crimson && storm) {
    const memberRole = rolesByGroup.get(crimson.id)?.get("Member");
    const targetUser = users[10];
    if (memberRole && targetUser) {
      // Pending direct invite
      await prisma.invitation.create({
        data: {
          groupId: crimson.id,
          code: `inv_${hex(6)}`,
          roleId: memberRole.id,
          targetUserId: targetUser.id,
          expiresAt: daysAgo(-7),
        },
      });
    }
    // Open code, pending
    await prisma.invitation.create({
      data: { groupId: crimson.id, code: `inv_${hex(6)}`, expiresAt: daysAgo(-30) },
    });
    // Open code, used
    const used = users[5];
    if (used) {
      await prisma.invitation.create({
        data: {
          groupId: crimson.id,
          code: `inv_${hex(6)}`,
          usedAt: hoursAgo(8),
          usedByUserId: used.id,
        },
      });
    }
    // Expired
    await prisma.invitation.create({
      data: { groupId: storm.id, code: `inv_${hex(6)}`, expiresAt: daysAgo(2) },
    });
    // Already-expired short window
    await prisma.invitation.create({
      data: { groupId: storm.id, code: `inv_${hex(6)}`, expiresAt: hoursAgo(2) },
    });
  }

  // 10. Audit entries (one per major mutation we did, plus filler)
  console.log("[seed:demo] audit entries...");
  const ACTIONS = [
    "group.created",
    "member.joined",
    "member.kicked",
    "member.left",
    "role.created",
    "role.permission.granted",
    "member.role.assigned",
    "member.permission.override.set",
    "group.relationship.set",
    "invitation.created",
    "invitation.accepted",
    "webhook.endpoint.created",
  ] as const;
  for (const group of groups) {
    for (let i = 0; i < 12; i++) {
      const action = pick(ACTIONS, i);
      const actor = pick(users, i + group.id.length);
      await prisma.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: i % 7 === 0 ? null : actor.id, // some system actions
          action,
          targetId: null,
          payload: { note: `seed entry ${i}`, action },
          createdAt: hoursAgo(i * 3 + 1),
        },
      });
    }
  }

  // 11. Webhook endpoints + deliveries
  console.log("[seed:demo] webhooks...");
  const WH_SPECS = [
    { url: "https://hooks.example/junjo", format: "junjo", events: [] },
    { url: "https://discord.com/api/webhooks/demo", format: "discord", events: ["member.joined", "member.kicked"] },
    { url: "https://hooks.slack.com/services/demo", format: "slack", events: ["group.created", "role.created"] },
  ] as const;
  const endpoints = await Promise.all(
    WH_SPECS.map((spec) =>
      prisma.webhookEndpoint.create({
        data: {
          gameId: game.id,
          url: spec.url,
          secret: hex(16),
          events: [...spec.events],
          format: spec.format,
        },
      }),
    ),
  );
  // Deliveries: mix of statuses
  const DELIVERY_STATUSES = ["delivered", "delivered", "delivered", "pending", "failed"] as const;
  for (const ep of endpoints) {
    for (let i = 0; i < 5; i++) {
      const status = pick(DELIVERY_STATUSES, i);
      const groupForEvent = pick(groups, i + ep.id.length);
      await prisma.webhookDelivery.create({
        data: {
          webhookEndpointId: ep.id,
          eventId: `evt_${hex(6)}`,
          payload: { type: pick(ACTIONS, i), groupId: groupForEvent.id, idx: i },
          status,
          attemptCount: status === "failed" ? 6 : 1,
          responseStatus: status === "delivered" ? 200 : status === "failed" ? 503 : null,
          lastAttemptAt: status === "pending" ? null : hoursAgo(i * 2 + 1),
          nextAttemptAt: status === "pending" ? hoursAgo(-1) : null,
          createdAt: hoursAgo(i * 2 + 2),
        },
      });
    }
  }

  // ----- summary -----
  console.log("");
  console.log("Seed complete.");
  console.log("");
  console.log("Game");
  console.log(`  id:   ${game.id}`);
  console.log(`  name: ${game.name}`);
  console.log("");
  console.log("API key (copy now; cannot be recovered)");
  console.log(`  id:     ${apiKey.id}`);
  console.log(`  prefix: ${rawKey.prefix}`);
  console.log(`  full:   ${rawKey.full}`);
  console.log("");
  console.log(`Groups:       ${groups.length}`);
  console.log(`Users:        ${users.length}`);
  console.log(`Permissions:  ${PERM_KEYS.length}`);
  console.log(`Webhooks:     ${endpoints.length}`);
  console.log("");
  console.log("Open the dashboard at http://localhost:3000/games to explore.");
}

main()
  .catch((err) => {
    console.error("[seed:demo] failed");
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
