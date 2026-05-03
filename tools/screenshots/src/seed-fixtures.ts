// Idempotent fixture seeder for the dashboard screenshot catalog.
// Calls a live Junjo server's admin + per-game endpoints to ensure a
// "Screenshot Demo" game exists with a populated catalog of groups,
// members, roles, permissions, invitations, relationships, and audit
// entries. Returns the resolved IDs the dashboard route paths need.
//
// Why HTTP and not Prisma: the seeder runs from the screenshot tool
// workspace which does not pull in Prisma; the per-game audit log is
// produced as a side effect of the same write paths the dashboard
// itself drives, so the resulting screenshots show realistic state.

export type SeedOptions = {
  baseUrl: string;
  adminToken: string;
  gameName?: string;
  fetch?: typeof fetch;
};

export type SeedResult = {
  gameId: string;
  primaryGroupId: string;
  secondaryGroupId: string;
};

const DEFAULT_GAME_NAME = "Screenshot Demo";
const PRIMARY_GROUP_NAME = "Wolves of Ironvale";
const SECONDARY_GROUP_NAME = "Storm Riders";
const PARENT_GROUP_NAME = "Ironvale Alliance";

type AdminGameLite = { id: string; name: string };
type AdminGameListLite = { items: AdminGameLite[] };
type AdminApiKeyCreatedLite = { id: string; key: string };
type AdminGroupLite = { id: string; name: string; parentGroupId: string | null };
type AdminGroupListLite = { items: AdminGroupLite[]; total: number; hasMore: boolean };
type CreatedGroupLite = { id: string; name: string };
type AdminInvitationLite = { id: string; code: string };
type AdminRoleLite = { id: string; name: string; permissions: string[] };

export async function seedScreenshotFixtures(opts: SeedOptions): Promise<SeedResult> {
  const ctx = makeContext(opts);
  const game = await ensureGame(ctx);
  const apiKey = await issueApiKey(ctx, game.id);
  const perGameCtx = { ...ctx, apiKey };

  const groups = await ensureCoreGroups(ctx, perGameCtx, game.id);
  await ensureGroupContent(ctx, perGameCtx, game.id, groups.primary);
  await ensureGroupContent(ctx, perGameCtx, game.id, groups.secondary);
  await ensureRelationships(ctx, game.id, groups);
  await ensureParent(ctx, game.id, groups);

  return {
    gameId: game.id,
    primaryGroupId: groups.primary.id,
    secondaryGroupId: groups.secondary.id,
  };
}

type RouteIds = {
  gameId: string;
  primaryGroupId: string;
};

export type DashboardRouteSpec = {
  slug: string;
  path: string;
  description: string;
};

// Pure: no IO. Builds every dashboard route the catalog should cover
// from the resolved IDs the seeder returns. Exposed as a separate
// export so vitest can assert on the slug + path shape without
// standing up a live server.
export function buildDashboardRoutes(ids: RouteIds): DashboardRouteSpec[] {
  const game = encodeURIComponent(ids.gameId);
  const group = encodeURIComponent(ids.primaryGroupId);
  return [
    { slug: "home", path: "/", description: "Dashboard home (overview cards + recent activity)" },
    { slug: "games", path: "/games", description: "Cross-game list" },
    { slug: "audit", path: "/audit", description: "Cross-game recent audit feed" },
    {
      slug: "permissions",
      path: "/permissions",
      description: "Cross-game permission tester landing",
    },
    { slug: "analytics", path: "/analytics", description: "Cross-game analytics landing" },
    { slug: "game-detail", path: `/games/${game}`, description: "Single-game overview + API keys" },
    { slug: "groups-list", path: `/games/${game}/groups`, description: "Game groups browser" },
    {
      slug: "group-members",
      path: `/games/${game}/groups/${group}?tab=members`,
      description: "Group detail (members tab)",
    },
    {
      slug: "group-roles",
      path: `/games/${game}/groups/${group}?tab=roles`,
      description: "Group detail (roles tab)",
    },
    {
      slug: "group-permissions",
      path: `/games/${game}/groups/${group}?tab=permissions`,
      description: "Group detail (permissions matrix tab)",
    },
    {
      slug: "group-audit",
      path: `/games/${game}/groups/${group}?tab=audit`,
      description: "Group detail (audit tab)",
    },
    {
      slug: "group-relationships",
      path: `/games/${game}/groups/${group}?tab=relationships`,
      description: "Group detail (relationships tab)",
    },
    {
      slug: "group-sub-groups",
      path: `/games/${game}/groups/${group}?tab=sub-groups`,
      description: "Group detail (sub-groups tab)",
    },
    {
      slug: "game-audit",
      path: `/games/${game}/audit`,
      description: "Game-wide audit feed",
    },
    {
      slug: "permission-check",
      path: `/games/${game}/permissions/check`,
      description: "Permission check tester",
    },
    {
      slug: "game-analytics",
      path: `/games/${game}/analytics`,
      description: "Analytics dashboard (charts + heatmap)",
    },
  ];
}

