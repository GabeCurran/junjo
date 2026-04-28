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
- `routes/permissions.ts` - exports `resolvePermission(prisma, gameId, groupId, externalUserId, permission)` (the resolver: override beats role, role with priority desc, default for active members with no rule, none for non-active or non-members) and `checkPermissionHandler(prisma, opts?)` (the route factory for `GET /v1/permissions/check`). The handler reads through the `permissionCache` singleton on hit and runs the resolver on miss. Co-located Zod schema in `routes/permissions.schema.ts`.
- `routes/` - per-resource route modules. Each module exports a `<resource>Router(prisma)` factory that returns a fresh `Hono` sub-app, plus a sibling `<resource>.schema.ts` of co-located Zod schemas. `app.ts` wires them under the `/v1` namespace. Resource modules that own only a few standalone handlers (rather than a self-contained sub-app) export `<verb><Resource>Handler(prisma)` factories that return a Hono `Handler`; `app.ts` registers them inline. Example: `routes/invitations.ts` exports `getInvitationByCodeHandler` (public, registered before the auth middleware), `deleteInvitationByCodeHandler` (authed), `acceptInvitationByCodeHandler` (authed), and `declineInvitationByCodeHandler` (authed), plus the wire-format helpers `serializeInvitation` and `generateInvitationCode` shared with the `POST /v1/groups/:id/invitations` handler in `routes/groups.ts`. `routes/members.ts` follows the same pattern: it exports the wire-format helpers (`serializeMember`, `WireMember`, `loadMemberRoleIds`, `batchLoadMemberRoleIds`, `batchLoadExternalUserIds`, `serializeMemberPermissionOverride`, `WireMemberPermissionOverride`) used by the group-scoped member routes inside `routes/groups.ts` (`GET /:id/members`, `GET /:id/members/:userId`, `PATCH /:id/members/:userId`, the role-assignment pair `POST /:id/members/:userId/roles/:roleId` + `DELETE /:id/members/:userId/roles/:roleId`, and the permission-override trio `POST /:id/members/:userId/permissions/:permission` + `DELETE /:id/members/:userId/permissions/:permission` + `GET /:id/members/:userId/permissions`), plus the standalone handler factories `getMemberByIdHandler` (`GET /v1/members/:id`) and `listMembersForUserHandler` (`GET /v1/users/:userId/members`) registered inline in `app.ts`. `routes/roles.ts` mirrors the helper-plus-standalone-handlers shape: it exports `serializeRole`, `WireRole`, `loadRolePermissionKeys`, and `batchLoadRolePermissionKeys` (consumed by the inline `POST /v1/groups/:id/roles` and `GET /v1/groups/:id/roles` routes in `routes/groups.ts`), plus the standalone handler factories `getRoleByIdHandler` (`GET /v1/roles/:id`), `updateRoleByIdHandler` (`PATCH /v1/roles/:id`), `deleteRoleByIdHandler` (`DELETE /v1/roles/:id`), `grantPermissionHandler` (`POST /v1/roles/:id/permissions`), and `revokePermissionHandler` (`DELETE /v1/roles/:id/permissions/:permission`) registered inline in `app.ts`. The grant handler and the override-set handler both upsert a `PermissionDef (gameId, key)` row inside the same transaction that writes the join / override row, auto-registering each permission key into the per-game catalog on first sight (whether the key is first introduced via a role grant or a member override). The `routes/groups.ts` module also owns the bulk-invite handler (`POST /v1/groups/:id/bulk-invite`); it consumes a raw `text/csv` body, exports two limit constants (`BULK_INVITE_MAX_ROWS = 1000`, `BULK_INVITE_USERID_MAX_LENGTH = 255`), and parses input via a private `parseBulkInviteBody` helper that turns the body text into `{ rows, errors }` before the route runs its existence checks and creates invitations. The four group-relationship routes (`PUT /:a/relationships/:b`, `DELETE /:a/relationships/:b`, `GET /:a/relationships/:b`, `GET /:a/relationships`) live inline in `routes/groups.ts`; the wire-format helper `serializeGroupRelationship` and the `WireGroupRelationship` type live in `routes/relationships.ts` (no router, no standalone handler factory, just the serializer). The two sub-group hierarchy routes (`PUT /:id/parent`, `GET /:id/children`) also live inline in `routes/groups.ts`. Cycle detection on `setParent` walks the candidate parent's ancestor chain (one Prisma round-trip per level, bounded at the `MAX_PARENT_DEPTH = 100` constant in `groups.schema.ts`) and throws `parent_cycle` (400) if the child group itself appears anywhere in the chain (or if the candidate is the child). The `Group` wire format now carries `parentGroupId`; the shared `Group` type in `@junjo/shared` widened additively to include it.
- `softDelete.ts` - the soft-delete retention constant (7 days), `sweepHardDeletes(prisma, opts?)` (the actual delete query), and `startHardDeleteSweeper(prisma, opts?)` (the in-process scheduler). The runnable entry point (`index.ts`) is the only caller of `startHardDeleteSweeper`; tests exercise `sweepHardDeletes` directly without ever starting a timer.
- `identity.ts` - `findOrCreateJunjoUser(client, gameId, externalUserId)` (Phase 2.4 accept) and `findJunjoUserId(client, gameId, externalUserId)` (Phase 2.5 leave / kick). The find-or-create path resolves a dev's external user id to an internal `JunjoUser` id, creating both the `JunjoUser` and the `ExternalIdentity` row on first sight. The read-only find counterpart returns `null` when no `ExternalIdentity` row exists for the pair (callers translate that into a `404 not_found` on the consuming resource). Both helpers accept either the full Prisma client or a transaction client. Phase 6 (auth adapters) and Phase 10 (cross-game cloud) extend this pathway.
- `permissionCache.ts` - in-memory permission-check cache. Exports the `PermissionCache` class, the `PERMISSION_CACHE_TTL_MS = 60_000` constant, and a module-level `permissionCache` singleton. Cache keys are `(gameId, groupId, externalUserId, permission)`; entries expire on TTL or on `invalidateGroup(groupId)`. The check route (in `routes/permissions.ts`) reads and writes through this cache; mutation routes that can change a permission outcome (role assign / remove, role permission grant / revoke, member-level override set / clear, role delete) call `invalidateGroup` after their transaction commits. The cache is per-process and unbounded in size (entries expire naturally on TTL).
- `eventHub.ts` - in-process pub/sub bus for `JunjoEvent`s. Exports the `EventHub` class (per-`groupId` listener sets, `publish` fans out to every listener for the event's `groupId`, `subscribe` returns an idempotent unsubscribe closure, listener errors are swallowed so one bad subscriber cannot starve the others) and a module-level `eventHub` singleton. The SSE route (`routes/events.ts`) consumes the bus on the read side; mutation routes call `eventHub.publish(event)` after their transactions commit (Phase 5.1b wires this end-to-end via the `events.ts` helper module described next). Persistent / cross-process distribution is deferred to a future transport layer behind the same `EventHub` interface (Redis pub/sub, NATS, Postgres `LISTEN`/`NOTIFY`); the V1 hub is single-process by design.
- `events.ts` - construction-and-publish helpers shared by every mutation route. Exports `newEventId()` (24-char hex from `node:crypto`, used to stamp `event.id`), `publishEvent<E extends JunjoEvent>(hub, payload)` (auto-stamps `id` + `occurredAt`, calls `hub.publish`, returns the constructed event), `dispatchEvent<E>(prisma, hub, payload)` (the wrapper mutation routes actually call: publishes to the hub AND awaits `enqueueWebhookDeliveries(prisma, event)` so SSE subscribers and webhook consumers stay in lockstep), and a family of brand-cast converters (`toPublicGroup`, `toPublicMember`, `toPublicRole`, `toPublicInvitation`, `toPublicGroupRelationship`) that turn a Prisma row into the public `@junjo/shared` shape that the `JunjoEvent` payloads expect. The converters are pure brand-casts plus the `memberCount` / `roleIds` / `permissions` join columns that the public shapes carry; no field-name remapping happens.
- `webhooks.ts` - `enqueueWebhookDeliveries(prisma, event)` (looks up every active `WebhookEndpoint` whose `events` filter matches the published event and creates one `pending` `WebhookDelivery` row per match) and `serializeEventForStorage(event)` (the `JSON.parse(JSON.stringify(event))` round-trip that turns `Date` fields into ISO strings for `Prisma.InputJsonValue` storage). Consumed on the read side by `webhookWorker.ts`.
- `webhookWorker.ts` - the HTTP delivery worker. Exports `signWebhookBody(secret, body, timestamp)` (HMAC-SHA256 with the `v1=` scheme prefix; reused by the SDK's `webhooks.verify`), `deliverOne(prisma, deliveryId, fetch?, now?)` (loads one `pending` `WebhookDelivery`, signs + POSTs, transitions row state), `pollDueDeliveries(prisma, now, batchSize)` (returns the ids of pending rows whose `nextAttemptAt` has elapsed, oldest-first, capped at the batch size), `runWorkerOnce(prisma, opts?)` (poll + sequential delivery), and `startWebhookWorker(prisma, opts?)` (the `setInterval` scheduler, called from `index.ts`). The retry policy is exponential backoff (1m / 5m / 30m / 2h / 8h) up to `WEBHOOK_MAX_ATTEMPTS = 6` total attempts; 4xx (except 408 / 429) is treated as permanent failure, 5xx + network errors + 408 / 429 are retried until the cap. Reads `endpoint.secret` (renamed from `hashedSecret` in Phase 5.5; the column stores the HMAC key in recoverable form). Tests inject a fake `WebhookFetch` and a fixed `now` and never start a timer.
- `routes/webhooks.ts` - exports `webhooksRouter(prisma)` (a `Hono` sub-app mounted at `/v1/webhooks`), the wire-format helper `serializeWebhookEndpoint`, and the `generateWebhookSecret()` helper (32 random bytes -> base64url, used when the dev does not supply their own secret on create). Four routes: `POST /` (create with optional caller-supplied `secret`; the response is the only place `secret` is surfaced), `GET /` (list endpoints for the calling game, sorted newest-first; secret omitted), `PATCH /:id` (partial update of `url` / `events` / `disabled`, idempotent on no-op), `DELETE /:id` (hard delete; cascades to `WebhookDelivery` rows). Co-located Zod schema in `routes/webhooks.schema.ts` includes the `WEBHOOK_EVENT_TYPES` const enum (mirrors `JunjoEventType` in `@junjo/shared`) used to validate the events filter; unknown event types are rejected.
- `routes/events.ts` - exports `subscribeEventsHandler(prisma, opts?)` (the `GET /v1/events/:groupId` factory; `opts.hub` and `opts.heartbeatIntervalMs` are test seams threaded through `createApp({ events })`) and the `SSE_HEARTBEAT_INTERVAL_MS = 30_000` constant. The handler 404-collapses missing / cross-game / soft-deleted groups synchronously before upgrading to SSE, then uses Hono's `streamSSE` helper to write one frame per published event. Each frame carries the event's `id`, `type`, and a JSON-stringified payload as `data:`. A `:heartbeat` comment is emitted every `heartbeatIntervalMs` to keep intermediaries from idle-closing the connection. The handler `unref`'s the heartbeat timer and unsubscribes from the hub on `stream.onAbort`, so client disconnects deterministically clean up listener state and cancel the heartbeat.
- `routes/audit.ts` - the durable counterpart to `routes/events.ts`. Exports the `WireAuditEntry` type, the `serializeAuditEntry(row)` helper, and the `listAuditForGroup(c, prisma, groupId)` handler that powers the inline `GET /v1/groups/:id/audit` route in `routes/groups.ts`. Pagination is timestamp-based (`?before=<ISO>` is exclusive); the response's `nextCursor` is the ISO `createdAt` of the last item, fed back as `before` on the next call. The `?actions=` filter accepts the action enum (validated against the `AUDIT_ACTIONS` const list in `routes/audit.schema.ts`); repeating the query parameter ORs the values. Co-located Zod schema in `routes/audit.schema.ts`; the schema's `AUDIT_ACTIONS` const mirrors the `AuditAction` union in `@junjo/shared` and is the source of truth for the per-game action catalog.

### Real-time

Junjo emits a `JunjoEvent` whenever a group's state changes. Every consumer of those events (SSE clients, the future webhook delivery worker, audit log readers) reads through the same in-process `EventHub` (`eventHub.ts`). Two delivery surfaces share that bus:

- **SSE** (`GET /v1/events/:groupId`, this iteration): a long-lived HTTP stream for live UX. Transient and best-effort: events that arrive while no subscriber is connected are dropped. Heartbeat-padded so reverse proxies do not idle-close. The SDK's `groups.subscribe()` (Phase 5.1c) wraps this; any SSE-capable HTTP client can subscribe today.
- **Webhooks** (Phase 5.3 + 5.5): persistent fan-out to dev-configured HTTP endpoints. Backed by `WebhookDelivery` rows so retries and at-least-once semantics are durable across process restarts. Phase 5.3a (iteration 029) shipped the enqueue side: every published event also creates one `pending` row per matching `WebhookEndpoint`. Phase 5.3b (iteration 030) shipped the HTTP delivery worker (`webhookWorker.ts`): an in-process `setInterval` polls due `pending` rows every 5 seconds, signs each request with HMAC-SHA256 using the endpoint's secret, POSTs the JSON body, and transitions the row state based on the response. Retries follow exponential backoff (1m / 5m / 30m / 2h / 8h) up to 6 attempts; 4xx responses (except 408 and 429) are treated as permanent failure. Phase 5.5 (iteration 031) ships the dev-facing CRUD (`routes/webhooks.ts`) for configuring endpoints over the API and renamed the `WebhookEndpoint.hashedSecret` column to `secret` (the column always stored the HMAC key in recoverable form; the rename matches reality). The signing scheme and CRUD shape are documented at `apps/docs/pages/api/webhooks.mdx`.

The SSE-specific contract is documented in `apps/docs/pages/api/events.mdx`. Two things to know about the architecture:

- The hub is single-process. Two server processes do not share state. When the deployment scales horizontally, the hub interface is the seam where a transport-level bus (Redis pub/sub, NATS, Postgres `LISTEN`/`NOTIFY`) plugs in. The `EventHub` API does not change.
- Mutation routes call `dispatchEvent<E>(prisma, hub, payload)` after their transaction commits (the same after-commit pattern used by `permissionCache.invalidateGroup`). `dispatchEvent` is a thin wrapper in `events.ts` that calls `publishEvent` (which stamps `id` and `occurredAt` and invokes the hub) and then `await enqueueWebhookDeliveries(prisma, event)` so the durable webhook queue is written in the same logical step as the SSE broadcast. The hub is threaded into each mutation router via `createApp({ events: { hub } })` so tests can swap in a fresh `EventHub` without touching the singleton; production uses the module-level singleton. A crash between commit and dispatch loses the event for transient subscribers AND skips the webhook enqueue; we accept this best-effort property for V1 (the `audit.list` log captures every state change durably regardless).
- The publish-vs-mutation mapping is exhaustive: every mutation that has a corresponding case in the `JunjoEvent` union publishes, and every mutation that has no event-union case publishes nothing (`groups.create`, `members.setMetadata` / `setNotes`, `roles.update`, `members.overridePermission` / `clearPermissionOverride`, `invitations.decline` / `revoke`). The full table lives in `apps/docs/pages/api/events.mdx`. No-op routes (idempotent calls where nothing actually changed) skip the publish; this matches the audit-log convention.

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
- `http.ts` - shared `HttpClient`. Thin wrapper around `fetch` that injects the `Authorization` header, JSON-encodes bodies, parses responses, and turns non-2xx responses into `JunjoError`. Each sub-namespace class receives one via constructor. The default fast-path methods (`get` / `post` / `patch` / `put` / `delete`) JSON-encode the body and share the private `parseResponse` helper. `postRaw(path, body, contentType)` skips JSON encoding for endpoints that take non-JSON bodies (currently only `bulkInvite`'s `text/csv` payload) and reuses the same helper. `openStream(path, opts?)` does a streaming GET (used by `groups.subscribe()` for SSE) and returns the raw `Response` with its body still open; non-2xx responses still throw a `JunjoError` constructed from the same envelope shape, but successful responses are NOT consumed (the caller is responsible for `res.body?.getReader()`).
- `<resource>.ts` - per-resource sub-namespace class plus its wire-format type and deserializer (e.g., `groups.ts` exports `GroupsApi`, `WireGroup`, and `deserializeGroup`). Wire types match the server's JSON exactly (timestamps as ISO strings); the deserializer rehydrates them into branded ids and `Date` instances at the boundary.
- `events.ts` - SSE wire types (`WireJunjoEvent` and the per-event variants), `deserializeEvent(wire)` (rehydrates every nested `Date` and brand-casts every id), and `parseSSEFrame(block)` (parses one `event: / data: / id:` SSE block and skips comment-only frames). Consumed by `groups.ts`'s `subscribe()` method and by `webhooks.ts`'s `verify()`.
- `webhooks.ts` - two responsibilities. (1) The receiver-side helpers for inbound webhook deliveries: `WebhooksApi.verify(rawBody, headers, secret, opts?)` validates the HMAC signature and returns a parsed `JunjoEvent`; `WebhooksApi.middleware(secret, opts?)` returns an Express-compatible middleware that calls `verify`, replaces `req.body` with the typed event, and forwards to `next()`. Also exports `signWebhookBody(secret, body, timestamp)` (hex-encoded HMAC-SHA256 prefixed with `v1=`, mirrors the server worker), `verifyWebhook` (the standalone function form), and the `WEBHOOK_SIGNATURE_SCHEME` / `WEBHOOK_DEFAULT_TOLERANCE_MS` constants. Uses Web Crypto (`crypto.subtle.importKey` / `sign`) so the SDK stays runtime-portable across Node 19+ and browsers without picking up `@types/node`. (2) `WebhookEndpointsApi` - CRUD for webhook endpoints, reachable as `junjo.webhooks.endpoints.{create, list, update, delete}`. Wraps `POST/GET/PATCH/DELETE /v1/webhooks`; `create` returns `WebhookEndpointWithSecret` (the only place `secret` is surfaced); the other three return `WebhookEndpoint` without secret.
- `adapters/` - built-in auth adapters (Clerk, Supabase, JWT). Distributed under the `@junjo/sdk/adapters` subpath export so callers without those backends do not pay the install cost. `adapters/jwt.ts` exports `jwtAdapter(opts)` (Phase 6.1; backed by `jose` as a runtime dep): supports HS256 / RS256 / ES256 with PEM SPKI for the asymmetric paths, an injected `userIdClaim` (defaults to `sub`), optional `issuer` / `audience` validation, and an optional `clockToleranceSeconds`; misconfiguration (empty `key`, unsupported `algorithm`, malformed PEM) throws `JunjoError({ code: "invalid_config" })` while every legitimate verification failure (bad signature, expired, wrong `iss`/`aud`, missing claim) returns `null` so the caller treats unauthorized sessions uniformly. `adapters/clerk.ts` exports `clerkAdapter(opts)` (Phase 6.2; `@clerk/backend` is a peer dep, not a regular dep). The dev wraps `@clerk/backend`'s standalone `verifyToken` in the options bag and the adapter reads the user id from a configurable claim (defaults to `sub`). Throw-vs-null contract matches `jwtAdapter`: `JunjoError({ code: "invalid_config" })` if `verifyToken` is not a function; `null` for every legitimate verification failure (token empty, wrapper throws, payload missing `sub`, claim non-string). `adapters/supabase.ts` exports `supabaseAdapter(opts)` (Phase 6.3; `@supabase/supabase-js` is a peer dep, not a regular dep). The dev passes their constructed Supabase client directly via `opts.client` (rather than a function-shaped wrapper as on Clerk, because Supabase's `auth.getUser(token)` API has been stable across `@supabase/supabase-js` v2 releases). The adapter reads the user id from a configurable top-level field (`userIdField`, defaults to `"id"`); nested fields under `app_metadata` / `user_metadata` are intentionally not supported in V1 (devs wrap the client themselves, recipe in the docs page). Throw-vs-null contract matches the other two adapters: `JunjoError({ code: "invalid_config" })` if `client` is missing, `client.auth` is missing, or `getUser` is not a function; `null` for every legitimate verification failure (token empty, `getUser` throws, response carries `error`, `data.user` null, configured field missing / non-string / empty). No built-in cache.

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
const sub = await junjo.groups.subscribe(group.id, (event) => {
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

#### File layout

The `packages/react/src/` tree:

- `index.ts` - public exports. Re-exports `JunjoProvider`, `JunjoProviderProps`, `useJunjo`, `useGroup`, `UseGroupResult`, `GroupSnapshot`, `GroupUpdater`, `useCan`, `useMembers`, `UseMembersOptions`, `UseMembersResult`, `UseMembersStatus`, `MemberUpdater`, `useInvitations`, `UseInvitationsOptions`, `UseInvitationsResult`, `UseInvitationsStatus`, `InvitationUpdater`, `useAuditLog`, `UseAuditLogOptions`, `UseAuditLogResult`, `useMutation`, `UseMutationOptions`, `UseMutationResult`, and `MutationStatus`. Future hooks land here as they ship.
- `context.ts` - the module-private `JunjoContext` (a `React.Context<Junjo | null>`). Created with a `null` default so `useJunjo` can detect the "no provider in scope" case and throw a descriptive error rather than silently handing back a stub.
- `JunjoProvider.tsx` - the provider component. Takes `{ client: Junjo, children }`; renders the `Junjo` instance through `JunjoContext` and a fresh `PermissionCache` (one per `client` reference, via `useMemo`) through `PermissionCacheContext`. Naming the prop `client` (not `value`) matches the convention set by Stripe's `<Elements stripe={...}>` and Apollo's `<ApolloProvider client={...}>`.
- `useJunjo.ts` - the consumer hook. Reads from `JunjoContext` and throws when used outside a provider so descendants can rely on a non-null `Junjo` without their own null check.
- `useGroup.ts` - snapshot + live-stream hook for a single group. Issues `groups.get` and `members.list` in parallel on mount, then opens an SSE subscription via `groups.subscribe` and applies `member.joined` / `member.left` / `role.changed` / `group.updated` / `group.deleted` events to local state via a `useReducer`. Filters the initial roster to active members (status `"active"`); the rationale is that a roster panel is the dominant consumer pattern and members in non-active states should not appear in it. Returns `{ group, members, loading, error, refetch, applyOptimistic }`. A monotonic generation counter scopes fetch results so groupId changes and overlapping `refetch` calls cannot cross-contaminate. Streaming errors land in `error` without clearing the snapshot; the snapshot stays useful and the consumer can call `refetch` to reset. Subscription cleanup handles the case where the component unmounts before `subscribe` resolves: a cancellation flag closes the subscription on resolution. `applyOptimistic(updater): rollback` (Phase 7.5c) takes a `(prev: { group, members }) => { group, members }` updater and flips both fields atomically against a single captured snapshot. Two refs (`groupRef`, `membersRef`) mirror state and are read at apply-time so the function identity stays stable across renders. The reducer's `optimistic_apply` action collapses no-op updates (when both `next.group === prev.group` and `next.members === prev.members`) to skip the React re-render; `optimistic_rollback` does the same identity check before dispatching. Rollback restores `{ group, members }` verbatim; SSE events between apply and rollback are lost on rollback, matching the React Query snapshot-and-restore contract documented for `useMembers`. The single-method-with-snapshot design (rather than `applyOptimisticGroup` + `applyOptimisticMembers`) lets a mutation update both slices atomically (e.g., kick + bump `memberCount`) without an inconsistent intermediate state.
- `permissionCache.ts` - the module-private `PermissionCache` class plus `PermissionCacheContext` and the internal `usePermissionCache` hook. The cache holds three maps keyed by a `${userId} ${groupId} ${permission}` string: `entries` (resolved booleans), `inflight` (promises in flight, for deduplication), and `listeners` (per-key `Set<() => void>` for `useSyncExternalStore` notifications). `prefetch(key, fetcher)` returns the inflight promise if one exists; otherwise resolves from cache; otherwise fires the fetcher, stores success in `entries`, and notifies subscribers. Errors are NOT cached: the inflight slot releases on rejection so the next mount retries. `invalidate(key?)` clears either one entry or the whole cache and notifies subscribers; reserved for the Phase 7.5 reactive-invalidation layer.
- `useCan.ts` - the boolean permission check hook. Calls `useJunjo()` and `usePermissionCache()`, builds the cache key, fires `cache.prefetch(key, () => junjo.can(...))` from a `useEffect`, and reads the current value via `useSyncExternalStore(cache.subscribe, cache.get)`. Returns `boolean | undefined` (undefined while loading or after an error). The `useSyncExternalStore` server snapshot returns `undefined` since SSR cannot pre-fetch. The cache is shared across all `useCan` consumers under the same `JunjoProvider`, so duplicate `(userId, groupId, permission)` tuples deduplicate to one network call and any later mount with the same tuple sees the cached value synchronously.
- `useMembers.ts` - the paginated roster hook. Takes `(groupId, opts?: { status?, limit? })` and returns `{ members, loading, loadingMore, hasMore, error, refetch, fetchMore, applyOptimistic }`. The default filter is `status: "active"`; `"all"` returns every status, and the four `MemberStatus` values restrict to that single status. Filtering is client-side after each page (the server does not currently narrow by status). Pagination is cursor-based: `members.list(groupId, { limit? })` fires on mount; subsequent `fetchMore` calls forward `{ cursor, limit? }` and append new entries (deduplicated by `userId`). The hook splits its concerns across two effects: one re-runs `refetch` whenever `(junjo, groupId, status, limit)` changes; the other opens an SSE subscription tied to `(junjo, groupId)` only, so a status / limit change does not tear down the stream. Live events: `member.joined` (append or replace, filter-aware), `member.left` (remove regardless of filter), `role.changed` (merge added / removed in place); other event types are ignored. The subscribe handler reads the current matcher through a `matchesRef` that mirrors the latest filter, so an event that arrives after the consumer changed `status` uses the new filter. Subscription cleanup mirrors `useGroup`: a cancellation flag closes a subscription that resolves after unmount; `fetchMore` carries an inflight ref so concurrent calls dedupe to one network request. `applyOptimistic(updater): rollback` (Phase 7.5b) flips the local roster immediately - the hook reads the current `members` from a ref, dispatches an `optimistic_apply` reducer action that runs `updater(state.members)`, and returns a closure that dispatches an `optimistic_rollback` action with the captured snapshot. SSE events that arrive after the optimistic update layer on top via the existing reducer paths; rollback restores to the exact pre-update array (concurrent SSE events between `applyOptimistic` and the rollback are lost - matches React Query's snapshot-and-restore semantics; the user-facing docs page explains the mitigation). The reducer collapses no-op updaters and identical rollback snapshots back to the same state reference so React skips the re-render.
- `useInvitations.ts` - the paginated invitation-list hook. Takes `(groupId, opts?: { status?, limit? })` and returns `{ invitations, loading, loadingMore, hasMore, error, refetch, fetchMore, applyOptimistic }`. Status filter is `"pending" | "used" | "expired" | "all"` (default `"pending"`). Filtering combines two layers: the hook maps `status` to the inclusive `includeExpired` / `includeUsed` flags on `junjo.invitations.list` (so the server narrows the result set; the four mappings are documented in the user-facing docs page) and then applies a client-side matcher to drop rows the inclusive flags return alongside the requested ones (for example, asking for `used` requires `includeUsed: true` plus a client filter that drops the still-pending rows the server returns alongside used ones). Pagination, dedupe, and the split-effect / `matchesRef` design mirror `useMembers`; deduplication is by invitation `id`. Live events: `member.invited` (append or replace, filter-aware) and `member.joined` (transition any direct invitation in state with `targetUserId === event.userId && usedAt === null` into a used invitation - then re-apply the matcher to keep, update, or remove). Open-code invitations are NOT auto-updated on accept (the `member.joined` event does not carry the invitation id, so the hook cannot correlate); revoke and decline emit no events; expiration is not auto-tracked between user actions. All four limitations are documented in `apps/docs/pages/react/use-invitations.mdx` with the recommendation to call `refetch` after the corresponding mutation. Subscription lifecycle and cancellation mirror `useGroup` / `useMembers`. `applyOptimistic(updater): rollback` (Phase 7.5c) is a direct port of the `useMembers` shape: takes a `(prev: Invitation[]) => Invitation[]` updater, dispatches `optimistic_apply` against the snapshot read from an `invitationsRef`, and returns a closure that dispatches `optimistic_rollback` with the captured array. Same identity-equal short-circuit + LIFO concurrent-rollback semantics; same trade-off that intermediate SSE events are lost on rollback.
- `useAuditLog.ts` - the paginated audit-log hook. Takes `(groupId, opts?: { actions?, limit? })` and returns `{ entries, loading, loadingMore, hasMore, error, refetch, fetchMore }`. Unlike the other Phase 7.4 hooks this one does NOT open an SSE subscription: audit entries do not have a corresponding `JunjoEvent` payload that carries the audit-entry id, so the hook cannot synthesize new entries from `member.joined` / `role.changed` / etc. without diverging from the server's recorded entries. Live updates are refetch-driven only (consumers poll `refetch`, drive it from their own mutations, or wait for the post-V1 `audit.created` event). Pagination is timestamp-based: the server returns `nextCursor` as the ISO 8601 `createdAt` of the last item; the hook stores it as a string and converts to `Date` via `new Date(cursor)` when calling `audit.list({ before })` for the next page. Entries are deduplicated by `id` on append. The `actions` option uses a sort-stable cache key (`actions.slice().sort().join("|")`) so a content-equal-but-reference-different array (or a reordered array with the same membership) does NOT trigger a refetch; only a real membership change does. Empty `actions: []` is treated as "no filter" and omitted from the wire call. Standard generation counter scopes fetch results across overlapping `refetch` calls; standard inflight ref dedupes concurrent `fetchMore` calls.
- `useMutation.ts` - the generic mutation primitive (Phase 7.5a). Takes `{ mutationFn, onMutate?, onSuccess?, onError?, onSettled? }` and returns `{ mutate, mutateAsync, status, data, error, isIdle, isPending, isSuccess, isError, reset }`. Modeled on React Query's mutation API: `onMutate(vars)` runs before `mutationFn` and returns a typed `TContext` that threads through to `onSuccess`, `onError`, and `onSettled` - the canonical optimistic-update / rollback pattern. State transitions reflect only the **mutation's** outcome, not the callbacks': errors thrown inside `onSuccess` / `onSettled` propagate from `mutateAsync` but do not flip the state to `error` (the mutation itself succeeded). Errors thrown inside `onError` are caught and the original `mutationFn` error still propagates. `mutate` is fire-and-forget (never throws to the caller); `mutateAsync` returns `Promise<TData>` and rejects on failure. Multiple in-flight calls each run their full callback chain; only the latest call's outcome updates the hook state (a monotonic generation counter discards stale state updates). Callbacks are snapshotted at call time via `optionsRef`, so a re-render mid-flight does not redirect an in-flight mutation to the new callbacks. The hook does NOT touch existing list hooks - consumers wire optimistic snapshots themselves; Phase 7.5b/c will fold those snapshots into `useMembers` / `useInvitations` / `useGroup` directly.

The package depends on `@junjo/sdk` (regular dep, for the `Junjo` type) and declares `react` (^18 || ^19) as a peer dep. Tests run under Vitest with `environment: "jsdom"` and `@testing-library/react`; the vitest config (`packages/react/vitest.config.ts`) sets `esbuild.jsx: "automatic"` so `.tsx` test files transpile under the same JSX runtime as the source.

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
