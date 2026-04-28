# 03 - Architecture

## Pattern: API-first, thin native SDKs

Same shape as Stripe, Auth0, Clerk, Supabase, Pusher, Twilio. The HTTP API is the source of truth. Every SDK is a thin client. Anyone can use raw HTTP if no SDK exists yet - that's the universal escape hatch.

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
- **Framework:** Hono or Fastify (TBD - both lightweight and fast)
- **Database:** Postgres only. Cloud uses Supabase or Neon. Self-host accepts `DATABASE_URL`.
- **ORM:** Prisma (matches PokeDnD pattern; schema-first; great DX for migrations)
- **Real-time:** Server-Sent Events. SSE hubs in `globalThis` for in-process broadcast. Cloud deploys as single-instance for V1 (same shape as PokeDnD on Railway).
- **Webhooks:** queued via Postgres advisory locks for ordering. HMAC-signed. Exponential-backoff retries up to 24 hours.
- **Auth verification:** all requests carry an API key (server-to-server) plus an end-user token (player session). The API key identifies the game; the end-user token is verified via the configured auth adapter.

### Server file layout

The `packages/server/src/` tree:

- `index.ts` - runnable entry point. Loads env, builds the app via `createApp()`, calls `serve()`, and registers SIGINT/SIGTERM handlers that disconnect Prisma cleanly.
- `app.ts` - exports `createApp(opts?)`. Builds a fresh Hono app per call, mounts middleware, and routes everything game-scoped under `/v1`. Tests use the same factory to boot a per-file app instance with injected fakes.
- `db.ts` - Prisma client singleton. Cached on `globalThis` outside production so `tsx watch` does not leak connections on hot reload. Exports `disconnectPrisma()`.
- `env.ts` - Zod-validated env loader. `loadEnv()` accepts an env object (defaults to `process.env`) and throws a single readable error listing every missing or invalid var.
- `errors.ts` - the server-side `JunjoError` class plus a small `Errors.*` factory for the canonical error codes (`not_found`, `invalid_api_key`, `bad_request`, `permission_denied`).
- `apiKey.ts` - API-key crypto: scrypt hash and verify, key generation, and the `prefix.secret` parser. Used by the apiKey middleware and the seed helper.
- `middleware/error.ts` - Hono `onError` handler. Renders `JunjoError` as JSON; logs anything else and returns the generic 500 envelope.
- `middleware/apiKey.ts` - extracts the `Authorization: Bearer prefix.secret` header, verifies the secret, and populates `c.var.gameId`. Accepts an injected `ApiKeyStore` rather than the full Prisma client so the middleware can be tested without a live database.
- `seed.ts` - importable helpers `createGame(name, prisma?)` and `createApiKey(gameId, prisma?)`. Used by tests and the `db:seed` CLI. The Prisma client is optional so callers can pass a client bound to `TEST_DATABASE_URL` or fall back to the singleton from `db.ts`.
- `seed.cli.ts` - thin CLI wrapper around `seed.ts`. Wired up as `npm run db:seed` for local-dev key issuance; prints the plaintext API key once and disconnects.
- `routes/` - per-resource route modules. Each module exports a `<resource>Router(prisma)` factory that returns a fresh `Hono` sub-app, plus a sibling `<resource>.schema.ts` of co-located Zod schemas. `app.ts` wires them under the `/v1` namespace. Resource modules that own only a few standalone handlers (rather than a self-contained sub-app) export `<verb><Resource>Handler(prisma)` factories that return a Hono `Handler`; `app.ts` registers them inline. Example: `routes/invitations.ts` exports `getInvitationByCodeHandler` (public, registered before the auth middleware), `deleteInvitationByCodeHandler` (authed), `acceptInvitationByCodeHandler` (authed), and `declineInvitationByCodeHandler` (authed), plus the wire-format helpers `serializeInvitation` and `generateInvitationCode` shared with the `POST /v1/groups/:id/invitations` handler in `routes/groups.ts`. `routes/members.ts` follows the same pattern: it exports the wire-format helpers (`serializeMember`, `WireMember`, `loadMemberRoleIds`, `batchLoadMemberRoleIds`, `batchLoadExternalUserIds`) used by the group-scoped member routes inside `routes/groups.ts` (`GET /:id/members`, `GET /:id/members/:userId`, and `PATCH /:id/members/:userId`), plus the standalone handler factories `getMemberByIdHandler` (`GET /v1/members/:id`) and `listMembersForUserHandler` (`GET /v1/users/:userId/members`) registered inline in `app.ts`.
- `softDelete.ts` - the soft-delete retention constant (7 days), `sweepHardDeletes(prisma, opts?)` (the actual delete query), and `startHardDeleteSweeper(prisma, opts?)` (the in-process scheduler). The runnable entry point (`index.ts`) is the only caller of `startHardDeleteSweeper`; tests exercise `sweepHardDeletes` directly without ever starting a timer.
- `identity.ts` - `findOrCreateJunjoUser(client, gameId, externalUserId)` (Phase 2.4 accept) and `findJunjoUserId(client, gameId, externalUserId)` (Phase 2.5 leave / kick). The find-or-create path resolves a dev's external user id to an internal `JunjoUser` id, creating both the `JunjoUser` and the `ExternalIdentity` row on first sight. The read-only find counterpart returns `null` when no `ExternalIdentity` row exists for the pair (callers translate that into a `404 not_found` on the consuming resource). Both helpers accept either the full Prisma client or a transaction client. Phase 6 (auth adapters) and Phase 10 (cross-game cloud) extend this pathway.