type Ctx = {
  baseUrl: string;
  adminToken: string;
  gameName: string;
  fetch: typeof fetch;
};

type PerGameCtx = Ctx & { apiKey: string };

function makeContext(opts: SeedOptions): Ctx {
  return {
    baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    adminToken: opts.adminToken,
    gameName: opts.gameName ?? DEFAULT_GAME_NAME,
    fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

async function ensureGame(ctx: Ctx): Promise<AdminGameLite> {
  const list = await adminGet<AdminGameListLite>(ctx, "/v1/admin/games");
  const existing = list.items.find((g) => g.name === ctx.gameName);
  if (existing) return existing;
  return adminPost<AdminGameLite>(ctx, "/v1/admin/games", { name: ctx.gameName });
}

async function issueApiKey(ctx: Ctx, gameId: string): Promise<string> {
  const created = await adminPost<AdminApiKeyCreatedLite>(
    ctx,
    `/v1/admin/games/${encodeURIComponent(gameId)}/api-keys`,
    null,
  );
  return created.key;
}

type EnsuredGroups = {
  primary: AdminGroupLite;
  secondary: AdminGroupLite;
  parent: AdminGroupLite;
};

async function ensureCoreGroups(
  ctx: Ctx,
  perGame: PerGameCtx,
  gameId: string,
): Promise<EnsuredGroups> {
  const list = await adminGet<AdminGroupListLite>(
    ctx,
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups?limit=100&sort=createdAt&order=desc`,
  );
  const findOrCreate = async (name: string, kind: string): Promise<AdminGroupLite> => {
    const found = list.items.find((g) => g.name === name);
    if (found) return found;
    const created = await perGamePost<CreatedGroupLite>(perGame, "/v1/groups", { kind, name });
    list.items.push({ id: created.id, name: created.name, parentGroupId: null });
    return { id: created.id, name: created.name, parentGroupId: null };
  };
  const primary = await findOrCreate(PRIMARY_GROUP_NAME, "guild");
  const secondary = await findOrCreate(SECONDARY_GROUP_NAME, "guild");
  const parent = await findOrCreate(PARENT_GROUP_NAME, "alliance");
  return { primary, secondary, parent };
}

const SAMPLE_USERS = [
  { id: "demo_user_aria", role: "officer" },
  { id: "demo_user_brennan", role: "veteran" },
  { id: "demo_user_celine", role: "veteran" },
  { id: "demo_user_dario", role: "recruit" },
  { id: "demo_user_eden", role: "recruit" },
  { id: "demo_user_finch", role: "recruit" },
] as const;

const SAMPLE_ROLES: Array<{
  name: string;
  priority: number;
  color: string;
  permissions: string[];
}> = [
  {
    name: "officer",
    priority: 100,
    color: "#a855f7",
    permissions: ["group.invite", "group.kick", "group.bank.withdraw"],
  },
  {
    name: "veteran",
    priority: 50,
    color: "#22c55e",
    permissions: ["group.invite"],
  },
  {
    name: "recruit",
    priority: 10,
    color: "#64748b",
    permissions: [],
  },
];

async function ensureGroupContent(
  ctx: Ctx,
  perGame: PerGameCtx,
  gameId: string,
  group: AdminGroupLite,
): Promise<void> {
  const existingRoles = await adminGet<AdminRoleLite[]>(
    ctx,
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(group.id)}/roles`,
  );
  const rolesByName = new Map<string, AdminRoleLite>();
  for (const r of existingRoles) rolesByName.set(r.name, r);

  for (const def of SAMPLE_ROLES) {
    let role = rolesByName.get(def.name);
    if (!role) {
      role = await adminPost<AdminRoleLite>(
        ctx,
        `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(group.id)}/roles`,
        { name: def.name, priority: def.priority, color: def.color },
      );
      rolesByName.set(def.name, role);
    }
    const haveSet = new Set(role.permissions);
    for (const p of def.permissions) {
      if (haveSet.has(p)) continue;
      await adminPost(
        ctx,
        `/v1/admin/games/${encodeURIComponent(gameId)}/roles/${encodeURIComponent(role.id)}/permissions`,
        { permission: p },
      );
    }
  }

  const memberList = await adminGet<{ items: { externalUserId: string; status: string }[] }>(
    ctx,
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(group.id)}/members?limit=100&status=all`,
  );
  const knownExternalIds = new Set(memberList.items.map((m) => m.externalUserId));

  for (const u of SAMPLE_USERS) {
    if (knownExternalIds.has(u.id)) continue;
    const invitation = await adminPost<AdminInvitationLite>(
      ctx,
      `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(group.id)}/invitations`,
      {},
    );
    await perGamePost(perGame, `/v1/invitations/${encodeURIComponent(invitation.code)}/accept`, {
      userId: u.id,
    });
    const role = rolesByName.get(u.role);
    if (role) {
      await perGamePost(
        perGame,
        `/v1/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(u.id)}/roles/${encodeURIComponent(role.id)}`,
        null,
      );
    }
  }
}

async function ensureRelationships(ctx: Ctx, gameId: string, groups: EnsuredGroups): Promise<void> {
  const existing = await adminGet<{ groupAId: string; groupBId: string; type: string }[]>(
    ctx,
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groups.primary.id)}/relationships`,
  );
  const haveRivalry = existing.some(
    (r) => r.groupBId === groups.secondary.id && r.type === "rival",
  );
  if (!haveRivalry) {
    await adminPut(
      ctx,
      `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groups.primary.id)}/relationships/${encodeURIComponent(groups.secondary.id)}`,
      { type: "rival", mutual: true },
    );
  }
}

