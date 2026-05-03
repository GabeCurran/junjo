import { describe, expect, it, vi } from "vitest";
import { buildDashboardRoutes, seedScreenshotFixtures } from "./seed-fixtures.ts";

describe("buildDashboardRoutes", () => {
  it("emits a route for every dashboard surface the catalog covers", () => {
    const routes = buildDashboardRoutes({ gameId: "g_demo", primaryGroupId: "grp_alpha" });
    const slugs = routes.map((r) => r.slug);
    expect(slugs).toEqual([
      "home",
      "games",
      "audit",
      "permissions",
      "analytics",
      "game-detail",
      "groups-list",
      "group-members",
      "group-roles",
      "group-permissions",
      "group-audit",
      "group-relationships",
      "group-sub-groups",
      "game-audit",
      "permission-check",
      "game-analytics",
    ]);
  });

  it("substitutes the game id into game-scoped paths", () => {
    const routes = buildDashboardRoutes({ gameId: "g_demo", primaryGroupId: "grp_alpha" });
    const gameDetail = routes.find((r) => r.slug === "game-detail");
    expect(gameDetail?.path).toBe("/games/g_demo");
    const audit = routes.find((r) => r.slug === "game-audit");
    expect(audit?.path).toBe("/games/g_demo/audit");
  });

  it("substitutes the primary group id and tab query into group-detail paths", () => {
    const routes = buildDashboardRoutes({ gameId: "g_demo", primaryGroupId: "grp_alpha" });
    const members = routes.find((r) => r.slug === "group-members");
    expect(members?.path).toBe("/games/g_demo/groups/grp_alpha?tab=members");
    const subGroups = routes.find((r) => r.slug === "group-sub-groups");
    expect(subGroups?.path).toBe("/games/g_demo/groups/grp_alpha?tab=sub-groups");
  });

  it("URL-encodes ids that contain reserved characters", () => {
    const routes = buildDashboardRoutes({ gameId: "g/with slash", primaryGroupId: "g+plus" });
    const groupsList = routes.find((r) => r.slug === "groups-list");
    expect(groupsList?.path).toBe("/games/g%2Fwith%20slash/groups");
    const members = routes.find((r) => r.slug === "group-members");
    expect(members?.path).toBe("/games/g%2Fwith%20slash/groups/g%2Bplus?tab=members");
  });

  it("each route carries a non-empty description", () => {
    const routes = buildDashboardRoutes({ gameId: "g_demo", primaryGroupId: "grp_alpha" });
    for (const r of routes) {
      expect(r.description.length).toBeGreaterThan(0);
    }
  });
});

describe("seedScreenshotFixtures", () => {
  it("reuses an existing demo game and idempotent groups", async () => {
    const existingGame = { id: "g_existing", name: "Screenshot Demo" };
    const existingGroups = [
      { id: "grp_primary", name: "Wolves of Ironvale", parentGroupId: "grp_parent" },
      { id: "grp_secondary", name: "Storm Riders", parentGroupId: null },
      { id: "grp_parent", name: "Ironvale Alliance", parentGroupId: null },
    ];
    const fakeFetch = makeFakeFetch({
      games: [existingGame],
      groups: existingGroups,
      apiKey: "jk_demo.secretseed",
    });

    const result = await seedScreenshotFixtures({
      baseUrl: "http://example/",
      adminToken: "admintok",
      fetch: fakeFetch.fn,
    });

    expect(result).toEqual({
      gameId: "g_existing",
      primaryGroupId: "grp_primary",
      secondaryGroupId: "grp_secondary",
    });
    const createGameCalls = fakeFetch.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/v1/admin/games"),
    );
    expect(createGameCalls).toHaveLength(0);
    const createGroupCalls = fakeFetch.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/v1/groups"),
    );
    expect(createGroupCalls).toHaveLength(0);
  });

  it("creates the demo game when no matching game exists", async () => {
    const fakeFetch = makeFakeFetch({ games: [], groups: [], apiKey: "jk_demo.fresh" });
    await seedScreenshotFixtures({
      baseUrl: "http://example",
      adminToken: "admintok",
      fetch: fakeFetch.fn,
    });
    const createCalls = fakeFetch.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/v1/admin/games"),
    );
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.body).toEqual({ name: "Screenshot Demo" });
    const groupCreates = fakeFetch.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/v1/groups"),
    );
    expect(groupCreates.map((c) => (c.body as { name: string }).name).sort()).toEqual([
      "Ironvale Alliance",
      "Storm Riders",
      "Wolves of Ironvale",
    ]);
  });

  it("strips trailing slashes from baseUrl when building request URLs", async () => {
    const fakeFetch = makeFakeFetch({
      games: [{ id: "g_x", name: "Screenshot Demo" }],
      groups: [
        { id: "grp_p", name: "Wolves of Ironvale", parentGroupId: "grp_parent" },
        { id: "grp_s", name: "Storm Riders", parentGroupId: null },
        { id: "grp_parent", name: "Ironvale Alliance", parentGroupId: null },
      ],
      apiKey: "jk_demo.x",
    });
    await seedScreenshotFixtures({
      baseUrl: "http://example.com///",
      adminToken: "admintok",
      fetch: fakeFetch.fn,
    });
    const doubled = fakeFetch.calls.find((c) => c.url.includes("//v1"));
    expect(doubled).toBeUndefined();
  });
});

