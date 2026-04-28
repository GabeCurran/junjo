# 03 — Architecture

## Pattern: API-first, thin native SDKs

Same shape as Stripe, Auth0, Clerk, Supabase, Pusher, Twilio. The HTTP API is the source of truth. Every SDK is a thin client. Anyone can use raw HTTP if no SDK exists yet — that's the universal escape hatch.

```
┌─────────────────────────────────────────────────────┐
│  Cloud (managed) OR Docker (self-host)              │
│                                                     │
│  junjo-server (Node + TypeScript)                   │
│  - REST API: /v1/groups, /v1/members,               │
│              /v1/roles, /v1/permissions             │
│  - SSE: /v1/events/:groupId (real-time push)        │
│  - Webhooks: dispatch on events with HMAC + retries │
│  - Postgres (own, or BYO via DATABASE_URL)          │
│  - Auth adapter: Clerk / Supabase / JWT / BYO       │
└─────────────────────────────────────────────────────┘
       │
       ├── @junjo/sdk        (npm)   → core TS client (Node + browser)
       ├── @junjo/react      (npm)   → React hooks built on @junjo/sdk
       ├── junjo-roblox      (Roblox model) → Luau wrapper for HttpService
       ├── (V2) GuildKit.Unity        → C#/Unity Asset Store package
       ├── (V3) godot-junjo            → Godot/GDScript
       └── webhooks                   → custom integrations in any language
```

## Backend