### Background sweeps

Soft-deleted Groups whose `softDeletedAt` is older than 7 days are removed by an in-process `setInterval` running inside the same Node process as the API. The interval is one hour; the sweeper is started by `startHardDeleteSweeper(prisma)` from `index.ts` after the HTTP server starts and stopped on `SIGINT` / `SIGTERM`. The handle is `unref`'d so the timer never keeps the process alive on its own.

We picked an in-process `setInterval` over a separate worker process or an external cron because:

- The sweep is a single `prisma.group.deleteMany({ where: { softDeletedAt: { lt: cutoff } } })` query. A separate process would add deployment surface (a second container, a second image, a second restart policy) for one query an hour. Bad trade at V1.
- Self-hosters get the sweep "for free" by running the same `junjo-server` Docker image they already run for the API. No second cron container to forget.
- `sweepHardDeletes` is exported separately from the scheduler so tests call it directly with a fixed `now`. The timer never fires during tests.

Trade: if the API is scaled horizontally to multiple instances later, every instance will run the sweep. The deleteMany is idempotent (rows already gone are silently skipped) so correctness is fine, but the work is duplicated. When that becomes a real scaling concern, factor the sweeper into a separate worker process with a `SELECT FOR UPDATE SKIP LOCKED` lease pattern. Keep the function signature stable so the scheduling layer is the only thing that changes.

### Public routes inside `/v1`

Most `/v1/*` routes require an API key (the API-key middleware is registered at the v1 sub-app and populates `c.var.gameId`). A small allowlist of public routes - currently just `GET /v1/invitations/:code`, used by an invite-acceptance UI before the player signs in - is registered **before** `v1.use("*", apiKeyMiddleware(store))`. Hono composes matched handlers in registration order; because the public handler returns a Response without calling `next()`, the auth middleware never runs on that path. The list of public routes lives in `app.ts`, not inside the middleware itself, so the auth code stays single-purpose. Adding a new public route is an explicit two-line registration (one line for the route, one line for the comment explaining why), not a config flag.

The `packages/server/prisma/` tree:

- `schema.prisma` - the single source of truth for the data model.
- `migrations/` - committed SQL migrations. Each migration is its own directory named `<UTC-timestamp>_<change>` containing `migration.sql`. `migration_lock.toml` pins the provider to `postgresql`. Migrations are immutable once committed; further schema changes land as new migration directories. Production deploys run `npm run db:migrate` (`prisma migrate deploy`). Local development runs `npm run db:migrate:dev` after editing `schema.prisma`. Tests reset with `npm run db:reset`. The Prisma client is regenerated by the server package's `postinstall` script so a fresh `npm install` yields a typecheck-ready tree.

## SDKs (V1)

### `@junjo/sdk` (TypeScript)

Universal client for Node + browser. Tree-shakeable. Zero runtime dependencies beyond `fetch` (built-in).

#### File layout

The `packages/sdk/src/` tree:

- `index.ts` - the `Junjo` top-level class. Constructs the shared `HttpClient` from `JunjoConfig` and instantiates each sub-namespace class (`GroupsApi`, `RolesApi`, ...). Re-exports the public types from `@junjo/shared`.
- `errors.ts` - the `JunjoError` class. Thrown by every method that talks to the server when the response is non-2xx; preserves the server envelope's `code`, `status`, and `message`.
- `http.ts` - shared `HttpClient`. Thin wrapper around `fetch` that injects the `Authorization` header, JSON-encodes bodies, parses responses, and turns non-2xx responses into `JunjoError`. Each sub-namespace class receives one via constructor.
- `<resource>.ts` - per-resource sub-namespace class plus its wire-format type and deserializer (e.g., `groups.ts` exports `GroupsApi`, `WireGroup`, and `deserializeGroup`). Wire types match the server's JSON exactly (timestamps as ISO strings); the deserializer rehydrates them into branded ids and `Date` instances at the boundary.
- `adapters/` - built-in auth adapters (Clerk, Supabase, JWT). Distributed under the `@junjo/sdk/adapters` subpath export so callers without those backends do not pay the install cost.

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

The single most important design decision. Auth is BYO - Junjo never replaces it.

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

The dev's existing identity provider remains the source of truth for users. Junjo just accepts whatever `userId` the adapter returns and treats it as an opaque string. No passwords, no email-verification flows, no OAuth - those all stay in the dev's auth provider.

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
│   ├── sdk/                  (@junjo/sdk - TS client)
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── react/                (@junjo/react - React hooks)
│   │   ├── src/
│   │   └── package.json
│   ├── sdk-roblox/           (Luau client; published to Roblox marketplace + GitHub)
│   │   ├── src/
│   │   └── README.md
│   └── shared/               (@junjo/shared - types shared between server + sdk)
│       ├── src/
│       └── package.json
├── apps/
│   ├── dashboard/            (admin + analytics dashboard, Next.js)
│   │   ├── app/
│   │   ├── components/
│   │   └── package.json
│   └── docs/                 (docs site - Docusaurus or Nextra)
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