async function ensureParent(ctx: Ctx, gameId: string, groups: EnsuredGroups): Promise<void> {
  if (groups.primary.parentGroupId === groups.parent.id) return;
  await adminPut(
    ctx,
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groups.primary.id)}/parent`,
    { parentGroupId: groups.parent.id },
  );
}

async function adminGet<T>(ctx: Ctx, path: string): Promise<T> {
  const res = await ctx.fetch(`${ctx.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${ctx.adminToken}` },
  });
  return readJson<T>(res, "GET", path);
}

async function adminPost<T = unknown>(ctx: Ctx, path: string, body: unknown): Promise<T> {
  const res = await ctx.fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: bodyHeaders(ctx.adminToken, body),
    body: body === null ? undefined : JSON.stringify(body),
  });
  return readJson<T>(res, "POST", path);
}

async function adminPut<T = unknown>(ctx: Ctx, path: string, body: unknown): Promise<T> {
  const res = await ctx.fetch(`${ctx.baseUrl}${path}`, {
    method: "PUT",
    headers: bodyHeaders(ctx.adminToken, body),
    body: body === null ? undefined : JSON.stringify(body),
  });
  return readJson<T>(res, "PUT", path);
}

async function perGamePost<T = unknown>(ctx: PerGameCtx, path: string, body: unknown): Promise<T> {
  const res = await ctx.fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: bodyHeaders(ctx.apiKey, body),
    body: body === null ? undefined : JSON.stringify(body),
  });
  return readJson<T>(res, "POST", path);
}

function bodyHeaders(bearer: string, body: unknown): Record<string, string> {
  const h: Record<string, string> = { authorization: `Bearer ${bearer}` };
  if (body !== null) h["content-type"] = "application/json";
  return h;
}

async function readJson<T>(res: Response, method: string, path: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`seed ${method} ${path} failed: ${res.status.toString()} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