- **Language:** TypeScript on Node (matches Gabe's strongest stack; PokeDnD pattern reused)
- **Framework:** Hono or Fastify (TBD — both lightweight and fast)
- **Database:** Postgres only. Cloud uses Supabase or Neon. Self-host accepts `DATABASE_URL`.
- **ORM:** Prisma (matches PokeDnD pattern; schema-first; great DX for migrations)
- **Real-time:** Server-Sent Events. SSE hubs in `globalThis` for in-process broadcast. Cloud deploys as single-instance for V1 (same shape as PokeDnD on Railway).
- **Webhooks:** queued via Postgres advisory locks for ordering. HMAC-signed. Exponential-backoff retries up to 24 hours.
- **Auth verification:** all requests carry an API key (server-to-server) plus an end-user token (player session). The API key identifies the game; the end-user token is verified via the configured auth adapter.

## SDKs (V1)

### `@junjo/sdk` (TypeScript)

Universal client for Node + browser. Tree-shakeable. Zero runtime dependencies beyond `fetch` (built-in).

Core surface (sketch):

```ts
import { Junjo } from "@junjo/sdk";

const junjo = new Junjo({
  apiKey: process.env.JUNJO_API_KEY,
  authAdapter: clerkAdapter(clerkInstance),
});

// Groups
const group = await junjo.groups.create({
  name: "Crimson Wolves",
  kind: "guild",
  defaultRoleId: "member",
  visibility: "invite-only",
  metadata: { motto: "Howl together" },
});

// Membership
await junjo.groups.inviteByUserId(group.id, "user_xyz", { roleId: "recruit" });
await junjo.groups.inviteByCode(group.id, { roleId: "recruit", expiresIn: "7d" });

// Roles
const officer = await junjo.roles.create(group.id, {
  name: "Officer",
  priority: 80,
  color: "#ff5050",
  permissions: ["invite_member", "kick_member"],
});

// Permission check (server-side; cached)
const allowed = await junjo.can(userId, group.id, "invite_member");

// Group relationships
await junjo.groups.setRelationship(groupA.id, groupB.id, "ally");
const rel = await junjo.groups.getRelationship(groupA.id, groupB.id);

// Real-time subscription (SSE)
const sub = junjo.groups.subscribe(group.id, (event) => {
  if (event.type === "member.joined") notifyChat(event);
});
sub.close();

// Webhook middleware (Express-compatible)
app.post("/webhooks/junjo", junjo.webhooks.middleware(), (req, res) => {
  const event = req.body; // signature already verified
  res.sendStatus(200);
});

// Audit log
const log = await junjo.audit.list(group.id, { limit: 50 });
```

### `@junjo/react`

React hooks built on `@junjo/sdk`. Optimistic updates + automatic SSE subscription lifecycle.

```tsx
import { JunjoProvider, useGroup, useCan } from "@junjo/react";

function GuildPanel({ groupId }) {
  const { group, members } = useGroup(groupId);
  const canInvite = useCan(groupId, "invite_member");
  // ...
}
```

### `junjo-roblox` (Luau)

Roblox model bundling a Luau module. Wraps `HttpService` and `MessagingService`. Dogfooded against the existing `mobarena-roblox` project.

```lua
local Junjo = require(ReplicatedStorage.Junjo)

local junjo = Junjo.new({
  apiKey = game:GetService("HttpService"):GetSecret("JUNJO_API_KEY"),
  authAdapter = Junjo.RobloxUserIdAdapter(), -- uses Players service
})

local group = junjo.groups:create({
  name = "Crimson Wolves",
  kind = "clan",
  defaultRoleId = "member",
})

local allowed = junjo:can(player.UserId, group.id, "invite_member")
```

## Auth adapter pattern

The single most important design decision. Auth is BYO — Junjo never replaces it.

```ts
interface AuthAdapter {
  verifyToken(token: string): Promise<{ userId: string } | null>;
}

// Built-in adapters
import { clerkAdapter, supabaseAdapter, jwtAdapter } from "@junjo/sdk/adapters";

// Custom
const myAdapter: AuthAdapter = {
  async verifyToken(token) {
    const session = await mySessionService.verify(token);
    return session ? { userId: session.user.id } : null;
  },
};
```

The dev's existing identity provider remains the source of truth for users. Junjo just accepts whatever `userId` the adapter returns and treats it as an opaque string. No passwords, no email-verification flows, no OAuth — those all stay in the dev's auth provider.

This is *the* lesson from Gabe's Ory experience: do one thing well, compose with everything else.

## Persistence

Postgres only. Cloud uses Supabase (free tier handles thousands of customers) or Neon. Self-host accepts a `DATABASE_URL`.

No support for:
- MongoDB (different consistency model; would fragment the codebase)
- SQLite (fine for testing, not for production)
- A "Postgres-native API" like PostgREST (overkill, more attack surface)

If a paying customer demands it, revisit. Don't build speculatively.

## Monorepo layout (npm workspaces)

```
junjo/
├── package.json              (workspaces config)
├── tsconfig.base.json        (shared TS config)
├── packages/
│   ├── server/               (HTTP API + SSE + webhooks)
│   │   ├── src/
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   ├── package.json
│   │   └── Dockerfile
│   ├── sdk/                  (@junjo/sdk — TS client)
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── react/                (@junjo/react — React hooks)
│   │   ├── src/
│   │   └── package.json
│   ├── sdk-roblox/           (Luau client; published to Roblox marketplace + GitHub)
│   │   ├── src/
│   │   └── README.md
│   └── shared/               (@junjo/shared — types shared between server + sdk)
│       ├── src/
│       └── package.json
├── apps/
│   ├── dashboard/            (admin + analytics dashboard, Next.js)
│   │   ├── app/
│   │   ├── components/
│   │   └── package.json
│   └── docs/                 (docs site — Docusaurus or Nextra)
├── examples/
│   ├── webgame-threejs/      (example: Three.js browser game using Junjo)
│   └── roblox-mobarena/      (example: linked or copied from mobarena-roblox)
└── docs/                     (the project context files you're reading)
```

Tooling:
- **Package manager:** npm workspaces (lowest setup cost; pnpm is overkill for this scale)
- **TypeScript:** strict mode, project references between packages
- **Build:** `tsup` per package (fast, dual ESM/CJS output)
- **Tests:** Vitest in every package
- **Lint/format:** Biome (replaces ESLint + Prettier; fast)
- **CI:** GitHub Actions (test + build on PR; release-please for versioning)

## Distribution

Open-core:
- **OSS:** `@junjo/sdk`, `@junjo/react`, `junjo-roblox`, and the `junjo-server` Docker image are all MIT-licensed and self-hostable.
- **Paid:** the managed cloud service (multi-tenant Supabase/Neon, admin dashboard, analytics, support).

Devs who want to self-host get full functionality minus the hosted dashboard. Devs who pay get the operational burden lifted plus dashboards and analytics.

## Things deliberately *not* in V1

- Multi-region deploys (single-region first; revisit at scale)
- Read replicas (Postgres on Supabase/Neon scales fine for the target traffic)
- gRPC (REST + SSE is enough for this domain)
- GraphQL (REST is simpler; no compelling reason to add)
- WebSockets (SSE handles the use case; WS adds connection-state complexity)
- Custom binary protocols (premature optimization)
- Rate-limiting beyond the basics (start with naive per-key limits; refine when needed)