type FakeFetchSeed = {
  games: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string; parentGroupId: string | null }>;
  apiKey: string;
};

function makeFakeFetch(seed: FakeFetchSeed): {
  fn: typeof fetch;
  calls: Array<{ method: string; url: string; body: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let nextGroupId = 100;
  let nextRoleId = 1000;
  let nextInviteId = 5000;
  const groupsByGame = new Map<string, FakeFetchSeed["groups"]>();
  const games = [...seed.games];
  if (games.length > 0 && games[0]) {
    groupsByGame.set(games[0].id, [...seed.groups]);
  }
  const rolesByGroup = new Map<
    string,
    Array<{ id: string; name: string; permissions: string[] }>
  >();
  const membersByGroup = new Map<string, Array<{ externalUserId: string; status: string }>>();
  const relationshipsByGroup = new Map<
    string,
    Array<{ groupAId: string; groupBId: string; type: string }>
  >();
  const fn: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body = bodyText ? JSON.parse(bodyText) : null;
    calls.push({ method, url, body });

    if (method === "GET" && url.endsWith("/v1/admin/games")) {
      return jsonResponse({ items: games });
    }
    if (method === "POST" && url.endsWith("/v1/admin/games")) {
      const created = {
        id: `g_new${games.length.toString()}`,
        name: (body as { name: string }).name,
      };
      games.push(created);
      groupsByGame.set(created.id, []);
      return jsonResponse(created, 201);
    }
    const apiKeyMatch = /\/v1\/admin\/games\/([^/]+)\/api-keys$/.exec(url);
    if (method === "POST" && apiKeyMatch) {
      return jsonResponse({ id: "ak_demo", key: seed.apiKey }, 201);
    }
    const groupListMatch = /\/v1\/admin\/games\/([^/]+)\/groups\?/.exec(url);
    if (method === "GET" && groupListMatch) {
      const items = groupsByGame.get(groupListMatch[1] ?? "") ?? [];
      return jsonResponse({ items, total: items.length, hasMore: false });
    }
    if (method === "POST" && url.endsWith("/v1/groups")) {
      const newId = `grp_new${(nextGroupId++).toString()}`;
      const created = { id: newId, name: (body as { name: string }).name };
      const firstGameId = games[0]?.id ?? "";
      groupsByGame.get(firstGameId)?.push({ ...created, parentGroupId: null });
      return jsonResponse(created, 201);
    }
    const rolesListMatch = /\/v1\/admin\/games\/[^/]+\/groups\/([^/]+)\/roles$/.exec(url);
    if (method === "GET" && rolesListMatch) {
      return jsonResponse(rolesByGroup.get(rolesListMatch[1] ?? "") ?? []);
    }
    if (method === "POST" && rolesListMatch) {
      const role = {
        id: `role_${(nextRoleId++).toString()}`,
        name: (body as { name: string }).name,
        permissions: [] as string[],
      };
      const list = rolesByGroup.get(rolesListMatch[1] ?? "") ?? [];
      list.push(role);
      rolesByGroup.set(rolesListMatch[1] ?? "", list);
      return jsonResponse(role, 201);
    }
    const grantMatch = /\/v1\/admin\/games\/[^/]+\/roles\/([^/]+)\/permissions$/.exec(url);
    if (method === "POST" && grantMatch) {
      return jsonResponse({ ok: true });
    }
    const memberListMatch = /\/v1\/admin\/games\/[^/]+\/groups\/([^/]+)\/members\?/.exec(url);
    if (method === "GET" && memberListMatch) {
      const items = membersByGroup.get(memberListMatch[1] ?? "") ?? [];
      return jsonResponse({ items, total: items.length, hasMore: false });
    }
    const inviteMatch = /\/v1\/admin\/games\/[^/]+\/groups\/([^/]+)\/invitations$/.exec(url);
    if (method === "POST" && inviteMatch) {
      const code = `code_${(nextInviteId++).toString()}`;
      return jsonResponse({ id: `inv_${code}`, code }, 201);
    }
    const acceptMatch = /\/v1\/invitations\/([^/]+)\/accept$/.exec(url);
    if (method === "POST" && acceptMatch) {
      return jsonResponse({ id: "member_demo" });
    }
    const assignRoleMatch = /\/v1\/groups\/[^/]+\/members\/[^/]+\/roles\/[^/]+$/.exec(url);
    if (method === "POST" && assignRoleMatch) {
      return jsonResponse({ ok: true });
    }
    const relsMatch = /\/v1\/admin\/games\/[^/]+\/groups\/([^/]+)\/relationships$/.exec(url);
    if (method === "GET" && relsMatch) {
      return jsonResponse(relationshipsByGroup.get(relsMatch[1] ?? "") ?? []);
    }
    const setRelMatch = /\/v1\/admin\/games\/[^/]+\/groups\/([^/]+)\/relationships\/([^/]+)$/.exec(
      url,
    );
    if (method === "PUT" && setRelMatch) {
      return jsonResponse({
        groupAId: setRelMatch[1],
        groupBId: setRelMatch[2],
        type: (body as { type: string }).type,
      });
    }
    const setParentMatch = /\/v1\/admin\/games\/[^/]+\/groups\/([^/]+)\/parent$/.exec(url);
    if (method === "PUT" && setParentMatch) {
      return jsonResponse({ id: setParentMatch[1] });
    }
    return new Response(`unmatched ${method} ${url}`, { status: 500 });
  });
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
