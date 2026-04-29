# 05 - Decisions log

Running list of every meaningful decision made during scoping, with rationale. Add entries as new decisions are made; don't edit old ones (mark as "superseded by …" if a decision is reversed).

---

## 2026-04-19

### Project name: Junjo

**Decision:** the product is named **Junjo** (Japanese 順序, "order/sequence").

**Considered alternatives:**
- Lubeo (Latin "I command") - harder to pronounce, less memorable
- Jubeo (Latin variant) - same problem
- Aufgabe (German "task") - too consonant-heavy for international devs

**Why Junjo wins:** short, catchy, semantically maps to "proper order" which is what role/permission systems enforce. Slightly Japanese-loanword-flavored which fits the gaming aesthetic.

**Caveats:**
- Existing dev at `junjo.dev` is unrelated - different person, no collaboration. Worth noting for SEO confusion risk.
- npm package `junjo` is taken - we'll use scoped packages: `@junjo/sdk`, `@junjo/react`, `@junjo/roblox`. Need to register the `@junjo` org on npm, or fall back to `@junjo-dev`.
- Domain: `junjo.io` is available. Register before announcing anywhere.

### Backend stack: Node + TypeScript + Postgres + Prisma

**Decision:** Node + TypeScript + Postgres + Prisma. Same as PokeDnD.

**Rationale:**
- Gabe's strongest stack - fastest iteration
- PokeDnD (547 commits, real-time multiplayer, complex domain) proves this stack handles the workload
- Postgres + Prisma migration story is mature and well-understood
- When/if revenue justifies it, hot-path Go rewrite is an option - premature now

### Backend framework: TBD (Hono vs Fastify)

**Open question.** Both are lightweight and fast. Decide at scaffolding time. Likely Hono for edge-compatibility flexibility.

### API style: REST + SSE + webhooks

**Decision:** REST for CRUD, SSE for real-time push, webhooks for outbound events.

**Why not WebSockets:** SSE handles the use case with less connection-state complexity. Most "real-time" needs in this domain are server-to-client push, not bidirectional.

**Why not GraphQL:** REST is simpler, more familiar to game devs, easier to document. No compelling reason to add GQL complexity.

**Why not gRPC:** REST is enough. Game devs are not enterprise.

### Auth: BYO via adapter pattern

**Decision:** Junjo never replaces the dev's auth provider. Adapter pattern: `verifyToken(token) → { userId } | null`. Built-in adapters for Clerk, Supabase, raw JWT. BYO callback for everything else.

**Rationale:**
- Gabe's direct experience with Ory friction → strong evidence devs hate having auth dictated
- Doing one thing well and composing > trying to be everything
- Massive infra simplification: we don't store passwords, send emails, run OAuth flows, or handle account recovery

### Persistence: Postgres only

**Decision:** Postgres only. Self-host accepts `DATABASE_URL`. Cloud uses Supabase or Neon.

**Rejected:** MongoDB (different consistency model fragments codebase), SQLite (fine for tests, not production), Postgres-native API (overkill).

### V1 SDKs: TypeScript + Roblox/Luau

**Decision:** ship two SDKs at V1 launch - `@junjo/sdk` (TS, Node + browser) and `junjo-roblox` (Luau).

**Deferred:**
- Unity / C# (V2) - Unity Asset Store packaging is real work; wait for V1 traction signal
- Godot / GDScript (V3) - smaller market
- Unreal / C++ - never unless validated

**Why TS + Roblox first:**
- TS = Gabe's strongest language + biggest indie web audience (Three.js, Phaser)
- Roblox = he can dogfood with `mobarena-roblox` immediately, real first user from day one

### Core entity name: Group (not Guild)

**Decision:** the core entity is `Group` in the API. Devs set a `kind` string ("guild", "clan", "faction", etc.) for their UI.

**Why:** "Guild" leaks one game's vocabulary into the SDK. "Group" is generic enough to fit clans, factions, parties, crews, squads. The dev's UI shows whatever label they want.

### Group relationships are V1

**Decision:** include group-to-group relationships (`ally`, `enemy`, `neutral`, custom strings) in V1.

**Why:** Minecraft Factions, WoW horde-vs-alliance, faction-war PvP games all need this. Tiny data model. Big game-design unlock.

### V1 scope: everything (all-at-once release)

**Decision:** Gabe explicitly chose to ship the full V1 scope (including everything originally listed as V2) before public launch. Estimated 32-40 weekends, ~8-10 months at 1 weekend/week.

**Rejected alternative:** phased shipping (3-4 month v1.0 core, then monthly v1.1+ updates).

**Why all-at-once:** Gabe wants this to be a polished passion project, not a scrappy MVP. Accepts the longer time-to-launch.

**Risk:** scope creep + never shipping is the killer of 80% of side projects. **Mitigation:**
- Strict feature freeze 1 month before launch - no new features after that
- Real internal dogfooding via mobarena-roblox during development
- Use Revelations as a second dogfood target if it makes sense (TS SDK)
- Monthly progress check-in to prevent indefinite drift

### Monetization: open-core

**Decision:** OSS SDK + Docker server image (MIT) + paid managed cloud.

**Free tier limits:** 1 game, 100 monthly active members, 1 group max, 5 roles.

**Pricing tiers (proposed; tune after launch):** $20 / $100 / $500 / Enterprise.

**See [docs/04-monetization.md](./04-monetization.md) for full math.**

### Repo structure: monorepo with npm workspaces

**Decision:** single `junjo/` repo with `packages/` (server, sdk, react, sdk-roblox, shared) and `apps/` (dashboard, docs).

**Why monorepo:** atomic refactors across SDK + server when API shape changes. Shared types via `@junjo/shared`. Single CI pipeline.

**Why npm workspaces (not pnpm or Turborepo):** lowest setup cost. pnpm/Turborepo are overkill for ~6 packages. Revisit if build time becomes painful.

### Tooling

- TypeScript strict mode + project references
- `tsup` for builds (fast, dual ESM/CJS)
- Vitest for tests in every package
- Biome for lint + format (replaces ESLint + Prettier)
- GitHub Actions for CI
- `release-please` for versioning (or Changesets - TBD)

### Validation strategy: skipped

**Decision:** Gabe explicitly chose not to do a public validation post (Reddit, etc.).

**Reason given:** concern about idea theft via LLMs.

**Counter that was acknowledged but not adopted:** in dev tools, ideas are nearly worthless and execution is everything. Auth0/Stripe/Vercel weren't first to their categories.

**Implication:** we're betting on execution + dogfooding (mobarena-roblox) as the validation signal, not external interest. If the dogfooding doesn't surface real demand from the Roblox community, that's the first warning sign.

---

## 2026-04-27

### Backend framework: Hono

**Decision:** Hono for `packages/server`.

**Why:** lean, TS-first, pairs with the "thin focused API" philosophy. Edge-runtime flexibility kept open even though V1 ships single-instance Node. Fastify's plugin ecosystem isn't worth its extra ceremony for an API this focused.

**Trade:** thinner middleware ecosystem than Fastify. We'll write a bit more glue (rate-limiting, observability hooks). Acceptable at this scale.

### Versioning: Changesets

**Decision:** Changesets for monorepo versioning + changelog generation.

**Why:** de-facto standard for TS monorepos (pnpm, Vercel, tRPC, Astro all use it). The per-PR changeset file is small friction that yields materially better changelogs than release-please's commit-message-driven output. SDK users actually read changelogs to decide on upgrades; quality matters there.

**Config:** `access: "public"`, `baseBranch: "main"`. `apps/*` and `examples/*` are ignored (cloud-only and example apps don't get versioned releases).

### Docs site: Nextra

**Decision:** Nextra for `apps/docs`.

**Why:** same Next.js stack as `apps/dashboard`, so one framework knowledge for both apps. MDX, search, sidebar built-in. Docusaurus is the safe-but-old choice and brings its own React/build pipeline. Plain Next.js is too much custom work.

**Trade:** no versioned-docs UI out of the box. Defer that until V2 (V1 ships one version of the docs).

### Cloud-only code license: proprietary / All Rights Reserved

**Decision:** `apps/dashboard` and any cloud-only server modules are "All Rights Reserved" via `apps/dashboard/LICENSE` + a `license` field in `package.json`. They live in the public monorepo (visible) but are not legally reusable.

**Why:** simplest option that prevents the AWS-fork scenario. BSL (Sentry/HashiCorp model) adds licensing-language complexity for zero benefit until someone is actually trying to fork-and-resell, which is a Year-3 problem at the earliest. Proprietary is reversible (can move to BSL or even MIT later); BSL is harder to walk back.

### Type-checking split: Biome + tsc

**Decision:** Biome for lint + format. `tsc --noEmit` per package for type-checking. Separate steps in CI.

**Why:** Biome doesn't yet do TS type-checking. This is the standard pattern for Biome shops.

### Package naming

**Decision:** `packages/sdk` (publishes `@junjo/sdk`), `packages/react` (publishes `@junjo/react`), `packages/sdk-roblox` (Roblox marketplace + GitHub release; not on npm).

**Why:** TS is the canonical SDK, so no language suffix. Same pattern as Stripe (`stripe` on npm = the Node/TS SDK; `stripe-go`, `stripe-python` get explicit suffixes). Roblox is the outlier because it isn't on npm - different distribution channel justifies the suffix.

**Supersedes:** the earlier `packages/sdk-ts` reference in `README.md`. README updated this date.

---

## 2026-04-28

### Server test fixture: `TEST_DATABASE_URL` env var (not testcontainers)

**Decision:** server-side tests that need a database read a connection string from `TEST_DATABASE_URL`. Tests fail fast with a clear error if the env var is unset. We do NOT depend on `testcontainers` for V1.

**Rationale:**
- Docker is not a guaranteed dependency on Windows dev machines or in the current overnight loop runner. Hard-requiring it would block iterations whenever Docker Desktop is not running.
- A single shared local Postgres (the dev brings up however they like - Docker, Postgres.app, Supabase local, etc.) is meaningfully faster per test run than spinning up a fresh container.
- The cost of swapping in `testcontainers` later is small: it would replace the env-var resolution inside `packages/server/src/testdb.ts` and nothing else.

**Trade:** developers must set `TEST_DATABASE_URL` once locally. A short-lived setup pain in exchange for not coupling the test step to Docker.

**Caveats:**
- Tests truncate / reset the schema between files. Anyone pointing this env var at a database with real data will lose it. The README warns about that.
- Revisit when there is a second human running tests regularly, or when isolation across parallel test suites becomes a real problem.

### API key format: `prefix.secret`, scrypt-hashed at rest

**Decision:** API keys are issued as `{prefix}.{secret}`. The prefix is stored in plaintext (and indexed) for O(1) lookup; the secret is hashed with Node's built-in `scrypt` and stored as `scrypt$<salt-b64>$<key-b64>`. The plaintext secret is shown to the developer once, at issuance, and is never recoverable from the database.

**Rationale:**
- A database leak should not be sufficient to act as the developer. Plaintext secrets fail that bar.
- `scrypt` is built into Node's `crypto`, so this adds no new dependency. `argon2` and `bcrypt` would both pull in native bindings.
- The `prefix.secret` split lets the lookup path be exactly one indexed query plus one scrypt verify. Trying every row is not on the table.
- The stored format is self-describing (`scrypt$...`) so a future move to argon2 or a parameter bump can coexist with old hashes.

**Trade:** scrypt CPU cost is non-trivial per request (single-digit ms). Acceptable for an API-key path that is hit once per request and is also a candidate for caching later if it shows up in profiles.

### Server middleware uses dependency-injected stores

**Decision:** server middleware that needs to talk to the database accepts a small store interface, not the full `PrismaClient`. Production wiring (in `createApp()`) builds the store from the singleton client; tests inject an in-memory fake.

**Rationale:**
- Phase 0.2 ships before Phase 0.3 (the first migration), so middleware tests cannot rely on a live schema yet. DI lets the logic be tested today and rewired tomorrow when the migration lands.
- Even after migrations land, the fake-store path stays useful for fast unit tests that do not need to exercise SQL.
- The interface is intentionally narrow (one or two methods per middleware) so the cost of keeping it in sync is small.

**Pattern:** see `packages/server/src/middleware/apiKey.ts` (`ApiKeyStore`) and `packages/server/src/app.ts` (default wiring).

### Server `createApp()` factory returns a fresh Hono app per call

**Decision:** the runnable entry point (`src/index.ts`) calls a `createApp(opts?)` factory exported from `src/app.ts` rather than constructing the app at module load. Tests call the same factory to boot a per-file app instance.

**Rationale:** lets each test file own its own Hono instance, its own middleware wiring, and its own injected stores without globals leaking across files. Matches the "Server tests use a real Postgres test database... one container per test run" convention in `VISION.md` while leaving room for the in-memory fake-store path described above.

### `prisma generate` runs as a `postinstall` script in `@junjo/server`

**Decision:** `packages/server/package.json` includes `"postinstall": "prisma generate"`. A fresh clone running `npm install` therefore ends up with a generated Prisma client without any manual follow-up step.

**Rationale:**
- The typecheck step imports types from `@prisma/client`. Without a generated client the type information is empty, breaking `tsc --noEmit` in `packages/server` and any downstream package that re-exports from it.
- `prisma generate` is idempotent and fast (sub-second), so paying it on every install is cheap.
- Deferring it to a manual `npm run prisma:generate` was the previous policy; iteration 002's notes flagged that the first migration iteration should wire it up automatically because that is the moment fresh-clone reproducibility starts to matter.

**Trade:** if `prisma generate` ever fails (corrupt schema, unsupported Node version), `npm install` fails too. Acceptable: a broken schema should fail loudly at install time, not silently produce a tree that fails much later in `tsc`.

### Database commands live behind named `npm run db:*` scripts

**Decision:** the developer-facing database commands are spelled `npm run db:migrate` (deploy applied migrations), `npm run db:migrate:dev` (create + apply a new migration after a schema edit), and `npm run db:reset` (drop + reapply every migration; skip seed). All live in `packages/server/package.json`.

**Rationale:** the underlying `prisma migrate ...` invocations are easy to mistype and the wrong subcommand can do real damage. Naming them once, in the package that owns the schema, makes the README short and the CI / Docker / overnight-loop calls consistent. The same names also mirror what self-hosters will see in the eventual deploy-time docs (`npm run db:migrate` is what the Docker entrypoint will call).

**Trade:** one more abstraction layer. Worth it for the consistency win and to avoid the `prisma migrate dev` vs `prisma migrate deploy` confusion that bites Prisma newcomers.

### Seed helpers accept an optional Prisma client; CLI lives in a sibling file

**Decision:** `packages/server/src/seed.ts` exports `createGame(name, client?)` and `createApiKey(gameId, client?)` as plain async functions whose second argument is an optional `PrismaClient`. The runnable CLI lives at `packages/server/src/seed.cli.ts` and is wired up as `npm run db:seed`. `seed.ts` itself has no top-level side effects.

**Rationale:**
- VISION calls out that the helpers serve "tests + local dev." Tests need to pass a `PrismaClient` bound to `TEST_DATABASE_URL`; the local-dev path wants the singleton from `src/db.ts`. Optional second arg supports both without two function shapes.
- Splitting the runnable CLI into a sibling file (instead of gating with `import.meta.url === pathToFileURL(process.argv[1]).href`) keeps `seed.ts` purely importable. No "is this the entry point" branch to reason about and no risk of CLI side effects firing during a test import.
- The CLI prints the plaintext secret exactly once with a comment that it cannot be recovered later, matching the `prefix.secret` decision (2026-04-28).

**Trade:** two files instead of one. Negligible cost; the CLI body is ~30 lines.

### Group default visibility is `invite-only`

**Decision:** when `POST /v1/groups` is called without a `visibility` field, the server stores `"invite-only"`. The same default applies in the SDK type (`CreateGroupInput.visibility` is optional).

**Rationale:**
- "Invite-only" is the safest of the three options. A new guild that accidentally lands as `"public"` is a privacy regression for the dev's players; a new guild that lands as `"invite-only"` and needs to become public is a one-line dev-side update. Default to the strict end.
- Most genre conventions match: WoW guilds, Discord servers, and Minecraft factions are all "you join because someone let you in" by default.
- A `"secret"` default would be too restrictive (the dev cannot list groups in their own UI without extra plumbing).

**Trade:** devs who want every group public will set `visibility: "public"` explicitly. One extra field per call is cheap.

### Group wire format: ISO 8601 strings on the wire, `Date` in the SDK

**Decision:** the JSON body returned by `POST /v1/groups` (and every future Group-emitting route) carries timestamps as ISO 8601 strings. The SDK rehydrates them into `Date` instances inside `deserializeGroup` (in `packages/sdk/src/groups.ts`). The shared type `Group.createdAt: Date` describes the SDK-side shape; the wire-side `WireGroup` interface is a parallel type local to the SDK.

**Rationale:**
- JSON has no native date type. Serializing dates as ISO 8601 strings is the standard wire choice (and `JSON.stringify(new Date())` already does it).
- Keeping the wire type separate from the user-facing `Group` lets us surface dates as `Date` without forcing the server route to invent a non-JSON encoding.
- Branded ids are reattached at the same boundary (`as GroupId`, `as GameId`) so callers never have to cast in user code.

**Trade:** every resource that has timestamps needs a small `deserializeX` function in its sub-namespace file. Cheap; pays for itself the first time a caller does `group.createdAt.getTime()` without ceremony.

### Server route modules use a `Router(prisma)` factory shape

**Decision:** route modules under `packages/server/src/routes/` export a factory function that takes the shared `PrismaClient` and returns a fresh `Hono` sub-app. `app.ts` calls each factory once per `createApp()` invocation and mounts it under the right path. Co-located Zod schemas live in a sibling `<resource>.schema.ts`.

**Rationale:**
- Mirrors the dependency-injection pattern already used by the API-key middleware (`apiKeyMiddleware(store)`). One pattern across the file tree, one less thing to remember.
- Tests that pass an injected `PrismaClient` to `createApp({ prisma })` get the same client all the way down to the route handlers without globals.
- Co-locating Zod schemas in `<resource>.schema.ts` keeps the route file readable and makes the schema importable by future client-side validation if we ever want it.

**Trade:** one extra layer of indirection (the factory). Negligible cost; opens the door for per-resource feature flags or test doubles later without rewriting handlers.

### SDK splits sub-namespaces into per-resource files; shared `HttpClient` is injected

**Decision:** `packages/sdk/src/index.ts` no longer holds every sub-namespace class. As each namespace lands real (non-stub) methods, it moves into its own file (`groups.ts`, `roles.ts`, ...) and receives the shared `HttpClient` via constructor. `JunjoError` lives in `errors.ts`. Stubbed namespaces stay inline in `index.ts` until they get filled in. The `Junjo` constructor wires `HttpClient` into every namespace that has been extracted.

**Rationale:**
- The convention from VISION says "Sub-namespace classes receive the shared HTTP helper via constructor. The `Junjo` top-level class wires them up." This decision says how that splits across files in practice.
- Putting all wire types and deserializers in `index.ts` would explode it as Phase 1+ adds methods. One file per namespace keeps each file small enough to read end-to-end.
- Splitting only when a namespace gets real methods avoids churn: the stub-only `RolesApi`, `MembersApi`, etc. stay inline in `index.ts` until their phase ships and they need the HTTP client.

**Trade:** index.ts and per-namespace files both define classes. Acceptable; `index.ts` is the public entry and per-namespace files are the implementation modules it imports from.

### Server vitest runs files serially (`fileParallelism: false`)

**Decision:** `packages/server/vitest.config.ts` sets `test.fileParallelism: false`. DB-backed test files stay isolated by truncating shared tables in `beforeEach`; running them in parallel races those truncates against each other. Serializing files keeps the fixture story simple.

**Rationale:**
- The simplest alternative (one Postgres database per test file) would push the per-file setup cost from milliseconds (truncate) to seconds (database-create + migrate). Bad trade for a 7-file suite.
- A separate Postgres schema per file would work but adds a `?schema=...` query-param dance to every test's `PrismaClient` construction. The truncate strategy is what `seed.test.ts` already established; serializing files preserves that pattern as more route tests land.
- Throughput cost is negligible: the whole server suite runs in under 8 seconds with serialization on, dominated by scrypt verifies in the API-key tests.

**Trade:** if the suite grows past ~30 seconds, revisit. Per-file Postgres schemas are the next step; the file-level truncate code stays the same.

### DB-backed tests skip cleanly when `TEST_DATABASE_URL` is unset

**Decision:** integration tests that require a live Postgres (currently `src/seed.test.ts`) wrap their `describe` block in `describe.skipIf(!process.env.TEST_DATABASE_URL)` and instantiate their own `PrismaClient` from the env var, instead of importing the singleton.

**Rationale:**
- The verify gate runs `npm test` with `--passWithNoTests`. If `TEST_DATABASE_URL` is unset, DB-backed tests must skip rather than error so the gate stays green for contributors who have not set up Postgres yet.
- Importing the singleton from `src/db.ts` would force DB-backed tests to either depend on `DATABASE_URL` (different env var) or to pollute the singleton with the test URL. Local instantiation keeps the test self-contained and disconnects in `afterAll`.
- Reset-between-tests is `TRUNCATE TABLE "ApiKey", "Game" RESTART IDENTITY CASCADE` rather than `prisma migrate reset`. Truncate is sub-10ms; `migrate reset` is multi-second. The migration story is exercised once at fixture setup time (the developer runs `npm run db:migrate` against `TEST_DATABASE_URL` once); per-test isolation is just row cleanup.

**Trade:** two ways to talk to the DB in test code (singleton for app tests, locally-instantiated client for DB-direct tests). The split mirrors the production reality (app code uses the singleton; one-off scripts and tests can open their own connection) so it is not extra cognitive load.

### `groups.get` returns `null` on 404; non-404 errors throw

**Decision:** `junjo.groups.get(id)` returns `Group | null`. The SDK catches the server's `404 not_found` response and returns `null`. Every other non-2xx (`invalid_api_key`, `internal`, network failure, etc.) is rethrown as `JunjoError`. The same pattern will apply to other "lookup" methods: `members.get`, `invitations.get`, `roles.get`, etc.

**Rationale:**
- "Does this group exist?" is a normal query for any UI that renders a group page from a URL slug. Forcing the caller to wrap a singular `get` in a try/catch to handle the not-found case is the worst kind of ergonomic friction; this is exactly the case `null` is for.
- Non-404 errors are categorically different (the request shouldn't have been sent, or the server is broken). Those need to surface, not collapse into `null`.
- Server-side, the route returns `404` for three distinct cases (no row, soft-deleted row, cross-game row) so existence is not leaked across game boundaries. The SDK does not need to distinguish them; "not visible to this caller" is the only fact the caller can act on.

**Trade:** other lookup methods must follow the same `Result | null` shape for consistency. Bulk endpoints (`list`) keep throwing because their not-found case is "empty page", not `null`. Stubs in `index.ts` for `roles.get`, `members.get`, `invitations.get` already declare `Promise<X | null>`; this decision locks that as the convention.

### Group route module returns active `memberCount` from a separate count query

**Decision:** `GET /v1/groups/:id` returns the wire `Group` with `memberCount` set to a live `prisma.groupMember.count({ where: { groupId, status: "active" } })` query, rather than a denormalized counter on the `Group` row. `POST /v1/groups` continues to return `0` since no members exist at creation time.

**Rationale:**
- A separate count query is one extra round-trip on a path that is read-far-more-often-than-it-changes. Postgres `count` against the existing `(groupId, status)` index is sub-millisecond at any realistic group size.
- A denormalized counter on `Group` would need to be incremented/decremented inside every member-mutating transaction (join, leave, kick, accept-invitation, soft-delete, etc.). The number of write paths that would have to remember to update it grows with every Phase-2 feature; a separate count query has zero such coupling.
- If the count query ever shows up in profiles, the fix is local: add a denormalized counter or a materialized view, behind the same wire field. Callers do not need to change.

**Trade:** the wire format never advertises whether `memberCount` is real-time or cached; future caching layers can stay invisible to the SDK.

### `groups.list` ordering: `createdAt desc, id desc` with manual cursor pagination

**Decision:** `GET /v1/groups` orders by `createdAt desc` with `id desc` as a deterministic tiebreaker. The cursor is a group id; the handler does a `findFirst({ where: { id: cursor, gameId } })` to read the cursor row's `createdAt`, then filters subsequent rows with `(createdAt < cursorCreatedAt) OR (createdAt = cursorCreatedAt AND id < cursorId)`. The cursor lookup does NOT exclude soft-deleted rows, so a soft-deletion of a previously-paged item does not break pagination; the row is still a valid sort position. Cursor rows in a different game return `400 bad_request`.

**Rationale:**
- A pure `createdAt desc` sort produces non-deterministic ordering when multiple groups share a timestamp, which can cause the same row to appear on two pages or be skipped during pagination. The `id desc` tiebreaker, applied via a Prisma `orderBy` array, makes ties resolvable without exposing them to callers.
- The manual `(createdAt, id) <` filter (instead of Prisma's `cursor` + `skip: 1` field) makes the comparison explicit and avoids Prisma's cursor semantics, which require the cursor row to be present in the result set. Manual filtering lets the cursor row be soft-deleted (or filtered out by future where-clauses) without breaking the next page.
- Looking the cursor up under `gameId` (but not `softDeletedAt`) preserves the tenancy boundary while keeping pagination resilient. A caller from game A passing a cursor from game B gets `400` rather than a silent no-op or an info leak.

**Trade:** the cursor is opaque only by convention; it is just a group id. A caller could observe that consecutive cursors are real ids, but nothing useful follows from that. If we ever want signed cursors (e.g., to encode a timestamp directly so we can drop the lookup query), the wire shape stays the same.

### `gameId` query param on list endpoints must equal the calling game's id

**Decision:** `GET /v1/groups` accepts an optional `?gameId=` query parameter. If provided, the handler asserts it equals `c.var.gameId` (the API key's game) and returns `400 bad_request` otherwise. The query parameter is purely a no-op assertion in V1.

**Rationale:**
- VISION wording (`"Optional ?gameId filter (defaults to the calling game's id)"`) anticipates future cross-game admin endpoints, but the V1 OSS API is strictly single-tenant per API key. Allowing a non-matching `gameId` would be a tenancy leak.
- Rejecting (rather than silently scoping to the calling game) makes mistakes loud: a caller who thinks they are listing a different game's groups gets an error rather than the wrong dataset.
- The same convention will apply to every other list endpoint that ever takes a `gameId` query parameter (members.listForUser, audit.list, etc.) until a cloud-only admin layer relaxes it.

**Trade:** cloud-only admin tooling that wants cross-game listing has to use a separate endpoint (or a different middleware that elevates the gameId check). That is the right place for that policy to live anyway.

### `groups.list` batches `memberCount` via a single `groupBy` query

**Decision:** the list handler issues one `prisma.groupMember.groupBy({ by: ["groupId"], where: { groupId: { in: ids }, status: "active" }, _count: { _all: true } })` after the page query, instead of N `count` queries (one per group) or a Prisma `_count` include with a relation filter.

**Rationale:**
- The `findFirst`-with-a-relation-filter `_count` approach (`include: { _count: { select: { members: { where: { status: "active" } } } } }`) is generally available in Prisma 5, but the explicit `groupBy` is unambiguous, version-resilient, and produces a single SQL `GROUP BY`. The SQL is what we'd write by hand: `SELECT "groupId", COUNT(*) FROM "GroupMember" WHERE "groupId" = ANY($1) AND "status" = 'active' GROUP BY "groupId"`.
- N separate counts is N round-trips for a single page render. Unacceptable for a list endpoint that is going to be called whenever a dashboard renders.
- The result is mapped into a `Map<groupId, count>` and applied at serialize time, so `serializeGroup` keeps its existing `(group, memberCount)` signature and the create/get/list paths share one wire-format builder.

**Trade:** if a page of 50 groups has 50 distinct member counts, we are sending one extra SQL round-trip after the page query. Two queries total (or three with a cursor lookup). Constant, not page-size-proportional.

### `groups.update` PATCH semantics: partial body, empty rejected, at least one field required

**Decision:** `PATCH /v1/groups/:id` accepts a partial body with any subset of `{ name, visibility, metadata, defaultRoleId }`. The body is rejected with `400 bad_request` ("at least one field is required") when no recognized field is provided. `defaultRoleId` is the only nullable field on update: passing `null` clears it, passing a string sets it, omitting the key leaves it alone. The same convention will apply to every other PATCH endpoint going forward.

**Rationale:**
- Empty PATCH bodies are almost always a bug on the caller side (forgot to populate the request, omitted the field name, etc.). Returning `400` makes the failure loud rather than silently rounding to a no-op.
- Tri-valued fields (set / clear / leave) need a way to express "clear" without overloading "leave alone". Using `null` for clear and `undefined` (omitted) for leave-alone is JSON-native and matches the type signature `defaultRoleId?: string | null`. The Zod schema uses `.nullable().optional()` to encode this exactly.
- The "partial body, only the listed fields are touched" rule is the standard PATCH semantic. PUT (full replace) was rejected because it would force callers to round-trip every field on every edit, with no benefit; the Group surface is too wide for that to be ergonomic.

**Trade:** there is no way to "unset" `name` or `visibility` (those are non-nullable on the model). That is correct: a group must always have a name and visibility. If a future field is genuinely tri-valued (rare), follow the `defaultRoleId` precedent.

### `groups.update` writes no audit entry when the patch is a no-op

**Decision:** `PATCH /v1/groups/:id` only writes a `group.updated` audit entry when at least one field actually differs from its stored value. The route compares each provided field against the existing row inside the transaction; if every field matches, both the `prisma.group.update` call and the `auditEntry.create` call are skipped. The route still returns `200 OK` with the unchanged group; `updatedAt` stays at its prior value. The audit `payload` is `{ before, after }` containing only the fields that actually changed.

**Rationale:**
- The audit log is a record of changes, not of API calls. Recording "user PATCHed but nothing changed" entries would dilute the log and make it harder to answer "when did this group's name change?".
- Only including changed fields in `before/after` keeps the diff readable. A diff that lists every patchable field with `before === after` for most of them buries the real change.
- Skipping the `prisma.group.update` call when `data` is empty avoids accidentally bumping `updatedAt` for a no-op. `updatedAt` is observable on the wire and is treated as a "last meaningful change" timestamp downstream.

**Trade:** metadata is the one exception. Whenever `metadata` is provided, it is treated as a change (and so triggers `data.metadata = ...` and an audit entry), even if the new object is structurally equal to the stored one. Deep-equality on JSON is unreliable across `jsonb` storage (key order may not be preserved) and the cost of getting it wrong (false-positive audit entry, false `updatedAt` bump) is small. Documented in the API doc and the SDK doc so callers are not surprised.

### `groups.update` metadata is replaced wholesale, not deep-merged

**Decision:** `PATCH /v1/groups/:id` with a `metadata` field replaces the entire stored metadata object with the supplied one. The server does not merge keys from the existing object into the new one. Callers that want merge semantics must read the current metadata first and merge client-side before calling update.

**Rationale:**
- Deep-merge semantics for nested JSON are ambiguous (how are arrays merged? are `null`s deletes?). REST PATCH conventions vary; we picked the simpler one.
- Wholesale replacement matches the way the rest of the field surface works: `name`, `visibility`, `defaultRoleId` all replace whatever was there. Picking a different rule for `metadata` would be surprising.
- If the client wants atomic compare-and-merge later, that is a different operation (e.g., a JSON Patch endpoint or an HTTP `If-Match` header). The wire shape stays compatible.

**Trade:** callers cannot patch one key of metadata without resending the others. Acceptable for a free-form bag that the dev controls; the dev can structure their reads/writes around it.

### `groups.delete` and `groups.restore`: 7-day soft-delete window with `?hard=true` escape hatch

**Decision:** `DELETE /v1/groups/:id` defaults to a soft delete that stamps `softDeletedAt = now()`. The row is invisible to `GET` and `LIST` but stays in Postgres for 7 days; `POST /v1/groups/:id/restore` clears `softDeletedAt` if called inside that window. After 7 days a background sweeper hard-deletes the row. `?hard=true` on the DELETE bypasses the grace period and removes the row immediately. Soft delete on an already soft-deleted group is idempotent (no second audit entry, no `softDeletedAt` bump, no `updatedAt` bump). Restore on a live group is also idempotent. Restore outside the 7-day window returns `410 Gone` with code `restore_window_expired`.

**Rationale:**
- "Undo" is the single most common ask after "I deleted the wrong thing". A 7-day window is long enough to span a weekend and a Monday-morning realization but short enough that orphaned rows do not accumulate indefinitely.
- A separate `restore` endpoint keeps the surface symmetric with `delete`. PUTting a `softDeletedAt: null` payload to update would also work but conflates "edit a field" with "undo a destructive action"; the audit log loses signal that way.
- Idempotency on both ends matches normal REST expectations: deleting an already-deleted thing is success, not failure; restoring a not-deleted thing is success, not failure. Loud failures are reserved for "the row is past the recovery point" (`410`).
- Hard delete is the right escape hatch for "I genuinely want this row and its history gone right now" (GDPR erasure, accidentally-leaked secret in metadata, dev-doing-a-cleanup). Cascade rules already handle the cross-table fan-out, so the implementation is one `prisma.group.delete` call.
- `410 Gone` is the semantically correct status for "this resource existed but is deliberately unrecoverable now"; `404 Not Found` would conflate it with "never existed". A new error code (`restore_window_expired`) lets clients branch on the specific reason rather than parsing the message.

**Trade:** the audit table cascades on group hard-delete, so the `group.deleted` audit entry written at soft-delete time is also gone after the sweeper runs. Acceptable: the audit log's purpose is to answer "what happened while the group existed", not "what was every group that ever existed". If a future compliance need demands a permanent tombstone, a separate `DeletedGroup` table can hold the metadata; the route shape stays compatible.

### Hard-delete sweeper runs in-process via `setInterval`, not as a separate worker

**Decision:** the background job that hard-deletes Groups whose `softDeletedAt` is older than 7 days runs inside the same Node process as the HTTP API, scheduled by `setInterval` and started from `src/index.ts` after the HTTP server starts. The interval is one hour by default. The timer handle is `unref`'d so it never keeps the process alive on its own. The runnable function (`sweepHardDeletes`) is exported separately from the scheduler (`startHardDeleteSweeper`) so tests call the function directly with a fixed `now` and never start a timer.

**Rationale:**
- The sweep is one `prisma.group.deleteMany({ where: { softDeletedAt: { lt: cutoff } } })` query an hour. A separate worker process would add a second container, a second image, a second restart policy, and a second deployment surface for self-hosters; the cost-benefit is wrong at V1.
- Self-hosters get the sweep for free by running the same `junjo-server` Docker image they already run for the API. No second cron container, no Kubernetes CronJob, no host-level crontab to forget.
- Tests need to assert the sweeper does the right thing without waiting an hour for a timer. Splitting the function from the scheduler keeps the function unit-testable (`sweepHardDeletes(prisma, { now })`) without ever calling `setInterval`.

**Trade:** if the API is scaled horizontally to multiple instances later, every instance will run its own sweep tick. The deleteMany is idempotent (rows already gone are silently skipped) so correctness is preserved, but a few extra round-trips per hour are wasted. When that matters, factor the scheduler into a separate worker process with `SELECT FOR UPDATE SKIP LOCKED` lease semantics. The function signature stays stable; only the scheduling layer changes. Documented in `docs/03-architecture.md` (Background sweeps).

### `Invitation.createdByUserId` is nullable; the V1 invite-create paths set it to `null`

**Decision:** `Invitation.createdByUserId` is now nullable in the schema (a new migration, `20260428080409_invitation_created_by_nullable`, drops the `NOT NULL` constraint). The shared SDK type widens `Invitation.createdBy: UserId` to `UserId | null`. The first invite-creation route (`POST /v1/groups/:id/invitations`) writes `null` for this field. The audit entry's `actorUserId` is also `null` on the same path.

**Rationale:**
- The only credential present on the V1 invite path is the API key, which represents the *game*, not a player. With no auth-adapter glue in place yet (Phase 6), there is no user identity to attribute the action to. The schema was forcing every invite to carry an actor that the system genuinely did not know.
- Parallels `AuditEntry.actorUserId`, which is already nullable for exactly the same reason. One pattern across the audit-and-invitation surface, one less special case to remember.
- Once auth adapters and the player-side accept/decline flow ship, the field will populate naturally: a request that includes a player session token will resolve to a `JunjoUser`, and the route will write that id into `createdByUserId`. The wire shape stays stable; today's `null` becomes tomorrow's `UserId` without a breaking change.

**Trade:** the SDK type widens to `UserId | null`, which is technically a backwards-compatible widening for existing callers (the shared package has no users in production yet, but the rule applies on principle). Code that destructures `invitation.createdBy.toUpperCase()` would break, but no such callers exist; the field is documented as "the actor that issued the invitation, or `null` for system-issued invitations." Self-host-and-manual-write callers that fed a non-null value into the column are unaffected by the schema change (NULL is allowed, non-null is still allowed).

### `Invitation.code` is a 16-character random hex string

**Decision:** `POST /v1/groups/:id/invitations` (and the future open-code/open-link variants) generate the invitation `code` server-side as 16 hex characters (8 random bytes from `node:crypto`'s `randomBytes`). The SDK does not accept a caller-provided code in V1.

**Rationale:**
- 64 bits of entropy is more than enough for an unguessable invite token: at one billion guesses per second it would take centuries to brute-force a single code, and the unique constraint on the column would loudly surface any accidental collisions before brute-forcing was even relevant.
- Hex is URL-safe with no special-character handling, prints cleanly in CLI logs, and is unambiguous to read aloud (no `0`/`O`, `1`/`l` confusion since the alphabet is `0-9a-f`). 16 characters is short enough to copy-paste and long enough that nobody will guess it.
- Server-generated codes keep the database invariant ("code is unique across the game tenant") on the server's side of the wall, where it is enforced by the DB unique index; trusting a caller-supplied code would mean either re-validating the format or accepting collisions.
- Future variants (`inviteByCode`, `inviteByLink`) and the cross-game admin tooling will reuse the same generator. Centralizing the choice here means we only have one decision to revisit if shorter / longer / different alphabet ever becomes a requirement.

**Trade:** uppercase / mixed-case codes are denser (a 12-char base32 token would carry the same entropy as 16 hex chars). Hex won on readability and "no characters that look alike" alone; densifier alphabets can replace the generator without touching anything else if the URL length ever shows up as a problem.

### `member.invited` audit payload includes the invitation id, code, and `roleId`

**Decision:** the `member.invited` audit entry carries `payload: { invitationId, code, targetUserId, roleId }` (with `roleId: null` when not specified). `targetId` on the audit row is the `targetUserId` (the invited player), not the invitation id.

**Rationale:**
- The audit log answers "who was invited, by whom, and on what terms?". `targetUserId` going into `targetId` makes the most-common query ("show me every invite ever sent to this user") a one-line index lookup; the existing `(actorUserId, createdAt)` index serves the inverse query.
- Storing `code` in the payload (in addition to `invitationId`) makes audit entries self-contained: a future support engineer reading the audit log can paste the code straight into `GET /v1/invitations/:code` without joining back to the Invitation table. Storing the `id` in addition keeps the foreign-key path open for joins when the underlying row is still there.
- `roleId` going into the payload (rather than into a separate column) follows the same pattern every other audit `payload` already uses for action-specific fields. Promoting it to a column would create a one-off shape unique to invite-related rows.

**Trade:** the audit `payload` jsonb grows by a few bytes per row. Negligible at any realistic group volume, and the audit table is already the dominant write path so a few extra bytes per row do not change the order of magnitude.

### `POST /v1/groups/:id/invitations` is the same endpoint for direct and open-code invites

**Decision:** the direct-user invite (`inviteByUserId`) and the open-code invite (`inviteByCode` / `inviteByLink`) share a single endpoint, `POST /v1/groups/:id/invitations`. The body schema accepts an optional `targetUserId`: when present the route writes a direct invitation, when absent it writes an open-code invitation. Both paths run through the same audit-and-create transaction. The `inviteByUserIdBody` Zod schema is renamed `createInvitationBody`.

**Rationale:**
- The two flows differ only in one field. Splitting them into `POST /v1/groups/:id/invitations/direct` vs `POST /v1/groups/:id/invitations/open` would double the route surface for no real win; the body shape and the response are identical.
- Keeping the contract on a single URL also makes the future "support engineer is reading server logs" path simpler: every invite-create lands at the same path with the same audit action, and the body tells you which variant fired.
- The SDK still has separate `inviteByUserId` and `inviteByCode` methods because the developer ergonomics are genuinely different (one takes a `userId`, the other does not). The methods just happen to share a transport.

**Trade:** the schema cannot enforce "exactly one of targetUserId / open" at the type level; a client that sends `{ targetUserId: "user_x" }` to what the SDK calls `inviteByCode` would actually get a direct invite back. The SDK guards against that on its end (`buildOpenInviteBody` drops `targetUserId`). Direct REST callers are responsible for sending the body shape they want.

### `expiresIn` is parsed from a `<positive integer><unit>` string with units `s|m|h|d`

**Decision:** the server accepts an optional `expiresIn` field on `POST /v1/groups/:id/invitations` formatted as `<positive integer><unit>` where the unit is one of `s` (seconds), `m` (minutes), `h` (hours), `d` (days). The Zod schema enforces the regex `^\d+[smhd]$`; the route handler additionally rejects non-positive values (e.g., `0d`) with `400 bad_request`. The server stamps `expiresAt = now() + expiresIn` at create time and writes both `expiresAt` on the row and (for symmetry with the audit log's "self-contained payload" pattern) `expiresAt` in the `member.invited` audit `payload`.

**Rationale:**
- A duration string is more ergonomic than asking callers to do `new Date(Date.now() + 7 * 86_400_000).toISOString()` and equally precise. The shared SDK type already documents `expiresIn?: string; // e.g. "7d", "1h"` so this implementation matches the type.
- Limiting the alphabet to `s|m|h|d` covers every realistic invite TTL (seconds for tests, minutes for short-lived link drops, hours for OTP-style invites, days for "this week" invites) without inviting the well-known confusion between `m` for minutes and `M` for months. Weeks (`w`) and longer units were skipped: the dev can write `30d` or `90d`.
- Computing `expiresAt` server-side (rather than letting the client send a precomputed timestamp) avoids clock-skew bugs: a client whose clock is wrong by an hour produces an invite that expires an hour earlier or later than the developer expects. The wire shape (`expiresAt` as ISO string) stays a normal absolute timestamp downstream.
- Rejecting `0d` keeps the failure loud. A zero-duration invite is technically expressible by the regex but is meaningless ("expires before it exists") and is more likely a typo than an intent.

**Trade:** the format is custom and not ISO-8601 (`PT7D`). ISO durations are precise but verbose and rare in modern web APIs; the `<n><unit>` shorthand is the de-facto convention (Vercel, Cloudflare, GitHub all use variants of it). If a future caller really needs sub-second or month/year precision we can extend the regex without breaking older callers.

### `inviteBaseUrl` is a separate config field that defaults to the API `baseUrl`

**Decision:** `JunjoConfig` gains an optional `inviteBaseUrl?: string` field. `Junjo.groups.inviteByLink` uses it to construct the URL `${inviteBaseUrl}/invite/${encodeURIComponent(code)}`. When unset, it falls back to the same `baseUrl` value that the API client uses (with trailing slashes trimmed). The SDK does not assume any particular path layout on the dev's frontend; it only produces a `/invite/:code` URL because that is the convention VISION calls out.

**Rationale:**
- The API server does not (and should not) host an end-user invite-acceptance UI in V1. That UI lives in the dev's frontend. The URL the dev shares therefore needs to point at the *frontend* origin, not the API origin.
- Most devs will run their frontend on a different host than the API (`app.mygame.com` vs `api.junjo.io` or self-hosted server). Reusing the API `baseUrl` would produce links that resolve to a 404 on the API host. A separate config field is the simplest way to surface this without surprising the dev.
- Defaulting to `baseUrl` keeps the V1 "set it and forget it" path working for devs whose API and frontend share an origin (or who are still in local dev pointing both at `localhost`). The dev opts into the more correct configuration when their architecture is ready for it.
- Building the URL client-side keeps the server free of frontend coupling. The server never has to know what URL the dev's frontend is reachable at; that is purely an SDK-side concern.

**Trade:** an under-configured SDK can produce a URL that resolves to a wrong host. The cost is loud (the link is broken when the user clicks it), not silent (no data integrity issue), and the docs call out the configuration in the very first `inviteByLink` example.

### `inviteByCode` silently drops a `targetUserId` from the body

**Decision:** the SDK method `groups.inviteByCode(groupId, input?)` strips `targetUserId` from `input` before sending the body. Same for `inviteByLink`. A caller that wants a direct invitation should call `inviteByUserId` instead.

**Rationale:**
- The shared `CreateInvitationInput` type is unified (it is the same shape the future `bulkInvite` API uses) and includes `targetUserId?`. That makes the type ergonomic for callers but creates an opportunity for misuse: passing `targetUserId` to a method named "invite by code" is a programmer error, not a feature.
- Dropping the field at the SDK boundary makes the contract clear without a runtime exception: `inviteByCode` always produces an open-code invitation, regardless of what extra junk the caller's `input` object happens to carry.
- The server still accepts `targetUserId` on the same endpoint (the endpoint is shared, see the previous decision). Direct REST callers can hit the same URL with `targetUserId` present and get a direct invitation; the SDK semantically forces the shape, while the wire is permissive.

**Trade:** a caller who *wanted* the SDK to forward `targetUserId` to the open-code path will be surprised. The mitigation is the SDK-doc table, which marks `targetUserId` as "ignored" for `inviteByCode` and points to `inviteByUserId` instead.

### `GET /v1/invitations/:code` is public; `DELETE /v1/invitations/:code` requires auth

**Decision:** the read-by-code endpoint is reachable without an API key. The delete-by-code endpoint requires the calling game's API key and 404s on cross-game codes (existence is not leaked). The split is implemented by registering the public GET handler **before** `v1.use("*", apiKeyMiddleware(store))`; Hono's middleware chain composes matched handlers in registration order, so the public handler returns a Response without ever calling `next()` and the auth middleware is skipped on that route.

**Rationale:**
- The invite-acceptance UI lives on the dev's frontend, not the API server, and the dev's frontend may need to render an invite preview *before* the user signs in (so the page doesn't 401 a freshly-arrived visitor). A public GET means "junjo.invitations.get(code)" works from a browser context without needing a backend proxy.
- The DELETE side does not have the same usage pattern (only the dev's backend revokes invites), so it stays gated by the API key. Cross-game DELETEs return 404 instead of 403 to keep the existence of cross-game codes invisible.
- Putting the route registration *before* the middleware (rather than adding URL-aware skip logic inside the middleware) keeps the auth code single-purpose: it doesn't have to know which paths are public. The allowlist lives in the routing graph.
- The convention from `docs/03-architecture.md` ("All routes mount under `/v1`") is preserved: the public route is `/v1/invitations/:code`, just unauthenticated. There is no separate "public" namespace.

**Trade:** an attacker can enumerate valid invitation codes by guessing them. The 16 hex characters of code (64 bits of entropy) make blind guessing computationally infeasible in any reasonable timeframe; per-IP rate limiting, when it lands, will further harden this. We do not consider invitation codes secret in the cryptographic sense (they are short-lived tokens), only secret-in-practice.

### Revoking an unused invitation deletes the row; revoking a used invitation is a no-op

**Decision:** `DELETE /v1/invitations/:code` hard-deletes the underlying row when `usedAt` is null. When `usedAt` is set, the route returns `204 No Content` without touching the row. There is no `revokedAt` column, so revocation of unused invitations is destructive (the second call returns 404 because the row is gone). Revocation of used invitations is fully idempotent (every call returns 204; the row stays).

**Rationale:**
- VISION calls out "idempotent on already-used" specifically: revoking a used invitation should not error. The cleanest interpretation is that the row stays and the call is a 204 no-op (the invitation is no longer revokable in any meaningful sense, because the seat has been consumed; the call to "revoke" reports success rather than 4xx).
- Hard-deleting unused invitations preserves no useful state. The `member.invited` audit entry exists for the create event; if no member ever joined via that code, the only thing the `Invitation` row carried was the redemption potential, and revocation removes that.
- Adding a `revokedAt` column to support "soft revoke" was considered. Rejected for V1: the schema migration is small but the surface area expands (every `Invitation`-reading endpoint needs to filter on `revokedAt IS NULL` and the SDK type grows a field). The current approach matches REST DELETE semantics without that overhead. We can introduce `revokedAt` later as an additive change if a use case arises.

**Trade:** the second revoke call against an unused code returns 404 instead of 204, which is technically not idempotent in the strict REST sense. The `not_found` is harmless (it correctly reports the row is gone) and matches Stripe / Shopify behavior on similar endpoints.

### `GET /v1/groups/:id/invitations` defaults to "live" (excludes used and expired) and accepts boolean string flags

**Decision:** the list endpoint excludes invitations whose `usedAt` is set and whose `expiresAt` is in the past by default. Two query flags re-include them: `includeUsed=true` and `includeExpired=true`. Both flags are parsed as the literal strings `"true"` or `"false"`; any other value (including "1", "yes", or boolean "true" without quotes) returns `400`.

**Rationale:**
- The default response answers the most common question: "what invitations are still redeemable?" Including used and expired rows by default would force every caller to filter client-side and would inflate the page size.
- The flags are opt-in rather than opt-out so the dashboard can render an admin "all invitations" view without the SDK's default behavior masking historical rows.
- Strict `"true"`/`"false"` parsing matches the existing convention used by other Junjo query params and is unambiguous; permissive parsing ("1" / "yes" / case variations) sounds friendlier but creates surprising edge cases when the dev's frontend assembles the URL via `URLSearchParams.set("includeUsed", flagVar)` where `flagVar` is something like `"True"`. A 400 here is loud and quickly fixed.
- The `expiresAt < now()` filter uses the request's `now`, which means the page contents are slightly time-dependent. The few-millisecond drift between two near-simultaneous calls is acceptable; an invitation that expires exactly during pagination either falls out (excluded from page 2) or stays (already in page 1's items). The cursor still references its row id so pagination doesn't break.

**Trade:** filtering happens server-side, so a dev who wants to display "all invitations including used ones" with a per-row "redeemable?" indicator must make a single call with both flags set rather than two parallel calls. Acceptable: the use case is rare and the alternative (exposing both lists separately) doubles the route surface.

---

### Accept and decline take an explicit `userId` in the body

**Decision:** `POST /v1/invitations/:code/accept` requires a body `{ userId }` and `POST /v1/invitations/:code/decline` accepts an optional `{ userId? }`. The SDK methods mirror this: `groups.acceptInvitation(code, userId)` and `groups.declineInvitation(code, opts?: { userId? })`. The supplied `userId` is the dev's external user id (Clerk sub, Supabase uuid, Roblox UserId-as-string), not Junjo's internal `junjoUserId`.

**Rationale:**
- V1 has no auth-adapter actor wired (Phase 6). The dev's backend is the trusted layer: it authenticates the player itself and tells Junjo "this user is accepting", much like the existing `groups.inviteByUserId(groupId, userId)` shape. Threading the userId through the body is the natural V1 expression of that trust boundary.
- Putting the userId in the body (rather than reading it from a player session token) keeps these endpoints usable from raw HTTP without needing the auth-adapter glue. Phase 6 will add an alternate "session-token" path that resolves the userId server-side; the body shape stays compatible (the server prefers the resolved id when both are present).
- Accept genuinely needs the userId (it has to pick a `JunjoUser` to seat the `GroupMember` row). Decline does not strictly need it, but recording it as `usedByUserId` lets the audit trail answer "who declined this code" without a separate lookup. Making it optional on decline keeps the API forgiving for cases where the dev doesn't want to track decliners.
- For direct invitations (`targetUserId` set), the supplied `userId` must match. Mismatches return `403 permission_denied`. Open-code invitations accept any user id. This pins direct invites to their target while keeping open codes truly open, with no extra route surface.

**Trade:** the SDK signature changed from the throwing stub `acceptInvitation(code)` to the shipped `acceptInvitation(code, userId)`. The stub never returned a real value, so no existing callers can break, but the type change is technically not "additive". Documented here to keep the precedent clear for future stub-to-shipped transitions.

### Accept resolves external user ids via `findOrCreateJunjoUser`

**Decision:** the accept-invitation handler resolves the body's external `userId` to an internal `JunjoUser` by calling `findOrCreateJunjoUser(tx, gameId, externalUserId)` from the new `packages/server/src/identity.ts` module. The helper looks for an `ExternalIdentity (gameId, externalUserId)` row and returns the linked `junjoUserId`; if no row exists, it creates both the `JunjoUser` and the `ExternalIdentity` row inside the same transaction. The same call site is used by decline when a `userId` is supplied (so `usedByUserId` is recorded).

**Rationale:**
- Creating a `GroupMember` row requires a `JunjoUser` foreign key, but the SDK only ever supplies the dev's external id. The mapping has to happen *somewhere*; co-locating it in `identity.ts` (rather than inlining it in the route) keeps the lookup-and-create logic in one place that Phase 6 (auth adapters) and Phase 10 (cross-game cloud) can share.
- Phase 10 of the roadmap calls out this exact resolution flow as cloud-only ("ExternalIdentity resolution"), but the underlying find-or-create is needed in self-host too: without it, no member can ever be seated. The cloud-only piece is the cross-game *query* (Phase 10.2's `GET /v1/users/:junjoUserId/games`), not the per-game mapping. The decision here is to bring up the per-game mapping as a foundational helper in V1, not gate it behind cloud.
- The helper accepts either the full Prisma client or a `Prisma.TransactionClient`, so the accept handler can fold the find-or-create into the same transaction that creates the `GroupMember`, updates the `Invitation`, and writes the audit entry. All four writes commit or roll back together; a thrown `already_member` rolls back the JunjoUser/ExternalIdentity create, which is correct (we only want to reify the user when they actually joined).

**Trade:** if the same external user id is sent to two different games, two separate `JunjoUser` rows are created (one per game). That is intentional in V1: cross-game shared identity is Phase 10 (cloud-only). The schema's `ExternalIdentity (gameId, externalUserId)` unique constraint enforces per-game scope; Phase 10 will introduce a cross-game resolution layer on top. The current helper is forward-compatible with that change because it returns the linked `junjoUserId` regardless of how it was reached.

### `already_member` is `409`; expired and used invitations are `410`

**Decision:** the accept handler returns three new `JunjoError` codes:

- `already_member` (`409 Conflict`) - the user already has a `GroupMember` row in the group (any status).
- `invitation_expired` (`410 Gone`) - the invitation's `expiresAt` is in the past.
- `invitation_used` (`410 Gone`) - the invitation's `usedAt` is set.

Decline shares `invitation_expired` and `invitation_used` (it cannot trigger `already_member` since it doesn't create members). All three are added to the `Errors.*` factory in `packages/server/src/errors.ts`.

**Rationale:**
- VISION explicitly calls out these three error cases for Phase 2.4's tests ("code expired", "code already used", "user already member"). Each gets a dedicated code so SDK callers can branch on `error.code` rather than parsing messages.
- `409 Conflict` matches Stripe / Linear / GitHub conventions for "the requested action conflicts with current resource state" (the user is already a member; the action would violate the unique constraint). `410 Gone` matches the existing `restore_window_expired` precedent for resources that existed but are deliberately unrecoverable now (the invitation was valid; it has been redeemed or has aged out).
- Splitting `invitation_expired` from `invitation_used` is deliberate even though both return `410`: an expired invitation can be re-issued; a used one might mean the user already joined (the SDK can branch and call `members.get` instead of erroring). Differentiating them at the `code` layer keeps the wire envelope informative without surfacing it in the HTTP status.
- The order of precondition checks is: not-found > soft-deleted-group (also 404) > used > expired. Used wins over expired because if a user redeemed before the invitation expired, the audit story is "they joined", not "the code aged out".

**Trade:** three new codes is more API surface to learn. Documented in both `apps/docs/pages/api/invitations.mdx` and `apps/docs/pages/sdk/groups.mdx` so callers see the table next to the method signature.

### Accept rejects an existing `GroupMember` row regardless of status

**Decision:** if a `GroupMember` row exists for `(groupId, junjoUserId)` with any status (`active`, `invited`, `left`, `kicked`), accept returns `409 already_member` and leaves the invitation unused. Re-joining a group after leaving or being kicked is not a V1 feature.

**Rationale:**
- The unique constraint on `GroupMember(groupId, junjoUserId)` means there can only ever be one row per (group, user). Detecting the conflict before issuing the create lets us return a clean `409` instead of a Prisma `P2002` that the error middleware would have to fingerprint.
- "Rejoin after leaving" is a real product question with non-obvious answers: does the previous role assignment carry over? Are notes preserved? Should the `joinedAt` reflect the original or the rejoin? V1 punts these questions to a future iteration (likely Phase 2.5 or a dedicated rejoin route).
- A pre-check `findUnique` in the same transaction adds one extra read but keeps the failure mode loud and predictable. The cost is acceptable; the alternative (catch-and-rethrow on P2002) couples the route to Prisma error codes.

**Trade:** a kicked user who later receives a fresh invitation cannot rejoin via accept; the dev has to manually update the existing `GroupMember` row's status (or delete it). Phase 2.5 will likely revisit this once `kick` and `leave` are wired.

### `leave` and `kick` only transition from `active`; other states are idempotent no-ops

**Decision:** `POST /v1/groups/:id/leave` only writes when the member's `status` is `active` (transitioning to `left`); any other state (`left`, `kicked`, `invited`) is returned unchanged with no audit entry. `POST /v1/groups/:id/members/:userId/kick` mirrors this: only `active -> kicked` is a write, every other state is an idempotent return. A non-existent member (no `GroupMember` row) is `404 not_found`.

**Rationale:**
- The route's intent is "ensure this member is in the terminal state I'm asking for." If they already are (or are in a different terminal state owned by a different action), the request is satisfied; the only useful work is reading back the current row.
- Crossing terminal states (e.g. `kicked -> left` via leave, or `left -> kicked` via kick) would overwrite the audit story of how the member departed. That history is load-bearing for moderation review and the future `audit.list` endpoint (Phase 5.2). The cost of "kick then leave overwrites the kick" is silently losing why the member was removed; the cost of "kick then leave is a no-op" is just that the leaver's UI shows `kicked` instead of `left`. The first cost is real; the second is cosmetic.
- The read-only fall-through still costs one query (`MemberRole.findMany`), but no `groupMember.update` and no `auditEntry.create`. The wire response is the same shape as the transition path so SDK clients can render based on `status` without branching.

**Trade:** if the dev's intent is "drop this member regardless of how they got there," they can issue a Prisma update directly. Phase 2.5's routes are deliberately conservative; they do not provide a "force" flag. If a force-transition becomes a real product need, it lands as a separate route (e.g. `members.setStatus`) rather than a flag on these endpoints.

### `leave` and `kick` 404 collapse three causes (no group, no identity, no member)

**Decision:** the `not_found` error returned by both routes covers three distinct conditions: the group does not exist (or is soft-deleted, or is cross-game), the user has no `ExternalIdentity` row for the calling game, and the user has an identity but no `GroupMember` row in the group. All three return the same `{ code: "not_found", status: 404 }` envelope.

**Rationale:**
- The group-existence check already collapses three causes (unknown id, soft-deleted, cross-game) into one 404, per the precedent set by `GET /v1/groups/:id`. Folding the membership-existence check into the same code keeps the existence-leak boundary consistent: a caller cannot probe whether a user has *ever* registered in this game by trying `leave` and reading the error.
- A finer-grained code (e.g. `member_not_found` vs `user_not_found`) would force the SDK to expose three branches that all mean "this person isn't in the group." The collapsed code maps to the dev's mental model.

**Trade:** debugging is slightly harder because the dev cannot tell from the response alone whether they sent a typo'd `userId`, a typo'd `groupId`, or operated on the wrong member. The trade is acceptable because the dev's backend supplies these ids itself; mistyping them is uncommon and easily diagnosed by inspecting the audit log.

### `leave` records the leaver as `actorUserId`; `kick` records `null`

**Decision:** the `member.left` audit entry's `actorUserId` is the leaver's resolved `JunjoUser` id; the `member.kicked` audit entry's `actorUserId` is `null`. Both store the operated-on user as `targetId`.

**Rationale:**
- The leaver *is* the actor of their own departure, even if Junjo only knows about them via the dev-supplied external user id rehydrated through `findJunjoUserId`. This parallels the `member.joined` audit precedent set in Phase 2.4 (accept), which also records the resolved JunjoUser as the actor.
- For `kick`, the actor is the dev's backend, not a Junjo-tracked user. Until Phase 6 wires auth adapters and Phase 3.5 wires permission-derived authorization, the route does not accept a `kickedByUserId` body field; the audit row records `actorUserId: null` (matching the `group.created`, `group.updated`, etc. precedents that also have no actor in V1).
- The `reason` payload field captures the human-readable context that an actor field would otherwise carry. Phase 5.2's `audit.list` endpoint surfaces this verbatim.

**Trade:** when both `kick` and the future auth-adapter-wired permission system land, the `member.kicked` audit entry will need to start populating `actorUserId`. That is an additive change (null -> non-null), not a wire-format change.

### `MemberRole` lookup is centralized in `loadMemberRoleIds`

**Decision:** the wire-format helper module `routes/members.ts` exports a `loadMemberRoleIds(client, groupMemberId)` helper that returns the role ids attached to a member. Routes that emit a `Member` (today: leave, kick; Phase 2.4's accept passes `[]` because the member is freshly created with no roles) call this helper before calling `serializeMember`.

**Rationale:**
- Centralizing the query keeps the `Member` wire shape consistent across routes; routes never assemble role ids by hand.
- The helper accepts either a full `PrismaClient` or a `Prisma.TransactionClient`, so future paths that need to load + serialize inside a transaction can do so without an extra parameter.
- Phase 3.2 (`members.assignRole` / `removeRole`) will be the first writer of `MemberRole` rows. Until then the helper returns `[]` for every member; that is correct behavior, not a stub.

**Trade:** every member-emitting route now does an extra `findMany` query (one read per response). The cost is acceptable for V1; if it shows up in a profile, the natural fix is to fold the role-ids selection into the same `groupMember.findUnique({ include })` call. The helper is local enough that the future refactor is one-call-site at a time.

### `members.list` returns rows in every status (no implicit `active` filter)

**Decision:** `GET /v1/groups/:id/members` returns every `GroupMember` row in the group, regardless of `status` (`active`, `invited`, `left`, `kicked`). No implicit filter is applied; the caller filters client-side. A future `?status=` query param can land as an additive change.

**Rationale:**
- The schema is explicit that `GroupMember` rows persist after leave / kick (the row carries the audit story and feeds Phase 5.2's `audit.list`). Filtering them out at the list endpoint by default would hide load-bearing data; a caller looking at "everyone who has ever been in this group" would have to know to flip a flag.
- Default-active would also force every dashboard rendering "current members" to send `?status=active` while the caller building a moderation view sends `?status=any`. Neither is a clean default. Returning all rows and letting the caller filter keeps the route honest about what it returns.
- The cost (a list response that includes departed members) is bounded by the `limit` and the cursor pagination already in place. Most callers will issue a follow-up filter on the SDK side; the alternative requires server-side support for "give me the union of these statuses" which is more surface than V1 needs.

**Trade:** common UI cases ("show me the active roster") need a client-side filter. Acceptable because the filter is one line and the alternative is bifurcating the endpoint. When the V1.1 ergonomics review surfaces this as a real friction, add `?status=active,left,...` in one shot.

### `members.list` orders by `joinedAt desc, id desc` with manual cursor pagination

**Decision:** `GET /v1/groups/:id/members` orders rows by `(joinedAt desc, id desc)`. Pagination is cursor-based: the cursor is the previous page's last member id; the route does a `findFirst` to recover the cursor's `(joinedAt, id)` pair, then filters for rows strictly less than that pair on the same `(joinedAt, id)` ordering.

**Rationale:**
- `joinedAt` alone is not deterministic when two members joined at the same instant (an unlikely but real possibility for batch-seeded fixtures and webhook fan-ins). Adding `id` as a tiebreaker makes the cursor advance monotonically; this is the same pattern used by `groups.list` (`createdAt desc, id desc`) and `invitations.list` (`createdAt desc, id desc`).
- Newest-first matches the dashboard's natural display order (recent joiners at the top). A future "joined first" admin view can sort opposite-direction; for V1, descending is the only mode.
- The cursor lookup rejects ids that point at members in a different group, returning `400 bad_request`. That keeps cursor-injection from leaking memberships across groups.

**Trade:** the `(joinedAt, id)` composite predicate cannot use an index by default; performance is bounded by the page size (`take: limit + 1`), but a heavy group might benefit from an index on `GroupMember(groupId, joinedAt desc, id desc)`. Defer until profiling shows it. The schema currently has `(groupId, status)` as the secondary index.

### `members.listForUser` returns a bare array capped at 1000 (no pagination)

**Decision:** `GET /v1/users/:userId/members` returns a `Member[]` body (no `Page<Member>` wrapper) with a server-side hard cap of 1000 rows. The SDK signature mirrors this: `members.listForUser(userId, opts?)` returns `Promise<Member[]>`. A user with more than 1000 memberships in a single game is unsupported in V1; if it ever surfaces, the route gains pagination as an additive change.

**Rationale:**
- VISION's V1 SDK signature for `listForUser` returns `Member[]` (no `Page` wrapper). Honoring that keeps the spec and the implementation aligned.
- A user being a member of more than 1000 groups in a single game is a pathological case for the V1 product (guild + sub-guilds + alliances rarely exceeds dozens of memberships per user). Capping at 1000 keeps the response bounded without forcing pagination machinery on every call site.
- Returning a bare array (rather than `{ items, nextCursor }`) keeps the calling code one line: `for (const m of memberships)`. The trade-off is that adding pagination later is a breaking change to the wire format. Acceptable because the V1 contract is "this won't paginate" and the SDK return type captures that.

**Trade:** the wire format diverges from the other list endpoints (`groups.list`, `invitations.list`, `members.list` all return `{ items, nextCursor }`). Documented inline so future-Gabe doesn't try to "harmonize" the shape. If the cap is ever exceeded in production, the migration path is to bump the SDK signature to `Page<Member>`, return `{ items, nextCursor }` from the server, and ship a major version of `@junjo/sdk`.

### `members.listForUser` returns `[]` (not `404`) for users with no `ExternalIdentity` in this game

**Decision:** when the dev's external `userId` has no `ExternalIdentity` row for the calling game, `GET /v1/users/:userId/members` returns `200 OK` with an empty array, not `404 not_found`. Same for users who have an identity but zero memberships.

**Rationale:**
- The two cases ("user we have never seen" and "user known but in zero groups") are indistinguishable to the consumer: in both, the answer is "zero memberships". Collapsing them keeps the SDK call site simple (`for (const m of result)`) without a `null` check.
- Returning `404` for "unknown user" would leak whether a given external user id has ever been recorded for this game. Returning `[]` keeps that boundary closed.
- This matches the precedent set by `groups.list` (an empty page is `200 OK` with `[]`, not `404`). List endpoints are answer-shaped, not lookup-shaped.

**Trade:** if a dev expects `null` to mean "user unknown", they get an empty array instead. Documented in `apps/docs/pages/api/members.mdx` and `apps/docs/pages/sdk/members.mdx`. The alternative behavior (404 for unknown user) was rejected because it leaks existence and forces every caller to defensive-branch.

### `getById` and group-scoped `members.get` both return `Member | null` on 404

**Decision:** `GET /v1/members/:id` and `GET /v1/groups/:id/members/:userId` both return `404 not_found` when the row is missing or out-of-scope for the calling game. The SDK methods (`members.getById(id)` and `members.get(groupId, userId)`) translate that 404 into `null`. Other errors (`401 invalid_api_key`, network failures) throw `JunjoError`.

**Rationale:**
- Matches the `groups.get` precedent and the "convention for all single-row lookup methods" decision recorded earlier in this file. Single-row lookups return `T | null`; list endpoints return arrays / pages; mutating endpoints throw.
- Centralizing the 404-to-null translation in the SDK keeps the call site clean: `if (member) { ... }` rather than try/catch around every fetch.

**Trade:** the SDK swallows `not_found` for both methods, so a caller cannot tell from the return value alone *which* of the four collapsed conditions caused the 404 (group missing, soft-deleted, cross-game, no member). That is a feature: from the caller's perspective the answer is the same ("they aren't here").

### `members.setMetadata` and `members.setNotes` share one `PATCH /v1/groups/:groupId/members/:userId` route

**Decision:** the two SDK methods both call the same server route. The body is partial: any subset of `{ metadata, notesPublic, notesPrivate }`; an empty body returns `400 bad_request`. `setMetadata(groupId, userId, metadata)` sends `{ metadata }`; `setNotes(groupId, userId, input)` sends only the notes fields the caller supplied (omitting undefined keys).

**Rationale:**
- VISION specifies one route ("`PATCH /v1/groups/:groupId/members/:userId` with partial body") and two SDK methods. Two methods sharing one route is the precedent set by `groups.update` (one method, partial body) extended to the member resource: a single PATCH handles every subset of mutable fields, and the SDK provides ergonomic wrappers per concern.
- A future caller wanting to update both metadata and notes in one transaction can call the SDK methods sequentially (two HTTP requests) or fall through to a raw `http.patch`. The route accepts both at once and writes both audit entries in one transaction; the SDK does not expose a combined wrapper because the use cases are conceptually distinct (metadata is dev-managed state; notes are officer-managed prose).
- Phase 3 (`members.assignRole`, `members.removeRole`) will use sibling sub-paths (`/roles/:roleId`) rather than this PATCH, since role membership has its own lifecycle and audit actions. This route stays focused on metadata + notes.

**Trade:** the SDK signature for `setNotes` accepts `SetMemberNotesInput`, which carries both `notesPublic` and `notesPrivate` as optional. A caller who passes `{}` will get a `400 bad_request` from the server (the route's empty-body check). The SDK does not pre-validate; the assumption is that empty-input is a programming error worth surfacing as an HTTP error rather than swallowing.

### `member.metadata.updated` is written even when the supplied metadata equals the stored value

**Decision:** when the PATCH body includes `metadata`, the route always treats it as a change: it updates the row, writes a `member.metadata.updated` audit entry, and bumps `updatedAt`. There is no deep-equality check between the supplied metadata and the stored row.

**Rationale:**
- jsonb storage does not reliably preserve key order across writes, so a deep-equal check is fragile. The same precedent already governs `groups.update`'s metadata field for the same reason; extending it here keeps the two routes consistent.
- The audit entry's `before` and `after` both carry the full metadata object. A reader of the audit log can tell from the diff (or absence thereof) whether the supplied metadata actually changed. The audit entry does not lie; it records "the dev sent a metadata update" honestly.
- The alternative (deep-equal vs. stored, suppress the audit on no-op) introduces ambiguity in the audit log: an entry's absence could mean "the dev never tried" or "the dev tried with the same value." The current behavior makes the dev's intent explicit.

**Trade:** a dev who PATCHes the same metadata in a tight loop (e.g. on every player heartbeat) will spam audit entries. The mitigation is dev-side: don't do that. If the volume becomes a real product issue, a `?dryRun=true` query param or a server-side deduplication TTL can land later as additive features.

### `member.notes.updated` is written only for fields whose value actually differed

**Decision:** notes fields (`notesPublic`, `notesPrivate`) are diffed per-field against the stored row. The audit entry's `before` and `after` contain only the fields that changed. A PATCH that supplies the same notes value as the stored row (for every supplied field) writes no audit entry, performs no DB update for that subset, and returns the unchanged member. If the body has both notes and metadata fields and only metadata changed, the metadata audit is still written; the notes audit is suppressed.

**Rationale:**
- Strings are reliably equal-comparable, unlike jsonb. The fragility argument for metadata does not apply here.
- The notes fields are conventionally low-cardinality and human-edited (officer notes, tags). Devs are likely to send the existing value back as part of a "save form" UX; suppressing the no-op write keeps the audit log signal-rich.
- The per-field diff matches `groups.update`'s `before/after`-only-changed-fields shape, so audit consumers can render the diff with one shape rule.

**Trade:** the audit-entry shape for `member.notes.updated` is conditional: a single-field change carries one key in `before/after`, a two-field change carries two. Callers reading the audit log must accept that shape. The wire format is still a stable schema (`{ before: object, after: object }` with the same keys in both); only which subkeys are present varies.

### Member updates write two distinct audit actions in the same transaction

**Decision:** when a single PATCH supplies both `metadata` and notes fields and both subsets actually change, the route writes two audit entries: one `member.metadata.updated` and one `member.notes.updated`, both inside the same transaction as the `groupMember.update`. Each entry is independent (different action, different payload).

**Rationale:**
- `member.metadata.updated` and `member.notes.updated` are distinct entries on the `AuditAction` union (per `packages/shared/src/types.ts`). Collapsing them into a single `member.updated` action would require widening the union, which would break the precedent that audit actions name the *thing* that changed, not the *route* that ran. Compare to `group.updated` which exists; member is split because metadata and notes have different semantic meaning - dev-managed state vs. officer prose.
- Two entries instead of one keeps the audit log per-concern. A future audit-list filter (`actions[]` per Phase 5.2) can subscribe to "show me all metadata mutations" without filtering out the notes side, or vice versa.
- The atomicity guarantee (both audit entries land or neither, alongside the row update) is preserved by sharing one transaction.

**Trade:** a viewer of the raw audit log sees two entries for one PATCH; they need to correlate by `createdAt` to recognize the two as one operation. The trade is acceptable because the entries are distinct concerns; a "transaction id" / "operation id" column could be added later if cross-entry correlation becomes a real product need.

### Member `metadata` replaces wholesale; no patch / merge mode

**Decision:** a PATCH with `{ metadata: { ... } }` replaces the stored metadata wholesale. There is no JSON-merge mode, no JSON-patch mode, no "delete this key" sentinel. To remove a key, send the metadata object without that key.

**Rationale:**
- Matches `groups.update`'s metadata semantics exactly, so the dev does not have to remember per-resource rules.
- Wholesale replace is the simplest contract. JSON-merge / JSON-patch add an entire spec layer (RFC 7396 / RFC 6902) for marginal ergonomics; the dev can compute the merge client-side and send the full result.
- The dev's metadata is opaque to Junjo; any merge logic would be guessing at the dev's data model.

**Trade:** a dev who only knows about one field they want to change must read-modify-write (fetch the member, mutate the field, PATCH the result). For low-frequency mutations this is fine; for high-frequency mutations the dev should denormalize the field out of `metadata` into their own storage layer, since `metadata` is not a hot-path key-value store. Documented in the SDK page.

### Member notes are capped at 5000 characters

**Decision:** both `notesPublic` and `notesPrivate` accept up to 5000 characters; longer values return `400 bad_request`. The cap is a server-side Zod constraint; the SDK does not pre-validate.

**Rationale:**
- The schema declares both fields as `String?` with no length, so a hostile or buggy dev could write multi-megabyte notes that bloat audit payloads and member responses. A bounded cap is the cheapest mitigation.
- 5000 is generous enough for officer notes (a few paragraphs of guild context) and tight enough that a member-list page with 100 members caps payload size at ~1 MB worst-case. The cap can be raised later if it ever becomes a real friction; lowering it would be a breaking change.
- 500 (the cap on `kick.reason`) was considered but rejected: notes are a different surface area (longer-lived, conventionally richer) than a kick reason (one-line context).

**Trade:** if a dev needs richer prose (e.g. a wiki-style member dossier), they should denormalize that storage into their own database and link by member id. The notes field is for short officer commentary, not long-form documentation.

## Open questions

- Initial domain: `junjo.io` only, or also grab `junjo.gg` (gaming TLD) as redirect?
- npm org: try to claim `@junjo` first, fallback to `@junjo-dev` if taken

### `groups.bulkInvite` accepts plain text, one userId per line

**Decision:** the bulk-invite route takes a `text/csv` body in which each non-empty line is a single external user id. The format is intentionally not a real CSV: there is no header row, no quoting rules, no comma-separated fields. Whitespace is trimmed, empty lines are ignored without being counted, and the `\n` / `\r\n` distinction is collapsed.

**Rationale:**
- VISION specifies "one user-id or email per line" - that is a one-column CSV with no fancy parsing required. Adding a CSV-spec parser dependency for a single-column file would be over-engineering.
- Userids are opaque strings (Clerk `user_xyz`, Supabase uuids, Roblox numeric ids as strings); a real CSV parser would have to special-case ids that contain commas, which is the dev's responsibility, not Junjo's.
- The dev who wants to attach extra columns (display name, intended role, etc.) can pre-process the CSV client-side and call `bulkInvite` with just the userId column. The single-column format keeps the server contract tight and predictable.

**Trade:** if the dev's userIds happen to contain commas (rare but possible for some auth providers), they can pass them through verbatim - we do not split on commas. The cost is that the format is not interoperable with spreadsheet exports that have multiple columns; the dev must export a single-column file.

### `groups.bulkInvite` is capped at 1000 rows per request

**Decision:** the total source-line count (errored rows + valid rows) is capped at 1000. Exceeding the cap returns `400 bad_request` with no invitations created. Userids are individually capped at 255 characters; longer values land in `errors`, not `skipped`.

**Rationale:**
- One request creates up to 1000 invitations and 1000 audit entries inside one Postgres transaction; that is comfortable for a single transaction without lock contention. Higher numbers (10k, 100k) would either need batching across multiple transactions or a job-queue / async flow, neither of which is in V1.
- 255 characters is a generous upper bound for any practical userId (Clerk's `user_<26-char-cuid>` is 31, Supabase uuids are 36, Roblox `Players.LocalPlayer.UserId.tostring()` is at most 19). Longer values are almost certainly malformed input (e.g. a CSV row that includes the user's display bio); reporting them as errors gives the dev a useful signal.
- The cap can be raised later (1000 -> 10000) without breaking dev code, since the validation message includes the active limit. Lowering would be breaking; 1000 leaves room.

**Trade:** a dev with a >1000-user invite list must batch their own requests. The dev's loop is simple (split into chunks of 1000, call `bulkInvite` per chunk), and they get incremental feedback as each chunk returns its `invited` / `skipped` / `errors` counts.

### `groups.bulkInvite` skips users who are already active members or already have a pending invitation

**Decision:** for each unique userId in the batch, the route runs two existence checks in parallel (active `GroupMember` row, unused-and-unexpired `Invitation` row). A hit in either check counts the row as `skipped` and creates no new invitation. Duplicates within the same batch (the same userId appearing twice in the input) also count as `skipped` for every occurrence after the first.

**Rationale:**
- Bulk invite is conceptually "make sure each of these users has an open invitation", not "create N new rows regardless of state". Re-inviting an already-active member would create churn in the dev's UI ("you have a pending invitation" notifications for users who are already in); creating a duplicate pending invitation for the same user would just leave dead rows.
- Non-active members (`left`, `kicked`, `invited`) are not skipped - the dev can re-invite them. This matches the existing Phase 2.1 `inviteByUserId` semantics, which only blocks if there is an active membership (not a historical one). VISION calls for symmetry between bulk and single-shot invitations.
- Expired and used invitations are not skipped either, since they no longer represent live state. The dev's previous attempt has lapsed; the bulk call resurrects the offer.

**Trade:** the response's `skipped` count conflates four distinct cases (already active, already pending, batch duplicate, also-pending-from-prior-call). For V1 a single bucket is enough; if devs ask for a breakdown later, the response can grow `skippedReasons: { activeMember, pendingInvitation, duplicateInBatch }` as an additive field.

### `groups.bulkInvite` audit `payload.source` is `"bulk-invite"`

**Decision:** the `member.invited` audit entries written by the bulk route carry an extra `source: "bulk-invite"` field on `payload` (alongside the standard `invitationId, code, targetUserId, roleId, expiresAt` fields). The single-shot `inviteByUserId` route does not emit this field.

**Rationale:**
- A future audit consumer (admin dashboard, analytics) needs a way to distinguish "this group received 50 bulk invitations from a CSV import" vs "this group received 50 individual invitations issued one-by-one." The two patterns mean different things operationally; the audit log is where that distinction belongs.
- An extra payload key is additive: existing audit consumers ignore unknown keys by convention, so adding `source` does not break the read side.
- The alternative (a new `member.bulk-invited` action on the union) was rejected because the *thing* that happened (a member was invited) is the same; only the *channel* differs. Splitting actions per-channel would multiply the union and force every audit-display layer to handle both names.

**Trade:** the audit table grows one extra small field per bulk-issued invitation. The size cost is negligible (jsonb storage on the existing column).

### SDK `HttpClient.postRaw` for non-JSON request bodies

**Decision:** the shared `HttpClient` grows a `postRaw(path, body, contentType)` method that bypasses JSON encoding. Bulk-invite uses it to send a `text/csv` body (string or `ReadableStream<Uint8Array>`). The original `request` / `post` / etc. methods are unchanged.

**Rationale:**
- The vast majority of SDK calls send JSON; keeping the default fast path simple is right. Adding a `rawBody` opt to the existing `request` method would clutter the call sites that do not need it.
- `postRaw` shares the response-parsing path with `request` (factored into a private `parseResponse` helper), so error handling stays identical: non-2xx responses still throw `JunjoError` with the server's code/status/message.
- Bulk-invite is the only V1 caller of `postRaw`. If a future surface needs raw uploads (file imports, image attachments), the same helper can support them; if no other caller appears, the helper stays a tiny dedicated leaf.

**Trade:** the `HttpClient` now has two POST methods. The naming distinction (`post` vs `postRaw`) is unambiguous and matches conventions like `node-fetch`'s `body` vs raw stream patterns.

### Role create + list are group-scoped; get / update / delete are by-id only

**Decision:** `roles.create` and `roles.list` live under `/v1/groups/:id/roles` (the group is part of the path). `roles.get`, `roles.update`, and `roles.delete` live under `/v1/roles/:id` (no group in the path). The VISION line "(except by-id get/update/delete which can also be `/v1/roles/:roleId`)" is read as "the by-id forms are the canonical placement", not "both forms exist."

**Rationale:**
- Role ids are globally unique cuids, so a group prefix in the by-id paths would force a redundant lookup with no actual scoping benefit. The by-id handler still enforces "calling-game scope" by joining through `Role.group.gameId`; it does not need the group id from the path to do so.
- `create` and `list` *do* need the group prefix because the create body would otherwise carry a `groupId` field (worse: a footgun if it disagreed with the path), and `list` is naturally group-scoped.
- One canonical path per operation keeps the routing table small and the SDK methods simple. When `roles.update(id, ...)` only takes an id, the SDK does not need a `groupId` parameter the dev would have to remember to thread through.

**Trade:** a dev who only has a `(groupId, roleName)` pair and wants to update the role must first call `roles.list(groupId)` to map the name to an id. That is rare in practice; UIs typically already carry the role id once they have rendered the role list.

### Group-scoped role routes (`POST /:id/roles`, `GET /:id/roles`) live inline in `groupsRouter`

**Decision:** the create and list routes for roles are added directly to `routes/groups.ts` (`groupsRouter`) rather than mounted as a separate sub-router. The wire-format helpers (`serializeRole`, `loadRolePermissionKeys`, `batchLoadRolePermissionKeys`) plus the by-id handlers live in `routes/roles.ts`.

**Rationale:**
- This matches the established Phase 2 pattern: `routes/members.ts` exports helpers (`serializeMember`, `loadMemberRoleIds`, `batchLoadMemberRoleIds`, `batchLoadExternalUserIds`) that are consumed by inline routes in `routes/groups.ts` (`/:id/members`, `/:id/members/:userId`, `PATCH /:id/members/:userId`); the standalone handler factories (`getMemberByIdHandler`, `listMembersForUserHandler`) live in `routes/members.ts` and are registered in `app.ts`.
- Mounting a separate sub-router at `/groups/:groupId/roles` collides with the existing `v1.route("/groups", groupsRouter(prisma))` mount; Hono's match-and-fallthrough semantics across sibling sub-apps with overlapping prefixes are easy to get wrong. Inlining sidesteps the question.
- The route logic is small (two handlers, ~50 lines total) and consumes the same `prisma.group.findFirst({ id, gameId, softDeletedAt: null })` lookup the rest of `groupsRouter` already does. Centralizing it keeps the lookup pattern in one place.

**Trade:** `groupsRouter` keeps growing. When it gets unwieldy (>1000 lines), factor it. Today's split is fine.

### Role `name` is unique within a group; duplicates return `role_name_taken`

**Decision:** `Role` has a `@@unique([groupId, name])` constraint in the Prisma schema. The create route pre-checks for a duplicate name and returns `409 role_name_taken` if one exists; the update route does the same when renaming. The same name is allowed across different groups.

**Rationale:**
- The schema's unique constraint already enforces this at the storage layer; without an explicit pre-check, a duplicate would surface as a `P2002` (Prisma's unique-violation error code) which the error middleware would render as a 500 (an unhelpful answer for a programmer error).
- `409 Conflict` is the right status: the request is well-formed but conflicts with current state. `role_name_taken` is more specific than the generic `bad_request` and lets callers branch.
- The same role name across different groups is fine because role ids are still unique. The dev's UI typically scopes role names to a single group anyway ("Officer of guild X" vs "Officer of guild Y" are distinct from the dev's perspective).

**Trade:** a TOCTOU race exists between the pre-check and the create transaction (two concurrent requests could both pass the check then race on the unique-constraint at insert time). The race is rare and the failure mode is benign: one request gets a 500 from `P2002`, the other gets a 201. If it becomes a real product issue, wrapping the create in `try/catch` and translating `P2002` to `role_name_taken` is the fix.

### Role `permissions` are not part of `roles.create` in V1

**Decision:** Phase 3.1 ships role CRUD only. The SDK `CreateRoleInput` type still carries a `permissions?: PermissionKey[]` field for forward-compatibility, but the SDK strips it from the request body before sending. The server's `createRoleBody` Zod schema does not list `permissions` (Zod silently strips unknown fields by default). Phase 3.3 (`roles.grantPermission` / `revokePermission`) is the dedicated path for populating role permissions.

**Rationale:**
- VISION's Phase 3.1 bullets list role CRUD only. Phase 3.3 explicitly owns the grant / revoke routes and the `permission.granted` / `permission.revoked` audit actions. Squeezing permissions into 3.1 would cross-cut the phase boundary and force the audit-action conventions for Phase 3.3 to land prematurely.
- Keeping `permissions` on `CreateRoleInput` (rather than removing it from the type) means the dev's existing TypeScript code does not regress when 3.3 lands. The SDK's drop-the-field behavior is a soft compromise: it does not throw on the field being present, but it does not deliver on it either.
- The alternative (server rejects the field with a 400) was considered but rejected: it would force every dev who set up a role with permissions to refactor every call site once Phase 3.3 lands. The silent drop is more forgiving; the docs are explicit about it.

**Trade:** a dev who reads only the type signature and not the docs may be surprised that their `permissions` array did not stick. Mitigation: the SDK page documents the silent-drop explicitly, and the server's `Role` response shape always returns `permissions: []` on a fresh role, so a follow-up `roles.get` confirms what was actually persisted.

### `roles.delete` blocks on assigned members; no soft-delete window for roles

**Decision:** deleting a role with at least one `MemberRole` assignment returns `409 role_has_members`. The role is preserved; the caller must reassign affected members (or remove the assignment) before the delete succeeds. There is no soft-delete window for roles; they are hard-deleted on success.

**Rationale:**
- VISION specifies the `role_has_members` error code explicitly ("Cannot delete a role if it has members assigned (error `role_has_members`); caller must reassign first"). The behavior matches: explicit blocker rather than silent cascade-to-null.
- A soft-delete window for roles would add a `softDeletedAt` column on `Role` and complicate every read path (the list, the get, the can() check) with "filter out soft-deleted." Roles are conventionally low-cardinality and high-stability; the cost of getting deletion wrong is recoverable by re-creating the role with the same name.
- Hard-delete writes a `role.deleted` audit entry containing the row's snapshot at the time of delete (`name, priority, color, isDefault`). A future "undelete" could read the audit log to reconstruct, if the need ever surfaces.

**Trade:** a dev who wants "soft" semantics for roles (so a renamed role does not break member.role assignments) needs to manage that themselves: rename the role rather than delete-and-recreate. Documented in the SDK page.

### `Role.isDefault` is a per-role tag, decoupled from `Group.defaultRoleId`

**Decision:** `Role.isDefault` is a boolean on each role; multiple roles in a group may carry it. `Group.defaultRoleId` is a single canonical FK to one role (the "default role for new members"). The two are stored independently; setting one does not affect the other.

**Rationale:**
- The schema has both fields. `Group.defaultRoleId` is the natural place for "which role gets auto-assigned to new members" because there is exactly one such role per group at any time. `Role.isDefault` is a more general tag the dev can use however they want (e.g. "this role is part of the default starter set" for a multi-default UX).
- Coupling them ("setting Role.isDefault=true automatically sets Group.defaultRoleId") would lose information (the dev could not tag two roles as default for a future multi-default UI) and would make the `roles.update` audit log noisy with cross-resource changes.
- The dev who wants the canonical "default role" sets `Group.defaultRoleId` via `groups.update`. The dev who wants the tag sets `Role.isDefault` via `roles.update`. The two are independent.

**Trade:** the surface area is slightly larger (two fields, two paths) but each carries clear meaning. The docs spell out the relationship so a dev does not get confused.

### `members.assignRole` and `removeRole` carry the role id in the path, not the body

**Decision:** the role-assignment routes are `POST /v1/groups/:id/members/:userId/roles/:roleId` and the matching `DELETE`. The role id lives in the path, alongside the group id and the user id. The body is empty.

**Rationale:**
- The triple `(groupId, userId, roleId)` uniquely identifies the join row. Putting it all in the path makes the URL itself a stable identifier for the assignment, which composes nicely with HTTP cache-control, audit-log filtering ("show me everything that touched `/v1/groups/X/members/Y/roles/Z`"), and SDK ergonomics (`junjo.members.assignRole(g, u, r)` is one positional call).
- The alternative (`POST /v1/groups/:id/members/:userId/roles` with `{ roleId }` body) reads the same on the wire but loses the URL-as-identifier property. It also forces the SDK to pass a body where none is needed.
- The shape is parallel to Phase 3.4 `POST /v1/groups/:id/members/:userId/permissions/:permission` for permission overrides; choosing the same pattern now keeps the surface internally consistent.

**Trade:** if a future "bulk assign" use case surfaces (assign 5 roles to a member in one call), it will not fit the per-role URL shape. Document a separate `POST /v1/groups/:id/members/:userId/roles/bulk` route at that point; do not retrofit the single-role URL.

### `role_group_mismatch` (400) is the explicit error for cross-group role assignment

**Decision:** when `assignRole` is called with a role id that exists but belongs to a different group than the member, the route returns `400 role_group_mismatch`. A role id that does not exist at all returns `404 not_found`.

**Rationale:**
- VISION explicitly calls out "can't assign role from a different group" as a tested case in Phase 3.2. The two failure modes (role exists but wrong group; role doesn't exist) are semantically different, and they call for different status codes:
  - Cross-group: the dev passed a programmer-error roleId that's wrong *for this context*. 400 with a code that names the cause is the right answer.
  - Missing: standard "resource not found", 404.
- A single status (e.g. all 404 with a generic message) would force the dev to guess which case they hit. The split is explicit and debuggable.
- Returning 400 also distinguishes this case from the existing collapsed-existence-pattern 404s used everywhere else (group missing / soft-deleted / cross-game / no-ExternalIdentity / no-GroupMember). The dev can branch on the code to decide whether to retry, fix their code, or surface the error to a human.

**Trade:** the route now has two failure paths to think about. The complexity is a one-time cost; the debuggability is recurring.

### `assignRole` and `removeRole` are idempotent (no-op when already in target state)

**Decision:** assigning a role the member already has, or removing a role the member doesn't have, returns the unchanged member with no audit entry written and no DB write. The HTTP status is `200 OK` in both cases (not 201 / 204).

**Rationale:**
- Idempotency makes role-assignment retryable. A network blip between the dev's backend and Junjo doesn't have to surface as a "duplicate role assignment" error if the second call is functionally a no-op. This matches the precedent set by `groups.delete`, `groups.restore`, `invitations.revoke`, `groups.leave`, `groups.kick`, and the metadata / notes diff in `members.setMetadata` / `setNotes`.
- Skipping the audit entry on a no-op keeps the audit log honest: a "role.assigned" entry implies the role *was* assigned; if it was already assigned, no new event happened, so no event row.
- Returning 200 with the unchanged member (rather than 201 or 304) means the SDK signature is uniform: `assignRole(...): Promise<Member>` always returns the post-state member. The caller doesn't have to branch on status to know what happened.

**Trade:** a dev who *wants* to know whether the call was a real change versus a no-op can't tell from the response alone. Mitigation: the audit log is the source of truth for "did this really happen"; if the dev needs to know whether to fire a downstream effect, they should inspect the audit log (or, post-Phase 5, subscribe to the SSE / webhook stream).

### `removeRole` does not validate the role's existence

**Decision:** `removeRole` does not look up the role separately. It just checks for a `MemberRole` row at `(groupMemberId, roleId)`. If the row doesn't exist, the route is a no-op regardless of why (role doesn't exist at all, role belongs to a different group, role exists in this group but isn't assigned to this member).

**Rationale:**
- The `MemberRole` join row is the only state that matters for "does this member have this role?". A missing row means "no", and the answer is the same regardless of whether the missing-ness is because the role doesn't exist, the role is from another group, or the role exists here but isn't assigned. Querying the role separately would add a query for no semantic benefit.
- Keeping the route maximally idempotent: `DELETE` on a resource that doesn't exist should be a no-op (per HTTP convention). The route already returns 200 with the unchanged member on the "role exists in this group but isn't assigned" case; extending the same behavior to the "role doesn't exist" case keeps the contract uniform.
- The SDK shape is unchanged: `removeRole(g, u, r): Promise<Member>` always resolves to the post-state member. No 404 to handle.

**Trade:** a dev who calls `removeRole` with a typo in the role id will not get an error. Mitigation: the audit log is empty (no `role.unassigned` entry), and the returned member's `roles` array is unchanged. If the dev expected the role to be there before the remove and the post-state shows it wasn't, they have a clear signal that something is off.

### `assignRole` and `removeRole` accept members in any status

**Decision:** the lifecycle gate (active / left / kicked / invited) is *not* enforced by the role-assignment routes. A member in any status can have roles assigned or removed.

**Rationale:**
- This matches the precedent set by `members.setMetadata` and `members.setNotes`: those routes also accept terminal-status members, leaving the lifecycle gate to `leave` / `kick`. Role assignment is conceptually similar metadata-on-a-member work; the same precedent applies.
- A dev's UI that displays a kicked member's role history (e.g. "this user was an Officer at the time of kick") is easier to build if the role assignments persist after the kick. Stripping roles automatically on kick would require a join-row cleanup that the schema doesn't currently model and that would lose audit information.
- Phase 3.5's `can()` check is the place where status matters: a kicked member has no permissions in the group regardless of which roles they nominally still have. The role join rows are bookkeeping; the live permission resolution is in `can()`.

**Trade:** the dev's UI may show "Officer" next to a kicked member's name unless the dev filters explicitly. Mitigation: the `Member.status` field is on the wire; the dev can branch on it. Phase 3.5 will document this expectation in the `can()` doc.

### `roles.grantPermission` and `revokePermission` carry the permission as a path param on revoke and a body field on grant

**Decision:** `POST /v1/roles/:id/permissions` takes the permission key in a JSON body (`{ "permission": "..." }`); `DELETE /v1/roles/:id/permissions/:permission` takes it as a path parameter. The two routes are intentionally asymmetric: the body form for grant, the path form for revoke.

**Rationale:**
- VISION specifies the asymmetric shape: "`POST /v1/roles/:roleId/permissions` with `{ permission }` (creates `RolePermission` row); `DELETE /v1/roles/:roleId/permissions/:permission`". I considered "harmonizing" both to body or both to path, but each shape is locally optimal.
- Grant carries a body so the route can reject empty / oversized keys at validation time before any DB work. A path-param grant would force the same validation but do it manually inside the handler (not unreasonable, but the JSON body path already runs the same Zod check used elsewhere).
- Revoke does not need a body: the path identifies the join row uniquely. Forcing a body for `DELETE` would also disagree with the convention used by `invitations.revoke` (`DELETE /v1/invitations/:code`) and `roles.delete` (`DELETE /v1/roles/:id`).
- The SDK signatures are uniform: `grantPermission(roleId, permission)` and `revokePermission(roleId, permission)` are both `(string, string) -> Role`. The wire-format asymmetry is invisible to the dev.

**Trade:** a dev who reads the route table without reading the docs may be briefly confused that the two routes mirror in shape but not in body / path placement. Mitigation: the API page documents both shapes inline; the SDK page hides it behind one method per direction.

### Permission key cap: 1-128 characters

**Decision:** permission keys are validated server-side at 1-128 characters. Empty keys and keys over 128 chars return `400 bad_request`.

**Rationale:**
- VISION leaves the cap unspecified. 128 is comfortably more than the role `name` cap (64) because permission keys conventionally use namespaced patterns ("guild.invite_member", "territory.claim", "treasury.read") that naturally run longer than role names.
- The cap matters because permission keys land in `PermissionDef.key` (indexed via the `@@unique([gameId, key])` constraint) and on the wire as path parameters in the revoke route. A multi-kilobyte key would bloat indexes, request URLs, and audit-log payloads.
- 128 is small enough to forbid pathological inputs and large enough that no reasonable convention will run into it.

**Trade:** a dev who chooses to hash a permission key into a long opaque token (rare but possible) may hit the cap. Mitigation: the dev can pre-hash to a shorter representation; this decision can also be revisited additively (raising the cap later is non-breaking).

### `roles.grantPermission` is idempotent (no-op when already granted)

**Decision:** granting a permission key the role already has returns the unchanged role with no audit entry written and no DB write. The HTTP status is `200 OK`. Same shape as `members.assignRole`, `groups.delete`, `groups.restore`, `invitations.revoke`, `groups.leave`, `groups.kick`.

**Rationale:**
- Consistency with the rest of the surface. Idempotent grant means a network blip / retry does not surface as a duplicate-key error; the dev's backend can safely re-issue without special-casing.
- Skipping the audit entry on no-op keeps the audit log honest: a `permission.granted` row implies the grant *happened*; a duplicate row would lie.
- Returning 200 with the unchanged role (rather than 201 / 304) means the SDK signature is uniform: `grantPermission(...): Promise<Role>` always returns the post-state role.

**Trade:** a dev who wants to know whether the call was a real change versus a no-op can't tell from the response alone. Mitigation: inspect the audit log (or, post-Phase 5, subscribe to the SSE / webhook stream).

### `roles.revokePermission` is idempotent (no-op when not granted)

**Decision:** revoking a permission key the role does not have (or that does not exist on this game at all) returns the unchanged role with no audit entry. The route does not 404 on "permission not found"; it just returns the post-state.

**Rationale:**
- Mirrors the `members.removeRole` precedent ("`removeRole` does not validate the role's existence"): the join-row state is the only state that matters. A missing `RolePermission` row means "no", regardless of whether the missing-ness is because the key is unregistered, registered but never granted to this role, or registered and previously revoked.
- HTTP convention: `DELETE` on a resource that does not exist should be a no-op.
- The SDK shape stays uniform: `revokePermission(...): Promise<Role>` always resolves to the post-state role.

**Trade:** a dev who calls `revokePermission` with a typo in the key will not get an error. Mitigation: the audit log is empty (no `permission.revoked` entry) and the returned role's `permissions` array is unchanged. If the dev expected the key to be there before the revoke, they have a clear signal.

### `PermissionDef` is auto-registered on first grant; revoke does not unregister

**Decision:** the first time a permission key is granted on a given game (across all roles), the route upserts a `PermissionDef (gameId, key)` row inside the same transaction as the `RolePermission` insert. Revoking the last grant of that key from any role does *not* delete the `PermissionDef` row; the registry preserves "every key this game has ever used" as a catalog for dashboards and SDK validators.

**Rationale:**
- VISION specifies: "The `permission` string is registered into `PermissionDef` automatically the first time it's used per game". The auto-register pattern keeps the dev experience friction-free: no separate "register this key" call, no surprising 404 the first time you grant a brand-new key.
- The upsert (rather than findUnique-then-create) collapses two queries into one and is robust against concurrent first-grants of the same key (Postgres serializes at the unique constraint).
- Not unregistering on revoke matches the Stripe / Auth0 catalog pattern: once a key has appeared, it stays in the registry. The dashboard's "permissions for this game" list should include keys that are currently revoked but were once used; a dev can re-grant without losing history. Auto-cleanup would also race with concurrent grants.

**Trade:** the `PermissionDef` table grows monotonically per game. For a dev who experiments with many one-off keys during development, this list will accumulate. If it becomes a real product concern, an admin endpoint can prune unused keys; we do not need it for V1.

### `grantPermission` and `revokePermission` return the updated `Role` instead of `void`

**Decision:** both methods return `Promise<Role>` (containing the post-state `permissions` array). The original stubs in the SDK declared `Promise<void>`; the return type changes as part of shipping the methods.

**Rationale:**
- Returning the post-state lets the dev render the new permissions list without a follow-up `roles.get`. The same pattern is used by `members.assignRole` / `removeRole` (returns `Member`), `groups.update` (returns `Group`), `roles.update` (returns `Role`), and so on.
- The wire is already an HTTP 200 with a JSON body in both directions; returning the body to the caller costs nothing.
- V1 is not yet released, so the stub-to-real type change is safe. The shared `@junjo/shared` types do not pin the return type: `RolesApi`'s signature lives in the SDK package, where this is an additive enrichment.

**Trade:** a dev who consciously wants to ignore the return value still can (`await junjo.roles.grantPermission(...)` discards it). The richer return type is opt-in.

### `members.overridePermission` and `clearPermissionOverride` URL shape

**Decision:** member-level permission overrides live at `POST/DELETE /v1/groups/:id/members/:userId/permissions/:permission`. The permission key is a path parameter on both verbs (mirroring `roles.revokePermission`), and the POST body carries only `{ grant: bool }`. The list endpoint is `GET /v1/groups/:id/members/:userId/permissions` (bare array, no pagination).

**Rationale:**
- The override is a `(member, permission)` pair, so putting both identifiers in the path matches the resource shape. The POST body is small (one boolean) and explicit.
- The asymmetry with `roles.grantPermission` (where the key is in the body) is intentional. Grant operates on a `(role, permission)` pair where the role id is the more "primary" identifier; for an override, the (member, permission) pair has equal footing in the URL. Keeping the permission as a path param makes the same URL idempotent for both `POST` (set or update) and `DELETE` (clear) on a single override.
- All three routes live inline in `groupsRouter` (consistent with `assignRole` / `removeRole`), since they share the same `groupId/members/userId` URL prefix and the same loading helpers (`findJunjoUserId`, `serializeMemberPermissionOverride`).

**Trade:** a dev who already calls `roles.grantPermission` will note the body-vs-path asymmetry. The SDK signatures are uniform (both take `(roleId, permission)` or `(groupId, userId, permission, grant)`), so the wire-format difference is invisible to most consumers.

### `members.overridePermission` is idempotent on matching `grant`; updates write `before` in audit

**Decision:** posting an override with the same `grant` as the existing one returns the unchanged override with no audit entry written and no `setAt` bump. Posting with a different `grant` updates the row, writes a `permission.override.set` audit entry whose `payload` includes `before: { grant }`, and bumps `setAt`. The first set on a member writes the audit entry without a `before` field.

**Rationale:**
- Matches the idempotency semantics of every other set / unset operation in the surface (`roles.grantPermission`, `members.assignRole`, `groups.delete`, etc.). A network blip / retry should not surface as a duplicate or a state change.
- The `before` field on update lets audit consumers reconstruct the override's history without joining over multiple rows. The first-set case has nothing to compare against; the subsequent `permission.override.cleared` audit carries the cleared-grant value via `payload.grant`.
- Skipping the `setAt` bump on no-op keeps "when was this set" honest: a re-post of the same value should not look like activity.

**Trade:** a caller cannot tell from the response alone whether their POST was a no-op, a fresh set, or an update. Mitigation: inspect the audit log (or, post-Phase 5, subscribe to the SSE / webhook stream).

### `members.clearPermissionOverride` returns 204 (not the cleared row)

**Decision:** clearing a member-level override returns `204 No Content`. The audit entry's `payload.grant` carries the previous value for consumers that need it; the wire response itself is empty.

**Rationale:**
- Consistent with other `DELETE` routes (`roles.delete` -> 204, `groups.delete?hard=true` -> 204, the soft-delete flow returns the soft-deleted group only because soft-delete is not a real delete). A real delete should not echo the deleted row.
- The SDK signature stays uniform: `clearPermissionOverride(...): Promise<void>`. A consumer that needs the previous `grant` for a UI confirmation can call `listPermissionOverrides` first, or pull from the audit log.
- Asymmetric with `roles.revokePermission` (which returns the post-state `Role`), but the asymmetry is structural: a role with a permission revoked still has a richer post-state (its other permissions, name, priority, etc.) worth returning; an override is just a `(member, permission, grant)` triple, and clearing it leaves nothing local to return.

**Trade:** consumers that want the previous `grant` need to either look it up first or pull it from the audit log. In practice the dev's UI knows what was there (it just rendered it), so this is rarely a real friction.

### `members.clearPermissionOverride` is a no-op on missing override

**Decision:** clearing a permission key the member has no override for returns `204 No Content` with no audit entry written. The route does not 404 on "override not found".

**Rationale:**
- Matches the `roles.revokePermission` precedent ("the join-row state is the only state that matters") and the `members.removeRole` precedent. `DELETE` on a resource that does not exist is conventionally a no-op.
- Avoids an existence-leak: a 404 response would tell a caller "yes there's a member here, but no override". The collapsed 204 response is consistent regardless.

**Trade:** a typo in the permission key won't surface as an error. Mitigation: the audit log is empty (no `permission.override.cleared` entry), and a follow-up `listPermissionOverrides` shows the member's actual overrides.

### Override `PermissionDef` registration matches `grantPermission`

**Decision:** the first time a permission key is used as a member-level override on a given game (regardless of whether it has been granted to any role yet), the override-set route upserts a `PermissionDef (gameId, key)` row inside the same transaction. Clearing the override does not unregister the key. The same registry table is shared with `roles.grantPermission`; whichever route first introduces a key on a game wins, and subsequent uses (in either route, on any role / member) are idempotent at the registry level.

**Rationale:**
- Consistency with the `roles.grantPermission` decision (auto-register on first sight, monotonic per-game catalog). A dashboard that lists "permissions known to this game" should see overrides-only keys too; if I gated registration on the role path only, a key used purely for overrides would be invisible.
- The registry is the source of truth for "every key this game has ever used." It does not care whether the key is currently granted to a role or set as an override; both are evidence the key exists.

**Trade:** none beyond what was already noted for `grantPermission`. The `PermissionDef` table grows monotonically per game; an admin endpoint can prune it later if needed.

### `MemberPermissionOverride.setBy` widened to `UserId | null`

**Decision:** the public `MemberPermissionOverride.setBy` field on `@junjo/shared` widens from `UserId` to `UserId | null` to match the V1 reality that no auth-adapter actor is wired yet (the dev's backend is the trusted layer; the route writes `setByUserId: null`). Parallels `Invitation.createdBy` (widened earlier) and `AuditEntry.actorUserId` (always nullable).

**Rationale:**
- V1 has no concept of "the override was set by user X" because no auth-adapter token is verified at the API boundary. Pretending otherwise would be a lie at the type level.
- Phase 6 (auth adapters) will wire a real actor. When that happens, `setBy` will start carrying the resolved external user id of the dev's backend's authenticated user (resolved via `ExternalIdentity` from the internal `JunjoUser` id stored in `setByUserId`).
- V1 is not yet released, so widening the type is safe (no existing consumers to break). The widening is "additive" in the sense that callers who relied on `setBy` being a string can handle `null` by branching.

**Trade:** a strict consumer that destructures `setBy` without a null check will need to add one. Mitigation: TypeScript flags the missing check at compile time.

### `PermissionCheckResult.source` taxonomy

**Decision:** the four `PermissionSource` values (`role`, `override`, `default`, `none`) carry distinct meanings:

- `none`: the user is not a member of the group, has no `ExternalIdentity` for this game, or is a non-active member (`left`, `kicked`, `invited`). `allowed = false`.
- `default`: the user is an active member with no override and no role granting this permission. `allowed = false`. This is the "default state" - no rule applies, so the answer falls through to false.
- `role`: at least one of the member's roles grants the permission. `allowed = true`. The route returns the highest-priority granting role in `viaRoleId` (priority desc, with role id desc as a tiebreaker).
- `override`: a `MemberPermissionOverride` row exists. `allowed` mirrors `override.grant`. Override beats role.

**Rationale:**
- The four-value taxonomy was already declared on the public type. This decision pins the runtime semantics so all consumers - the dashboard, the SDK admin tooling, future webhook event payloads - can branch consistently.
- Distinguishing `none` (not a member) from `default` (member with no rule) is useful for UX: "you can't do this because you're not in the guild" is a different message from "you can't do this because your role doesn't allow it".
- The highest-priority-role tiebreaker is deterministic so the answer is stable across ties; it has no semantic meaning beyond "pick one and stick with it." A debugger can read the priority hierarchy from `roles.list` if they want context.

**Trade:** a dev who wants to know *all* the roles that grant a permission has to call `roles.list` and filter client-side; the resolver only returns one. We could return an array later as an additive change.

### Non-active members short-circuit to `none`

**Decision:** the permission resolver returns `{ allowed: false, source: "none" }` for any member whose `status` is not `active` (i.e. `left`, `kicked`, or `invited`). The resolver does not consult role assignments or overrides for non-active members.

**Rationale:**
- A `kicked` or `left` user should not be able to exercise permissions, regardless of their stored role assignments. The lifecycle gate has to live somewhere; putting it at the resolver keeps `assignRole` / `overridePermission` permissive (they accept members in any status, matching the metadata / notes precedent) and centralizes the "is this member effective right now" check at the read path.
- Matches the conventional reading of "member status": active members participate, non-active members are historical.
- Soft-coupled with the `members.list` decision (returns rows in every status, no implicit `active` filter): the resolver enforces what the listing does not.

**Trade:** a re-joining user (Phase 2.4 currently rejects this; future re-join would set status back to `active`) would automatically regain their role-derived permissions without an extra step. That is the desired behavior; status is the gate.

### Permission cache: 60s TTL, in-memory, per-process, per-group invalidation

**Decision:** `GET /v1/permissions/check` reads through an in-memory `PermissionCache` (singleton in `packages/server/src/permissionCache.ts`) with a 60-second TTL. The cache key is `(gameId, groupId, externalUserId, permission)`. Mutations that can change a permission outcome (role assign / remove, role permission grant / revoke, member-level override set / clear, role delete) call `permissionCache.invalidateGroup(groupId)` after their transaction commits. This nukes every cached entry for that group.

**Rationale:**
- VISION specifies "in-memory, per-process, with TTL of 60s; invalidate on role/permission change events". The implementation matches.
- Per-group invalidation is the right granularity. A guild has at most a few hundred members; nuking ~hundreds of map entries on a role change is cheap. Per-member or per-(member,permission) invalidation would be more surgical but requires building a richer index over the cache; the value-add is small at V1's scale.
- The cache is per-process. A horizontally-scaled cluster gets eventual consistency across instances bounded by the TTL. V1 ships single-instance (matches PokeDnD pattern); Phase-12-ish horizontal scaling can layer Redis or pubsub-based invalidation if it becomes a real concern.
- The cache is unbounded in size (no LRU eviction). Entries expire naturally on TTL; in steady state the working set is bounded by the number of distinct `(member, permission)` pairs the dev's game queries inside any 60-second window. If a long-running process accumulates a large cache (e.g. a stress-test that probes thousands of permissions), entries still expire on read; we can layer in size-bounded eviction later if needed.

**Trade:** a stale answer can persist for up to 60 seconds if a row is mutated outside the API (direct SQL, for instance). We document this in both the API and SDK docs. Within the API, the cache is consistent: mutations invalidate before they return.

### `Junjo.can` and `Junjo.check` live on the top-level instance

**Decision:** `can` and `check` are methods on the `Junjo` class itself (not on a sub-namespace like `junjo.permissions.check`). The two are the shipped surface from Phase 3.5; `whoami` stays a stub for Phase 6.

**Rationale:**
- The stub for both methods has lived on `Junjo` since the SDK was first scaffolded; shipping them in place is the lowest-friction option.
- Permission checks are cross-cutting: they take a user id, a group id, and a permission key. They are not naturally a method of any one resource (it's not "check a group's permission for a user", and it's not "check a user's permission in a group" either - it's the resolution itself). Top-level matches the operation's shape better than wedging it under one of `groups`, `members`, or `roles`.
- Matches Stripe / Supabase / Clerk SDK conventions where cross-cutting verbs (`stripe.charge`, `supabase.auth.getUser`, `clerk.verifyToken`) live at the top of the SDK rather than nested in resource namespaces.

**Trade:** discoverability via IDE autocomplete is slightly weaker than a `junjo.permissions.*` namespace (a dev typing `junjo.p` does not see anything). Mitigation: the top-level methods table on the SDK index docs page calls them out, and `can` is the most obvious name for "is this allowed?".

### Group relationships are stored directed; mutual is a writer flag, not a stored property

**Decision:** `GroupRelationship` rows are stored directed (one row per A->B direction). When a dev calls `setRelationship(a, b, type, { mutual: true })` the route writes both A->B and B->A in the same transaction, but the rows themselves carry no "this is half of a symmetric pair" marker. Each row is independently fetchable, updatable, and clearable.

**Rationale:**
- The schema comment ("Stored *directed* (A -> B). Symmetric relationships are two rows") already pins this. Phase 4.1 honors it.
- Asymmetric relationships are a real use case (Minecraft Factions: A treats B as ally, B treats A as enemy; WoW factions can have one-sided diplomatic stances). A symmetric-only model would require fabricating a synthetic "I treat them as ally but they don't reciprocate" representation later.
- Storing the mutual flag on the row would create a coherence problem: what if the dev later updates only one side? The flag would lie. The directed model has no such problem.
- The audit log captures the `mutual` flag in the payload so consumers can tell whether a write was issued as a mutual call or a single-direction call.

**Trade:** a dev who wants the canonical "are these two groups allies in both directions?" view has to fetch two rows. We can add a `getMutualRelationship` helper later as additive sugar if it becomes common.

### `setRelationship` is per-direction idempotent and bumps `since` only when `type` changes

**Decision:** Each direction in `setRelationship` is checked independently. If the existing row already has the supplied `type`, that direction is a no-op (no DB write, no audit entry, no `since` update). If the type differs, the row is updated, `since` is bumped to the current time, and an audit entry is written for that direction's origin group. Mutual writes therefore can produce 0, 1, or 2 audit entries depending on which directions were no-ops.

**Rationale:**
- Idempotence matches the established precedent for permission grants / overrides / role assignments. Re-running the same call is harmless.
- Updating `since` on a type change reflects "the date this relationship took its current form"; re-confirming the same type does not constitute a new relationship event, so leaving `since` alone is correct.
- The audit log carries `before: { type }` only when the type changed; on a fresh insert the `before` field is omitted.

**Trade:** a dev who wants to "touch" the relationship to bump `since` without changing the type cannot do so via this route. That is intentional; if they want to record a "we re-confirmed the alliance today" event they can use the audit log's `payload` of a different action, or an out-of-band note.

### Self-relationships (a == b) are rejected with `400 bad_request`

**Decision:** `setRelationship`, `clearRelationship`, and `getRelationship` all reject calls where the two group ids are equal. `setRelationship` and `clearRelationship` return `400 bad_request`; `getRelationship` returns `404 not_found` (since "the row does not exist" is the more natural response for a read).

**Rationale:**
- A group having a relationship with itself has no semantic meaning. Allowing the row would just clutter the storage and audit log.
- The 400 / 404 split mirrors the established convention: writes return validation errors as 400, reads return missing-resource errors as 404.

**Trade:** none material. If a dev accidentally passes the same id twice, they get a clear error.

### `listRelationships` returns A-side rows only (the group's outgoing stance)

**Decision:** `GET /v1/groups/:a/relationships` returns rows where `groupAId = :a`. The reverse direction (rows where `groupBId = :a`) does not appear in this list.

**Rationale:**
- The natural reading of "this group's relationships" is "this group's stance toward others." A->B rows answer that question; B->A rows answer "what do other groups think about A?" - a related but distinct question.
- Symmetric pairs already produce two rows (one in each group's outgoing list); both groups see the relationship correctly via their own list.
- The B-side view is useful for "who has me in their list?" UX. We can add it as `?direction=incoming` later as an additive change without breaking V1 callers.

**Trade:** a dev who wants to see "all relationships involving this group" from one call has to also call `listRelationships` for each B that has rows pointing back, or wait for the future `?direction=incoming` flag. For most game UX (rendering the list of allies / enemies on a guild page), the A-side view is sufficient.

### `GroupRelationship.setByUserId` is widened to `String?` to match V1 reality

**Decision:** the `GroupRelationship.setByUserId` column is migrated to nullable. The shared TypeScript type `GroupRelationship.setBy` widens from `UserId` to `UserId | null`. V1's set-relationship route writes `null` for this field (no auth-adapter actor wired yet behind the API key boundary).

**Rationale:**
- Parallels `Invitation.createdByUserId` (widened in iteration 010) and `MemberPermissionOverride.setByUserId` (already nullable in the init schema): every "who took this action?" field is nullable while the auth-adapter actor pathway remains unwired.
- Keeping it `NOT NULL` would force the V1 route to fabricate a placeholder JunjoUser id, which would either leak the API-key abstraction or create ghost users.
- Phase 6 (auth adapters) will populate this field with the resolved JunjoUser id once the dev's frontend / SDK forwards a session token alongside the relationship-set call.

**Trade:** SDK consumers must handle `setBy: null` from V1 onward. This is additive (was previously typed as `UserId`, never undefined / null) and matches the established precedent for the other "actor" fields.

## 2026-04-28

### `groups.setParent` lives at `PUT /v1/groups/:id/parent`, not as a `groups.update` field

**Decision:** the parent / child hierarchy mutator is its own resource: `PUT /v1/groups/:id/parent` with body `{ parentGroupId: string | null }`. It is NOT a field on `groups.update`'s patch body.

**Rationale:**
- Cycle detection is a non-trivial transactional concern that has nothing to do with the rest of `groups.update`. Co-locating them would mean every `groups.update` call has to consider whether `parentGroupId` was supplied, even when it's a metadata-only or rename-only patch.
- The audit log gets two distinct actions (`group.parent.set` and `group.parent.cleared`) that are easier to filter on than a generic `group.updated` payload that happens to include `before/after.parentGroupId`.
- Mirrors the `groups.setRelationship` precedent: a graph-shaped mutation on a group lives at its own endpoint, not on the partial-update patch body.

**Trade:** a dev who wants to rename a group AND reparent it has to make two calls. Acceptable; the two operations are conceptually independent.

### `setParent` is idempotent on matching `parentGroupId`

**Decision:** when the supplied `parentGroupId` already matches the stored value, the route writes nothing (no DB update, no audit entry) and returns the unchanged group.

**Rationale:**
- Matches the established idempotence precedent for `groups.update` (no-op patches), `setRelationship` (already-matching type), `members.assignRole` (already-assigned), `members.overridePermission` (matching grant), `roles.grantPermission` (already-granted). The codebase pattern is consistent: rerunning a write that would not change state is a free no-op.
- Audit logs stay clean: a dev's idempotent retry doesn't pollute history with a string of "set parent to X (was already X)" entries.
- Including the no-op call in the cycle-detection short-circuit (which runs before the idempotence check anyway) means an idempotent call still validates the parent is reachable / live, so a stale parent reference doesn't silently survive.

**Trade:** none. A dev who genuinely wants to "touch" the parent without changing it has no need; there is no `since` field on the parent relation (unlike `GroupRelationship`) so there's nothing to bump.

### Cycle detection walks the candidate parent's ancestor chain with a depth cap

**Decision:** before persisting a `parentGroupId` change, the route walks the candidate parent's ancestor chain (one Prisma round-trip per ancestor) up to the `MAX_PARENT_DEPTH = 100` cap. If the child group itself appears anywhere in the chain (or if the candidate is the child directly), the call is rejected with `400 parent_cycle`. Self-parent (`parentGroupId === id`) hits the same error code.

**Rationale:**
- Pure reads, no schema-level constraint. Postgres's `WITH RECURSIVE` could shift this to one query but adds query complexity; per-level lookups keep the code legible and the chains are conventionally <10 levels deep (faction -> guild -> sub-guild -> ...).
- The depth cap is a defensive guard, not a feature limit. Reaching 100 levels would itself indicate corrupted state; the walk just bails rather than recursing forever. Practical hierarchies are far below this.
- Rejecting `self === parent` with the same `parent_cycle` code keeps the dev-facing error surface coherent: every "this would create a cycle" outcome is one code, regardless of the specific shape.
- A new error code (vs. reusing `bad_request`) lets the dashboard / SDK surface a specific message ("cycle detected: cannot nest A under B because B is already nested under A").

**Trade:** the per-level-round-trip approach scales O(depth) in queries, not O(1). For 100-level chains that's 100 reads per `setParent` call. Acceptable: the cap is rarely hit, and the code is dramatically simpler than the recursive-CTE alternative.

### Two distinct audit actions: `group.parent.set` and `group.parent.cleared`

**Decision:** every successful `setParent` write produces one audit entry on the *child* group's audit log. The action is `group.parent.set` when the new value is non-null, and `group.parent.cleared` when the new value is null. Payload is `{ before, after }` carrying the prior and new parent ids (either may be null on the `set` action when the child was previously top-level or is being re-parented).

**Rationale:**
- Mirrors the `permission.override.set` / `permission.override.cleared` and `group.relationship.set` / `group.relationship.cleared` precedents: distinct verbs for distinct user intent.
- A consumer building a "show me when this group joined an alliance" feed can subscribe to `group.parent.set` only; a consumer building "show me when this group went independent" can subscribe to `group.parent.cleared`. Coalescing into one action would force every consumer to check `payload.after === null` to disambiguate.
- The audit row's `targetId` is the new parent id (null when cleared). For `set` events that gives a quick way to filter "all groups that joined parent X" without parsing the payload.

**Trade:** the two-action design makes the `AuditAction` union slightly larger. Acceptable; the union grows additively as features land.

### `listChildren` returns direct children only (not grandchildren)

**Decision:** `GET /v1/groups/:id/children` returns rows where `parentGroupId === :id`. It does NOT recurse into grandchildren. A dev who wants the full tree calls `listChildren` per node.

**Rationale:**
- Recursive listing is a significantly different shape: depth-bounded? cycle-safe (relevant if data is corrupted)? sorted how? This route stays simple and predictable.
- Most game UX renders one level at a time (clicking into a sub-group expands its children). The flat one-level result matches the rendering model.
- A future `?recursive=true` flag (or a `?depth=N` cap) is an additive change; we can add it without breaking V1 callers.
- Matches the implicit precedent set elsewhere in the codebase: `members.list` returns rows for one group only (not "all members across all groups in the tree"); `audit.list` (Phase 5.2) is per-group too.

**Trade:** a dashboard rendering a multi-level tree pays N round-trips. Acceptable for V1; the future `?recursive` flag covers the case if it becomes hot.

### `Group.parentGroupId` is added to the wire format and the shared TypeScript type

**Decision:** the `parentGroupId: GroupId | null` field appears on every serialized `Group` (server `WireGroup`, SDK `WireGroup`, shared `Group` interface). It is NOT optional / nullable-by-omission; the field is always present (with a `null` value when the group is top-level).

**Rationale:**
- Matches the convention for `defaultRoleId`, `softDeletedAt`, and other "may or may not be set" fields: always present on the wire, value is `null` when unset.
- Makes the shape predictable for SDK consumers: no need to guard on `if ("parentGroupId" in group)`.
- The change is strictly additive in the shared `Group` type: existing code that didn't read the field continues to work.
- The server's `serializeGroup` helper centralizes the wire shape; downstream Prisma->wire conversions (groups.list, get, create, update, delete, restore, the new setParent) all flow through it and gain the field uniformly.

**Trade:** existing SDK test fixtures had to be widened (`parentGroupId: null` added to the snapshot). Trivial one-line update; caught at type-check time.

### Phase 5.1 splits: 5.1a hub + SSE endpoint, 5.1b mutation publishing, 5.1c SDK subscribe

**Decision:** the original Phase 5.1 bullet ("SSE event hub + `groups.subscribe`") is split across three iterations. 5.1a (this iteration) ships the in-process `EventHub` and the `GET /v1/events/:groupId` SSE endpoint with a 30s heartbeat. 5.1b wires `eventHub.publish(event)` calls into every mutation route that owns one of the `JunjoEvent` cases. 5.1c ships the SDK `groups.subscribe()` wrapper.

**Rationale:**
- The hub abstraction is independently testable: hub unit tests exercise the pub/sub semantics without any HTTP, and SSE integration tests drive the hub directly via `hub.publish(...)` to feed the stream. Splitting at this seam keeps the iteration well-scoped.
- Wiring publishing into ~12 mutation routes (group.updated, group.deleted, member.joined, member.left, member.invited, role.created, role.changed, role.deleted, permission.granted, permission.revoked, group.relationship.changed) is mechanical but lengthy; it deserves its own commit so the diff is readable.
- The SDK subscribe path needs an SSE parser, abort-on-cleanup, and reconnect semantics that each warrant their own thinking; bundling them with the server-side hub would make the iteration unfocused.
- The phase-3.x precedent (3.1 roles CRUD, then 3.2 assign/remove, then 3.3 grant/revoke, then 3.4 overrides, then 3.5 check) shows the loop comfortably digesting incremental phase splits.

**Trade:** PROGRESS.md grows three sub-checkboxes under one VISION bullet. Iteration 5.1b lands no new SDK surface (server-only); iteration 5.1c lands no new server surface (SDK-only). Acceptable: the original phase bullet stays unchanged in VISION.md, just split into sub-tasks in PROGRESS.

### `EventHub` is in-process and per-`groupId`; cross-process distribution is deferred

**Decision:** the V1 event hub lives in a single Node process. `EventHub.subscribe(groupId, listener)` and `EventHub.publish(event)` operate on an in-memory `Map<groupId, Set<listener>>`. Two server processes do not share state. Events that arrive while no subscriber is connected are dropped (no buffering, no replay).

**Rationale:**
- Single-process is the only deployment topology V1 actually supports today (the Phase 5.3 webhook worker is also in-process). Adding a transport-level bus pre-need would mean bringing a Redis or NATS dependency before there is a real horizontal-scale story.
- The transient drop semantic is the right behavior for the SSE consumer: live UX reads from the stream while a player is online, and the durable counterparts (audit.list in Phase 5.2, webhooks in Phase 5.3) cover everything that needs to survive a disconnect or a process restart.
- The `EventHub` interface is small enough that a Redis pub/sub or Postgres `LISTEN`/`NOTIFY` adapter can plug in behind the same shape later. The seam is preserved.
- Listener errors are swallowed: a misbehaving subscriber cannot starve the others. Hub consumers are responsible for their own observability (no central error reporting belongs in the bus).

**Trade:** horizontally-scaled deployments will need the transport adapter before SSE is reliable across instances. We accept the V1 limit and document it in `apps/docs/pages/api/events.mdx` so devs who hit it can plan around it (typically: deploy a single API instance, scale the webhook delivery worker separately).

### SSE wire format: `event:`, `data:` (JSON), `id:`; heartbeat is `:heartbeat`

**Decision:** each `JunjoEvent` is emitted as one SSE frame:

```
event: <type>
data: <JSON.stringify(event)>
id: <event.id>

```

The full `JunjoEvent` payload (including its discriminator `type` and its id) goes in `data:` as a JSON object. The `event:` line mirrors the discriminator for easier client-side switch statements; the `id:` line mirrors the event id for SSE's `lastEventId` mechanism. Heartbeats are SSE comments: a single `:heartbeat\n\n` frame, sent every 30 seconds.

**Rationale:**
- Putting the full payload in `data:` lets a client that ignores `event:` and `id:` still drive on the JSON's own `type` field, which is the source of truth in the shared `JunjoEvent` union. Clients that branch on `event:` get a slight ergonomic win.
- `JSON.stringify` automatically renders `Date` fields (`occurredAt`, nested `joinedAt`, etc.) as ISO 8601 strings. The wire format matches every other Junjo route's `Date`-as-ISO convention without a separate serializer.
- 30-second heartbeats are conservative enough to clear most reverse-proxy idle timeouts (60s is common, 90s for ALB). A shorter interval would burn bandwidth for no benefit; longer risks a connection drop on aggressively-tuned proxies.
- The `:heartbeat` comment is invisible to a compliant SSE client (per the W3C spec, lines starting with `:` are ignored). The string `heartbeat` after the colon is purely for human-readable wire dumps.

**Trade:** `id:` is included in every frame even though the V1 server does not honor `lastEventId` on reconnect. That is deliberate: the field is cheap to emit, and doing so now keeps the protocol forward-compatible when replay-on-reconnect lands.

### SSE endpoint 404-collapses missing / cross-game / soft-deleted groups synchronously

**Decision:** before opening any stream, the SSE handler runs the standard existence check (`prisma.group.findFirst({ id, gameId, softDeletedAt: null })`) and throws `Errors.notFound("group")` on miss. The 404 fires through the normal error middleware as a JSON error envelope; only after the group is verified live does the handler call `streamSSE(c, ...)` and upgrade to the event stream.

**Rationale:**
- Mirrors every other group-scoped read path. A bad request is much easier to debug as a `404 not_found` than as an empty stream that never delivers.
- Existence is not leaked: cross-game groups and soft-deleted groups collapse into the same `not_found` envelope as a fully missing id.
- Synchronous failure means the response carries the standard JSON body, not an SSE frame. Clients can branch on `response.headers.get("content-type")` to distinguish a stream from a structured error.
- Validating before subscribing also avoids a race where the handler subscribes the listener and then errors out, leaving an orphan subscription. The order is: validate -> subscribe -> stream -> deregister-on-abort.

**Trade:** none. The latency cost of one extra `findFirst` is negligible compared to the lifetime of an SSE connection.

### Heartbeat lives in `routes/events.ts` and uses `stream.write(":heartbeat\\n\\n")`, not `writeSSE`

**Decision:** the heartbeat comment is written via the lower-level `stream.write(...)` rather than via Hono's `writeSSE(...)` SSE-message helper. The handler runs its own `setInterval` (period = `heartbeatIntervalMs`, default 30s) inside the `streamSSE` callback; the interval is `unref`'d so it never keeps the Node process alive on its own, and `clearInterval` runs in the callback's `finally` block when the stream closes.

**Rationale:**
- Hono's `SSEMessage` shape (`{ data, event, id, retry }`) does not have a "comment" field. Writing a `:heartbeat\n\n` frame requires the raw `stream.write` escape hatch.
- The heartbeat is not data the consumer should see as an event. Going through `writeSSE` would inject an `event:` or `data:` line that compliant clients would interpret as a payload.
- An in-handler `setInterval` is the simplest fit: the listener is per-connection, the interval lifetime is exactly the stream's lifetime, and `unref` plus `clearInterval` in `finally` keeps the timer's lifecycle tied to the stream's.
- A write failure on the heartbeat is treated as a stream-aborted signal: the handler trips its `closed` flag, deregisters from the hub, and exits the read loop. This matches the behavior on `stream.onAbort`.

**Trade:** none. The `setInterval`-per-connection model is the same shape Hono's own SSE examples use; for a single-process V1 with O(N) live connections it is not a performance concern.

### `createApp({ events: { hub, heartbeatIntervalMs } })` is the test seam for SSE

**Decision:** `createApp(opts)` accepts an `events` sub-object with optional `hub` and `heartbeatIntervalMs` fields. Production calls `createApp()` without args and gets the module-level `eventHub` singleton plus the 30s heartbeat. Tests pass a fresh `EventHub` per test file plus a tiny heartbeat interval (e.g. 30ms) when they need to observe heartbeat behavior without sleeping.

**Rationale:**
- A fresh hub per test file isolates pub/sub state across test runs without needing a `beforeEach(() => hub.clear())` chant. Tests that DO want the singleton can import it and use it directly.
- The heartbeat interval is the only piece of the route's behavior that is wall-clock dependent; tests need it dialed down to milliseconds to stay fast. Threading the value through `createApp` keeps the production singleton untouched.
- The seam is narrow: only the SSE route's options object grows. `createApp` does not gain a generic plug-in mechanism. If future routes need similar test seams (e.g. webhook delivery's retry interval) they can add their own sub-objects.

**Trade:** the `CreateAppOptions` type grows a new optional field. Acceptable; the existing fields (`prisma`, `apiKeyStore`) follow the same per-feature opt-in shape.

### Phase 5.1b: mutation routes publish via a shared `publishEvent` helper after commit

**Decision:** every mutation route that has a corresponding case in the shared `JunjoEvent` union calls `publishEvent<E>(hub, payload)` after its database transaction commits. The helper lives in `packages/server/src/events.ts` and stamps a fresh `id` (24-char hex from `node:crypto`) and `occurredAt` (`new Date()`) onto the supplied payload before pushing it through the hub. Mutations whose audit action has no event-union counterpart (`groups.create`, `members.setMetadata` / `setNotes`, `roles.update`, `members.overridePermission` / `clearPermissionOverride`, `invitations.decline` / `revoke`) publish nothing; the audit log is the durable record for those.

**Rationale:**
- After-commit publish matches the precedent set by `permissionCache.invalidateGroup`: we never publish from inside the transaction so a rollback cannot stream a phantom event to subscribers.
- A single helper keeps the publish contract uniform: every route says "build the payload, hand it to `publishEvent`," and the helper handles the id and timestamp. Inlining the construction at every callsite was rejected because it would scatter the id-generation policy across 11 mutation handlers.
- The 24-char hex id is generated server-side without a database round-trip; randomness is sufficient since events are short-lived (they live only as long as a subscriber holds the connection in V1).
- Strictly tying "event in union" to "route publishes" keeps the SDK's `JunjoEvent` discriminator complete: a consumer that switches over every `type` is guaranteed to handle every event the server can emit. Adding a new event later (e.g. `role.updated`) is an additive minor-version bump.

**Trade:** publishing happens after the transaction, so a process crash between commit and publish loses the event for live SSE subscribers. The audit log (Phase 5.2) and webhook delivery (Phase 5.3) are the durable counterparts; the SSE wire is explicitly best-effort. Documented in `apps/docs/pages/api/events.mdx` under "Limitations."

### Brand-cast converters live in `events.ts`, separate from `serializeGroup` etc.

**Decision:** `events.ts` exports a parallel family of `toPublicGroup`, `toPublicMember`, `toPublicRole`, `toPublicInvitation`, `toPublicGroupRelationship` converters that turn a Prisma row into the `@junjo/shared` public type. These are NOT the same as the `serializeGroup` / `serializeMember` / etc. helpers in `routes/groups.ts` and `routes/members.ts`, which produce the wire-format types (`WireGroup` etc.) used in HTTP response bodies.

**Rationale:**
- `JunjoEvent` payloads are typed against the shared public types (`Group` with `Date` fields and branded ids), not the wire types (`WireGroup` with ISO strings). `JSON.stringify` later renders the Dates as ISO strings on the SSE wire, so the eventual on-the-wire shape matches the response-body shape, but the in-process type is the public one.
- Keeping the converters in `events.ts` (a shared module) instead of re-exporting from per-route modules avoids a circular dependency: `events.ts` cannot import from `routes/groups.ts` because `groups.ts` already imports from `events.ts` to call `publishEvent`.
- The converters are tiny (one-line brand casts plus the join columns the public type carries: `memberCount` for `Group`, `roles` for `Member`, `permissions` for `Role`); duplicating them is cheaper than a shared module gymnastics.

**Trade:** there are now two parallel serialization layers, wire (string dates, no brands) and public (Date, branded). They will both need maintenance when the underlying schema changes; the cost is roughly five lines of code per type per change.

### Hub is threaded into route factories via `createApp`, not pulled from the singleton inline

**Decision:** `createApp(opts)` resolves the hub once (`opts.events?.hub ?? eventHub`) and passes it explicitly to every router / handler factory that publishes events: `groupsRouter(prisma, hub)`, `acceptInvitationByCodeHandler(prisma, hub)`, `deleteRoleByIdHandler(prisma, hub)`, `grantPermissionHandler(prisma, hub)`, `revokePermissionHandler(prisma, hub)`. Read-only and no-event handlers (`getInvitationByCodeHandler`, `updateRoleByIdHandler`, `getMemberByIdHandler`, etc.) keep their original `(prisma)` signature.

**Rationale:**
- Tests need to swap the hub: `createApp({ events: { hub: customHub } })` is the established Phase 5.1a seam, and threading the same hub through to mutation routes lets event-publishing tests subscribe to the custom hub without colliding with the module singleton.
- Production wires the singleton in one place (`app.ts`) and never reaches into module state from inside a route handler. This matches the `prisma` and `apiKeyStore` patterns: dependencies cross the boundary at `createApp`, not via global imports.
- Adding `hub` only to the routes that need it keeps signatures minimal; `getRoleByIdHandler(prisma)` stays unchanged because it never publishes.

**Trade:** five factory signatures change in this iteration. Acceptable: `app.ts` is the only caller of these factories, so the blast radius is bounded.

### Idempotent / no-op routes do not publish

**Decision:** every route that already short-circuits on a no-op (matching-value PATCHes, already-deleted soft-delete, already-assigned role, already-granted permission, type-equal relationship set, missing-row relationship clear, leave / kick on already-non-active members) skips the `publishEvent` call too. The publish is gated on the same "actually changed" predicate as the audit-entry write, so the audit log and the event stream agree.

**Rationale:**
- Audit and events are siblings: a row in the audit log corresponds to an emitted event (when the union has a case) or to nothing (when it does not). Publishing on no-op would create "phantom" events with no audit row to back them, breaking the dashboard's audit-derived event log.
- SSE consumers writing optimistic UI logic should be able to trust that "I got an event" implies "something changed." A flood of no-op events would force every consumer to deep-compare to the prior state.
- The bulk-invite route that creates zero invitations also publishes zero events; this falls out of the "one event per created row" loop naturally.

**Trade:** none. Every existing test that exercises the idempotent path already asserts on no audit entry; this iteration adds the parallel "no event" assertion in `eventPublishing.test.ts`.

### `role.changed` covers role-assignment changes only; role-property edits emit nothing

**Decision:** the `RoleChangedEvent` (type `role.changed`) fires from `assignRole` (`added: [roleId]`) and `removeRole` (`removed: [roleId]`). `updateRoleByIdHandler` (`PATCH /v1/roles/:id` for renames / priority / color / isDefault edits) does not publish any event in V1.

**Rationale:**
- The shared `JunjoEvent` union has no `role.updated` case. The discriminator's name (`role.changed`) initially looks like it might cover role-property edits, but the payload (`{ userId, added, removed }`) makes clear it is per-member assignment, not per-role.
- Adding a new event type for role property edits is an additive minor-version bump that can land separately when there is a concrete consumer (the dashboard's "who changed officer color" feed, for example).
- Leaving the event off keeps Phase 5.1b's diff small and prevents an SDK change in this iteration; `@junjo/shared` stays at its current event union.

**Trade:** consumers who want a live signal for role property edits will need to read the audit log (`role.updated` is in the `AuditAction` union) until a follow-up adds the event.

### `group.deleted` fires for both soft and hard delete

**Decision:** the `DELETE /v1/groups/:id` route emits `GroupDeletedEvent` whether the deletion is soft (default) or hard (`?hard=true`). The event payload carries only `{ groupId, gameId }` with no flag distinguishing the two paths.

**Rationale:**
- Consumer logic is the same in both cases: stop showing the group, drop cached memberships, close any open SSE streams. The hard-vs-soft distinction lives on the database side and matters only for the 7-day undo window.
- The `JunjoEvent` shape (`{ id, gameId, groupId, occurredAt, type: "group.deleted" }`) has no extension point for a hard / soft flag without changing the shared type. Keeping the wire identical avoids that change.
- A soft-deleted-then-restored group emits `group.updated` on restore, which is what consumers need to re-show the group.

**Trade:** consumers that care about the hard-vs-soft distinction (a niche audit dashboard) need to read the audit log instead of the event stream. Acceptable.

### Restore emits `group.updated`, not a dedicated `group.restored` event

**Decision:** `POST /v1/groups/:id/restore` publishes a `GroupUpdatedEvent` carrying the post-restore group (with `softDeletedAt: null`). The shared `AuditAction` union has a dedicated `group.restored` action, but the `JunjoEvent` union does not have a corresponding `GroupRestoredEvent` type.

**Rationale:**
- A consumer's "reconcile after this event" logic is identical to a normal `group.updated`: re-render the group's metadata, re-mount its row in the directory listing. The discriminator string is the only piece that differs.
- Adding `GroupRestoredEvent` to the union for parity with the audit log is forward-compatible (additive minor-version bump). Skipping it for V1 keeps the union shorter and the SDK switch statements smaller.
- The `group.updated` event already carries the full post-state group, so a consumer can detect a restore by checking whether the prior state was soft-deleted (if it cares).

**Trade:** consumers that need to distinguish "restored from soft delete" from "renamed" need to read the audit log, where `group.restored` is a distinct action. Acceptable for V1.

### Phase 5.1c: SDK `groups.subscribe` is async; opens once, never auto-reconnects

**Decision:** `subscribe(groupId, handler, opts?)` is `async` and resolves to a `Subscription` (`{ close: () => void }`). The promise resolves once the server has accepted the SSE handshake; initial-handshake errors (`401`, `404`) reject the promise with `JunjoError`. Mid-stream failures (network drop, malformed frame, JSON parse failure) close the subscription and call `opts.onError`; the SDK does not attempt to reconnect.

**Rationale:**
- Awaiting the handshake is the only ergonomic way to surface `401` / `404`. A sync constructor that hands errors back via a callback (browser `EventSource` style) would force every caller to wrap in their own promise to detect "did this connection actually open?" The async signature matches the rest of the SDK and lets callers `try { sub = await ... } catch (e: JunjoError)` for the common case.
- No auto-reconnect because V1 has no replay-on-reconnect (per `apps/docs/pages/api/events.mdx` "Limitations"). A reconnect that silently drops events is worse than the SDK consumer making an explicit choice. Callers who want reconnect can build it on top: `onError` fires once per dropped connection, and `subscribe` can be called again to start a fresh stream.
- The `Subscription` interface is intentionally minimal (`close()` only). A future `pause()` / `resume()` is additive; we don't need it for V1's use cases (live UX in dashboards, mobile clients).

**Trade:** the original stub signature in the SDK was sync (`subscribe(...): { close }`). This iteration changes it to async (`Promise<Subscription>`). Acceptable: the method has been a `NOT_IMPLEMENTED` thrower since the SDK landed, no consumer has built against the sync shape.

### SDK SSE wire-types live in `events.ts`, not in `groups.ts`

**Decision:** the per-event wire types (`WireMemberJoinedEvent`, `WireGroupUpdatedEvent`, ...) plus the `WireJunjoEvent` discriminated union and the `deserializeEvent(wire)` function live in `packages/sdk/src/events.ts`. `groups.ts` imports them; the SSE parsing logic (`parseSSEFrame`) lives next to them.

**Rationale:**
- The wire types touch every other resource (`WireMember`, `WireRole`, `WireGroup`, `WireInvitation`, `WireGroupRelationship`). Putting them in `groups.ts` would force `groups.ts` to import from every other resource module, which it currently does not. Splitting them out keeps `groups.ts` focused on the groups REST surface.
- `events.ts` mirrors the server's `events.ts` (which holds the `publishEvent` helper and brand-cast converters). Symmetry: each side has one module that owns the event-shape transformation between Prisma rows / wire JSON and the public types.
- Future events that originate from non-group mutations (e.g., a global `webhook.delivered` if Phase 5.3 adds one) have a natural home without bloating `groups.ts`.

**Trade:** one extra file in the SDK tree. Worth it for the import boundary.

### `parseSSEFrame` lives in the SDK, not in a shared library

**Decision:** the `parseSSEFrame(block)` helper that turns one SSE event block into `{ event?, data?, id? }` lives in `packages/sdk/src/events.ts`. We do not depend on a third-party SSE-parsing library and do not share the parser across packages.

**Rationale:**
- The parser is ~15 lines (split on `\n`, dispatch on prefix). Adding a dependency for that much code is a bad trade: it grows the install footprint of every SDK consumer for negligible benefit.
- Existing libraries (`eventsource-parser`, `fetch-event-source`) target richer use cases (last-event-id replay, retry, connection state machines) that V1 does not need.
- Keeping the parser in-house lets us evolve it alongside the wire format. If the server adds a new SSE field (e.g., `retry:`), we update one file.

**Trade:** the parser is V1-shaped (no multi-line `data:` fan-out beyond the spec basics, no `retry:` honoring). When Phase 5.1d / 5.1e expands SSE semantics, the parser will need to grow.

### `HttpClient.openStream(path)` returns the raw Response with body open
**Decision:** the SDK's `HttpClient` grows a third method, `openStream(path, opts?): Promise<Response>`, parallel to `request` (JSON) and `postRaw` (non-JSON body). The method does a `GET` with the auth header, throws `JunjoError` on non-2xx (consuming the error body), and returns the `Response` with `body` still open on success. The caller is responsible for `res.body?.getReader()`.

**Rationale:**
- `subscribe()` needs three things from `HttpClient`: the `baseUrl`, the API key on every request, and the standard error envelope. Using a fresh `fetch` call inside `subscribe()` would duplicate all three. Exposing `openStream` keeps subscribe small.
- The method returns the raw `Response` rather than a parsed body because SSE consumers stream forever; there is no "parse the response" step. Reusing the JSON-parsing `parseResponse` would consume the body and break the stream.
- The signature is `Promise<Response>`, not `Promise<ReadableStream<Uint8Array>>`, so future call sites can read response headers (`content-type`, `last-event-id`, etc.) if they want.

**Trade:** the caller has to `res.body?.getReader()` themselves and handle the `body === null` case. Marginal; the alternative (a wrapper that returns the reader directly) loses the headers.

### Phase 5.2: `audit.list` paginates by `before` (timestamp), not by opaque cursor

**Decision:** `GET /v1/groups/:id/audit` accepts `?limit&before&actions[]`. `before` is an exclusive ISO 8601 timestamp filter; entries with `createdAt < before` are returned. `Page<AuditEntry>.nextCursor` is set to the ISO `createdAt` of the last item when more pages exist (otherwise `null`); the consumer feeds it back as `before` for the next page. This matches the VISION spec verbatim and the public `ListAuditOptions { before?: Date }` shape in `@junjo/shared`.

**Rationale:**
- Timestamp pagination is what audit log consumers naturally want: "give me everything that happened before this point in time." Opaque cursor objects don't compose with the dev's mental model ("show me audit entries from yesterday" -> `before = yesterday`).
- `Page.nextCursor` stays a `string | null` to match the cross-resource `Page<T>` shape; the SDK consumer treats it as opaque and reflects it back without parsing.
- A composite `(timestamp, id)` cursor would be more strictly correct (no skip on duplicate-millisecond entries), but adding a `cursor` query parameter would deviate from the VISION spec and double the surface for a rare edge case. Audit entries are written one per transaction, so collisions are uncommon enough to be a documented eventually-consistent property.

**Trade:** if two audit entries share `createdAt` to the millisecond (rare), the page boundary may skip one of them on the next call (since `before` is exclusive). Documented in `apps/docs/pages/api/audit.mdx` and `sdk/audit.mdx`.

### Audit action filter validated against an enum, not pass-through

**Decision:** the `?actions=` filter values are validated against the `AUDIT_ACTIONS` const list in `routes/audit.schema.ts`. Unknown values return `400 bad_request`. The list mirrors the `AuditAction` union in `@junjo/shared` and is kept in lockstep by hand.

**Rationale:**
- A typo in `?actions=members.invtied` should fail loudly, not silently match nothing. A 400 is the right shape for "you sent an invalid filter value"; a silent zero-row response would mask consumer bugs.
- Validating means the server owns the enum: if a future iteration adds a new `AuditAction`, the schema needs an explicit update. Forcing the touchpoint is cheap (one line) and avoids drift between the type union and the runtime check.
- Pass-through (accept any string) would let consumers query for actions that simply don't exist yet, which is forward-compatible-but-confusing. Better to opt-in to new actions when they ship.

**Trade:** every new `AuditAction` requires an `AUDIT_ACTIONS` array entry. Acceptable: it's right next to where the action is written.

### `routes/audit.ts` is a handler-only module; the route lives inline in `groupsRouter`

**Decision:** the audit list route (`GET /v1/groups/:id/audit`) is registered inline inside `groupsRouter` in `routes/groups.ts`; the handler logic itself (`listAuditForGroup(c, prisma, groupId)`) and the wire-format helper (`serializeAuditEntry`) live in `routes/audit.ts`. There is no `auditRouter` factory and no standalone-handler factory.

**Rationale:**
- The route is group-scoped (the path is `/v1/groups/:id/audit`), so it belongs in `groupsRouter` for routing-table coherence; `app.ts` already mounts `groupsRouter` at `/v1/groups` with the apiKey middleware.
- The handler is non-trivial enough (parsing, validation, querying, serialization) that it deserves its own module. Inlining the whole thing in `groups.ts` would push it over comfortable read length.
- The shape mirrors `routes/relationships.ts` (helper-only) more than `routes/invitations.ts` or `routes/members.ts` (mixed router + standalone handlers); both are valid patterns in the codebase.

**Trade:** the `groups.ts` import list grows by one (`listAuditForGroup`). Marginal cost.

### `audit.list` lives on `junjo.audit`, not `junjo.groups.audit`

**Decision:** the SDK method is `junjo.audit.list(groupId, opts?)`, on a top-level `audit` namespace, mirroring the typed stub that has lived in `index.ts` since the SDK first landed. It is not nested under `junjo.groups.audit(groupId)` even though every audit list call is group-scoped.

**Rationale:**
- The stub was already on `junjo.audit`; moving it would be a breaking API surface change. The stub never threw a useful error, but the namespace was reserved.
- `audit` is a cross-cutting concern that future iterations will extend (e.g., `junjo.audit.export()`, `junjo.audit.search()` if those land in the cloud-only phase). A dedicated namespace gives those methods a home that doesn't bloat `groups`.
- The first parameter being a `groupId` is consistent with `junjo.members.list(groupId, opts)`, `junjo.invitations.list(groupId, opts)`, etc; not every group-scoped read lives on `junjo.groups`.

**Trade:** the URL path (`/v1/groups/:id/audit`) and the SDK shape (`junjo.audit.list(groupId)`) don't directly mirror each other. The lookup-from-URL-to-method takes one extra hop. Acceptable given the cross-cutting nature.


### Phase 5.3 splits across two iterations: 5.3a (enqueue) ships before 5.3b (worker)

**Decision:** Phase 5.3 is broken into two iterations. 5.3a (this) wires every mutation route's published `JunjoEvent` to ALSO create one `pending` `WebhookDelivery` row per matching `WebhookEndpoint`. 5.3b will ship the actual HTTP delivery worker (poll, sign with HMAC, POST, retry with exponential backoff, transition status). 5.3c may further split out the `index.ts` bootstrap if the worker iteration grows too large.

**Rationale:**
- The enqueue-side and the delivery-side are independent units of work. Enqueueing is a Prisma `findMany` + `create` against an existing schema; delivery is HTTP, signing, retry state-machine, and a poll loop. Bundling both into one iteration would dilute review focus and make the commit hard to revert if either half misbehaves.
- The Phase 5.1 (SSE) precedent split into 5.1a/b/c. Same shape applies cleanly here.
- 5.3a is independently valuable: dashboards and admins can already see `WebhookDelivery` rows pile up, which surfaces "are events flowing through" without waiting on the HTTP worker. (The rows just stay `pending` until 5.3b lands.)

**Trade:** between iterations 5.3a and 5.3b, configured webhooks accumulate undelivered `pending` rows but nothing POSTs them. If Gabe wakes up between the two and tests with a real endpoint, nothing fires. Acceptable for an overnight loop; the gap is short.

### `dispatchEvent` wraps `publishEvent` plus the webhook enqueue

**Decision:** `events.ts` exports a new `async dispatchEvent<E>(prisma, hub, payload)` that calls `publishEvent(hub, payload)` then `await enqueueWebhookDeliveries(prisma, event)`. Every mutation route that previously called `publishEvent<X>(hub, payload)` now calls `await dispatchEvent<X>(prisma, hub, payload)` instead (~18 call sites across `routes/groups.ts`, `routes/invitations.ts`, `routes/roles.ts`). `publishEvent` itself remains exported as a hub-only helper for tests and any future consumer that wants pure SSE without a webhook side effect.

**Rationale:**
- One call site, one event, two delivery channels (SSE + webhooks). The dispatcher captures that invariant and keeps the call sites short. The alternative - calling `publishEvent` then `enqueueWebhookDeliveries` separately at every site - duplicates the wiring 18 times.
- Renaming `publishEvent` was tempting (since the function does more now) but `publishEvent` is now a perfectly accurate name for "broadcast to the in-process hub only." Keeping it lets niche callers opt out of the webhook side effect cleanly.
- Making `dispatchEvent` `async` means every call site grows an `await`. That's a mechanical change but it locks in the property that webhook enqueue completes before the route response is returned; no fire-and-forget races where the response arrives before the queue row is committed.

**Trade:** every mutation handler now awaits a webhook query, even when no endpoints exist for the game. The empty-endpoint short-circuit (`if (endpoints.length === 0) return []`) bounds this to one indexed `findMany` per mutation. For the no-webhooks-configured majority case this is a single round-trip with no transaction; not free but not measurable.

### `WebhookEndpoint.events` filter: empty array = match all

**Decision:** an endpoint with `events: []` matches every `JunjoEvent.type`. A non-empty array matches only the listed types. The Prisma filter is `OR: [{ events: { isEmpty: true } }, { events: { has: event.type } }]`.

**Rationale:**
- The schema comment said so already (`// Subset of event types this endpoint cares about. Empty = all.`). This decision just records the formal Prisma-level interpretation.
- Empty-as-default is the friendlier ergonomic for `webhooks.create({ url, events?: [] })` callers. "I want everything" is the most common case; making it the default avoids forcing dashboard users to enumerate the full `JunjoEventType` union.
- The alternative (treat empty as "match nothing") would silently drop all events for endpoints created without specifying `events`, which is a footgun.

**Trade:** there is no way to express "this endpoint cares about no events" via the `events` array alone; if a dev wants to mute an endpoint, they set `disabledAt` instead. Acceptable: muting is the right knob for "off."

### Webhook delivery payload is JSON-stringified-then-parsed for storage

**Decision:** `serializeEventForStorage(event)` does `JSON.parse(JSON.stringify(event))` and returns the result as `Prisma.InputJsonValue`. The stored payload has every `Date` field rendered as an ISO 8601 string, every branded id as a plain string, and is byte-identical to what the worker will eventually POST as the request body.

**Rationale:**
- Round-tripping through `JSON` is the simplest way to make sure the stored payload matches the wire format. Hand-rolling a per-event-type serializer would duplicate the SDK's `deserializeEvent` and risk drift.
- The cost (one stringify + one parse per delivery) is small compared to the database write itself.
- The stored payload IS what the worker POSTs verbatim; not constructing it again at delivery time means the HMAC signature can be computed once over a stable byte sequence (Phase 5.3b will store the signed body alongside the payload, but the payload is the ground truth).

**Trade:** the Prisma `Json` column type is "any JSON-serializable value," so we lose Postgres's strict-type checking on the payload column. Acceptable: the column is opaque to every consumer except the worker, which knows the schema from the originating `JunjoEvent` union.

### No-op routes that skip the audit / SSE event also skip the webhook enqueue

**Decision:** every mutation route that already short-circuits on no actual change (no audit entry written, no SSE event published) continues to short-circuit on the webhook side too, because the dispatcher is only called when the route reaches the publish step. There is no `enqueueWebhookDeliveries` call separately wired for the no-op branches.

**Rationale:**
- One source of truth for "did anything observable happen": the publish path. If the route decides nothing changed, neither the audit log, the SSE stream, nor the webhook queue records anything.
- Dispatch-via-`dispatchEvent` is the inversion of control: the route signals "this changed" by calling the dispatcher; the dispatcher fans out. Routes do not need to know about webhooks specifically.

**Trade:** webhook consumers that want "ping me on every successful API call regardless of state change" can't get that out of V1. The right knob for that is API access logs, not webhook events. Acceptable: webhooks are for state-change notifications, not request-trace fan-out.

### Webhook signing scheme: HMAC-SHA256 of `<timestamp>.<body>` with `v1=` scheme prefix

**Decision:** the webhook worker signs each request with HMAC-SHA256, hex-encoded, prefixed with the scheme version (`v1=`). The signed message is the timestamp string concatenated with a literal period and the JSON body bytes (`<x-junjo-timestamp>.<body>`). The signature ships in the `x-junjo-signature` header alongside `x-junjo-timestamp`, `x-junjo-event-id`, `x-junjo-event`, and `x-junjo-delivery-id`.

**Rationale:**
- Same shape as Stripe / GitHub / Slack webhooks. Devs who have integrated any of those will recognize the pattern immediately; the SDK helper Phase 5.4 ships matches the standard `verify(rawBody, headers)` signature.
- Binding the timestamp into the HMAC defeats replay attacks: a leaked signature is only valid for the small tolerance window the receiver enforces (5 minutes in `webhooks.verify`).
- The `v1=` prefix lets future schemes coexist (rotating the HMAC algorithm or moving to JWT-style tokens). The verifier rejects everything but `v1=` in V1.
- HMAC-SHA256 is already in `node:crypto`; no new dependency.

**Trade:** the HMAC scheme requires the server to retain the secret in recoverable form (not one-way hashed like the API-key path). The `WebhookEndpoint.hashedSecret` schema column is misnamed for that reason; Phase 5.5 renames it when it owns the dev-facing create flow that actually populates the column.

### Webhook retry policy: exponential backoff up to 6 attempts; 4xx is permanent

**Decision:** each `WebhookDelivery` is attempted at most 6 times. Wait between attempts: 1m, 5m, 30m, 2h, 8h. The 6th attempt is terminal regardless of outcome. A 4xx HTTP response (except 408 Request Timeout and 429 Too Many Requests) is treated as permanent failure: the delivery transitions straight to `failed` after the first attempt. A 5xx response, a 408, a 429, or a request that fails before a response arrives (network error, DNS failure, request timeout > 10s) is retriable.

**Rationale:**
- 4xx means "this request is malformed and nothing will change if you retry." Retrying wastes both sides' time. Stripe and GitHub treat 4xx the same way.
- 408 and 429 are exceptions: they signal transient conditions (slow request, rate-limited) where a backoff retry is the right move.
- 6 attempts spread across ~10.5 hours covers the operationally-typical "endpoint was down for a few hours and is now back" window without flooding when it stays down.
- Retriable network failures (no HTTP response) are common at scale; retrying them gracefully covers the long tail of transient infrastructure flakes.

**Trade:** a misconfigured receiver that 4xxes legitimate events permanently fails them on the first attempt; recovery requires the dev to fix the receiver and request a manual replay (Phase 5.5). Acceptable: alternative is wasting capacity on a request that has explicitly been rejected.

### Webhook worker: in-process `setInterval` polling, sequential delivery, no advisory lock in V1

**Decision:** the webhook worker runs as a `setInterval` inside the same Node process as the HTTP API (started by `startWebhookWorker(prisma)` from `index.ts`, stopped on SIGINT / SIGTERM). Each tick polls `WebhookDelivery` for `pending` rows whose `nextAttemptAt` has elapsed (capped at 50 per tick) and processes them sequentially. No `pg_advisory_xact_lock` is held in V1. Stops on signal handlers via the `WorkerHandle.stop()` returned to the bootstrap.

**Rationale:**
- Mirrors the `softDelete.ts` / `startHardDeleteSweeper` pattern: a single worker baked into the same image as the API. Self-hosters get the worker for free with no additional container.
- Sequential processing inside one process trivially serializes per-endpoint and per-event ordering without an explicit Postgres lock.
- The `pg_advisory_xact_lock` interface is the right tool when this scales to multiple worker processes; the V1 code is structured (one delivery per `deliverOne` call, with a clean function-level boundary) so the lock can be added later without restructuring.
- `setInterval` cadence at 5 seconds means the maximum end-to-end latency for a freshly-enqueued event is the polling interval plus the HTTP call; well under the 10-second timeout budget.

**Trade:** a horizontally-scaled deployment (two server processes) doubles polling load on the database and could double-deliver any event whose row state lags between processes. V1 deployments are single-process per the broader SSE-hub decision; webhooks inherit the same constraint. When that constraint lifts (Redis / advisory locks / a dedicated worker container), the worker function signatures stay stable.

### Webhook worker uses an injected `WebhookFetch` for testability instead of `globalThis.fetch` directly

**Decision:** `deliverOne` and `runWorkerOnce` accept an optional `fetch?: WebhookFetch` (and `now?: () => Date`) for testing. Production wires the default which wraps `globalThis.fetch`. The fake implementation in tests records calls and replays canned responses or thrown errors.

**Rationale:**
- Hitting real HTTP URLs from tests is fragile (DNS, network, port collisions); mocking via the standard injection seam matches the rest of the codebase (`PrismaClient` injection, `EventHub` injection, `WebhookFetch` is the third).
- The `WebhookFetch` interface is a strict subset of `fetch` (no body / no headers helpers), which lets tests verify exactly what the worker emits without simulating a `Response` body.
- Future use cases (a custom HTTP client with proxy / TLS pinning support) plug in via the same seam.

**Trade:** the type alias diverges from `fetch`'s actual return shape (a full `Response`); tests must remember to return `{ ok, status }` not a `Response`. Documented in the type and in the test helper.

### Phase 5.4 SDK `webhooks.verify` is async (returns `Promise<JunjoEvent>`) and uses Web Crypto, not `node:crypto`

**Decision:** `verifyWebhook(rawBody, headers, secret, opts?)` and `WebhooksApi.verify(...)` return `Promise<JunjoEvent>`. The HMAC computation goes through `crypto.subtle.importKey` + `crypto.subtle.sign` (Web Crypto API) rather than `createHmac` from `node:crypto`. The original stub signature was synchronous, but the stub was unimplemented so no consumer was relying on it.

**Rationale:**
- The SDK ships for both Node and the browser. Adding `@types/node` as a devDependency to the SDK package would tie the SDK's typecheck to Node's type definitions (which haven't been needed anywhere else in the SDK so far).
- Web Crypto is available natively in Node 19+ (released 2022) and every modern browser. The SDK's other globals (`fetch`, `TextEncoder`, `ReadableStream`) follow the same "available in both runtimes" pattern.
- The async API also future-proofs against keyed schemes that need async key import (e.g., asymmetric signatures via `crypto.subtle.importKey` with `RSA-PSS`).

**Trade:** the resulting `verify` is async, so callers MUST `await` it. Stripe's `webhooks.constructEvent` is sync (uses `node:crypto`); an existing user porting from Stripe will need to add an `await`. Documented in the SDK page and in the migration cookbook (Phase 13.4).

### Webhook signature scheme + headers are mirrored verbatim between server worker and SDK verifier

**Decision:** the SDK's `signWebhookBody(secret, body, timestamp)` produces the same `v1=<hex>` output as the server's `signWebhookBody` in `webhookWorker.ts`. The `WEBHOOK_SIGNATURE_SCHEME = "v1"` constant is duplicated rather than shared from `@junjo/shared`. `WebhookSignatureHeaders` in `@junjo/shared` is widened from 2 fields to all 5 headers the worker actually emits (`x-junjo-signature`, `x-junjo-timestamp`, `x-junjo-event`, `x-junjo-event-id`, `x-junjo-delivery-id`).

**Rationale:**
- The constant is small (one string) and the algorithms diverge across runtimes (`createHmac` vs `crypto.subtle.sign`); duplicating the constant alongside the algorithm is clearer than sharing the constant from a third package.
- Keeping the actual computation in two places makes drift visible: any change to the signing layout (e.g., adding the event id into the signed message) requires a touch in both files, which is a feature, not a bug. The SDK tests round-trip through both implementations.
- Widening `WebhookSignatureHeaders` to all 5 headers makes the type accurate for the verifier's input. The previous shape (`junjo-signature` / `junjo-timestamp` without the `x-` prefix) was an early stub that no consumer ever used.

**Trade:** if Phase 5.5 changes the scheme to `v2=...`, both files have to change; missing one site fails fast (signature mismatch on the next delivery). Acceptable.

### Webhook verifier rejects timestamps both too old AND too far in the future

**Decision:** the tolerance check is `Math.abs(now - timestamp) > tolerance` (bidirectional), not just `now - timestamp > tolerance`. Default tolerance is 5 minutes; configurable via `opts.tolerance`.

**Rationale:**
- One-sided tolerance protects against replay (old timestamps) but lets a sender lie about future timestamps to extend the replay window. Bidirectional protects against both.
- Stripe's verifier does one-sided; Svix does bidirectional. We follow Svix's lead because the asymmetric protection has a real attack vector even in V1.

**Trade:** receivers with clock skew larger than 5 minutes need to opt into a wider tolerance. Documented; alternative is to fix the receiver's clock.

### `webhooks.middleware` reads `req.rawBody` then `req.body` (string or Uint8Array); errors out on parsed JSON body

**Decision:** the Express middleware reads the raw body via three fallbacks in order: `req.rawBody` (set by some bodyparsers), `req.body` if it is a `string`, `req.body` if it is a `Uint8Array` / `Buffer`. Anything else (parsed object, `undefined`) responds 400 with a hint to add `express.raw({ type: "application/json" })` upstream.

**Rationale:**
- The signature is computed over the raw bytes; a parsed-then-re-stringified body has a different byte sequence (key order, whitespace) and the signature will not match. Refusing parsed bodies catches the most common misconfiguration eagerly with a clear error message.
- `req.rawBody` is the convention in some Express setups (e.g., Stripe's docs) where a JSON parser runs first but stashes the original bytes; we accept that path because some deployments cannot reorder middleware.

**Trade:** developers using a custom Express bodyparser that stores the raw body on a non-standard field have to either rename to `rawBody` or call `verify` directly. Acceptable; the manual call path is one line.

### Constant-time comparison is hand-rolled (XOR-and-OR loop) instead of `timingSafeEqual`

**Decision:** the SDK's `constantTimeEqual(a, b)` is a small hand-rolled loop: equal-length strings, XOR each char-code pair, OR-accumulate into a diff variable, return `diff === 0`. We do not import `timingSafeEqual` from `node:crypto`.

**Rationale:**
- `timingSafeEqual` is a Node-only helper that requires `@types/node` (see the async-Web-Crypto decision above).
- The loop is short enough to read at a glance. JS engine optimizations could in theory leak timing through branch prediction, but the typical webhook signature verification path is not a tight enough side-channel for this to matter in practice (the network round-trip dominates timing).

**Trade:** a sufficiently dedicated attacker with a high-precision side-channel could in principle extract timing information from the loop. Acceptable threat model for V1; the failure mode is a leaked HMAC byte, which by itself does not yield the secret. If this becomes a concern, swap in `crypto.subtle.timingSafeEqual` once Web Crypto adds it (in draft for the standard).

### Phase 5.5 renames `WebhookEndpoint.hashedSecret` -> `secret`

**Decision:** Phase 5.5 (this iteration) renames the `WebhookEndpoint.hashedSecret` Postgres column to `secret`. The column always stored the HMAC signing key in recoverable form (HMAC requires the secret on the signing side, unlike the API-key path which stores a one-way scrypt hash); the original name was inherited from the API-key model when the schema was first drafted. Migration `20260428110000_webhook_secret_rename` is one line: `ALTER TABLE "WebhookEndpoint" RENAME COLUMN "hashedSecret" TO "secret"`. The schema's `WebhookEndpoint.secret` field replaces `hashedSecret`; the worker, the new CRUD routes, and the existing test fixtures all use `secret`.

**Rationale:**
- The prior decision (Phase 5.3b) explicitly deferred this rename to Phase 5.5 because Phase 5.5 owns the dev-facing create flow that surfaces the secret. Without that flow, no one was ever going to read the column name; with it, a misnamed column would be confusing in dashboards and SQL audits.
- The rename is data-safe: `RENAME COLUMN` is metadata-only in Postgres (no row rewrite, no lock escalation). The migration runs in milliseconds even on production-scale tables.
- The `ApiKey.hashedSecret` column is not affected: that column truly stores a one-way hash and the name remains accurate.

**Trade:** any downstream consumer querying the column directly (none exist yet outside this repo) needs to update. The rename happens before the dev-facing surface ships, so external impact is zero.

### Phase 5.5: webhook endpoint CRUD lives at `/v1/webhooks` with the secret returned only on create

**Decision:** webhook endpoints are configured via four routes under `/v1/webhooks`: `POST /` (create), `GET /` (list), `PATCH /:id` (update), `DELETE /:id` (delete). The `secret` is returned exactly once, in the response body of `POST /v1/webhooks`. `GET` and `PATCH` responses omit it.

**Rationale:**
- "Surface the secret once at creation, never again" is the standard webhook UX (Stripe, GitHub, Discord). Devs persist the value into their secret manager on receipt; if they lose it, they create a new endpoint.
- The omission on `GET` reduces blast radius on a database leak: an attacker with a Postgres dump but no server access still cannot easily harvest active signing keys (they have to read the row directly, not just call the API).
- The route shape mirrors every other Junjo CRUD resource: per-resource path, per-method verb, calling-API-key scopes results to one game.

**Trade:** there is no "rotate secret" endpoint in V1. Devs who need rotation create a new endpoint and delete the old one. A future `PATCH /v1/webhooks/:id/rotate-secret` is additive and can land without breaking the V1 contract.

### Webhook endpoints take an explicit allowlist of `JunjoEventType` strings; unknown types are rejected at create / update time

**Decision:** the `events` field on `WebhookEndpoint` accepts only strings that appear in the `WEBHOOK_EVENT_TYPES` const enum in `routes/webhooks.schema.ts` (mirrors `JunjoEventType` in `@junjo/shared`). Unknown event types return `400 bad_request` with the Zod issue list. Empty array continues to mean "match all" (the iteration-029 decision).

**Rationale:**
- Storing an unknown string would silently fail to match anything; the dev would discover the typo only when their receiver never fires. A 400 at the create flow turns that silent failure into an immediate, actionable error.
- The const enum lives in the same module as the rest of the schema validation, so adding a new event type means adding it to the enum (one source of truth for the API surface). The `AUDIT_ACTIONS` const list (Phase 5.2) follows the same pattern; this is consistent.
- The cost is low: every Junjo deployment ships with the same set of event types, so a request-side validator does not split implementations across versions.

**Trade:** when a future event type lands, the schema enum has to be updated in lockstep. Acceptable; it is one line and the test suite covers it. Alternative (accepting any string) would let typos through silently and is strictly worse.

### `endpoints.update` PATCH is per-field-diff with full-replace semantics on `events`

**Decision:** `PATCH /v1/webhooks/:id` is a partial update. `url` rewrites the destination, `events` replaces the filter wholesale (an empty array clears it back to match-all), and `disabled` is a boolean toggle (`true` stamps `disabledAt = now()`, `false` clears it). At least one field is required (empty body returns 400). A no-op PATCH (matching url, events, and disabled with current state) is idempotent: no DB write, no audit, returns the unchanged row.

**Rationale:**
- `events` replaces wholesale because the alternative (delta semantics: "add X, remove Y") is harder to specify, harder to test, and harder for devs to reason about. Calling `update(id, { events: ["a", "b", "c"] })` is unambiguous; the result is exactly that filter.
- The `disabled: false` cycle is the recommended way to pause + resume a misbehaving endpoint without forgetting the `events` filter (which a delete + re-create would lose).
- Idempotency on no-op matches the precedent set by `groups.update`, `members.setMetadata`, and `setRelationship`: a PATCH that asserts the existing state should not generate audit log noise.

**Trade:** there is no audit entry for endpoint changes in V1 (webhooks are infrastructure, not domain events; the audit log is per-group). If observability of endpoint changes becomes important, a dedicated `WebhookEndpointAudit` table is the right shape; the existing `AuditEntry` is keyed on `groupId` and does not fit.

### `endpoints.delete` returns 404 on a missing id (no idempotent-on-missing-row contract)

**Decision:** `DELETE /v1/webhooks/:id` hard-deletes the row and cascades to any pending `WebhookDelivery` rows. A second DELETE on the same id (or a DELETE on an id that never existed) returns 404. This differs from `revokeInvitation` (which returns 204 on already-used codes for idempotency) and matches the `roles.delete` precedent.

**Rationale:**
- Webhook endpoints are stateful resources owned by the calling game; a DELETE that succeeded once is a strong signal that a stale id is in flight when the next DELETE comes in. Returning 404 surfaces that bug to the dev rather than silently swallowing the second call.
- The cascade through the FK relation handles the only edge case (in-flight pending deliveries) cleanly. There is no half-delete state to worry about.

**Trade:** retry-on-DELETE clients have to special-case 404 as success. The retry pattern for HTTP DELETE typically does this anyway (network failures can lose the original 204). Documented; the SDK's `endpoints.delete` propagates the JunjoError so callers can branch on `code === "not_found"`.

### `WebhookEndpointsApi` lives as a sub-namespace on `WebhooksApi`, not a top-level `WebhookEndpointsApi` instance

**Decision:** the SDK shape is `junjo.webhooks.endpoints.{create,list,update,delete}`. The `Junjo` class exposes `webhooks: WebhooksApi`; `WebhooksApi` exposes `endpoints: WebhookEndpointsApi` plus the existing `verify` / `middleware` instance methods.

**Rationale:**
- VISION explicitly specifies `junjo.webhooks.endpoints.{create,list,update,delete}`. The nesting groups every webhook-related dev surface (verify, middleware, endpoints) under one ergonomic root.
- The `WebhooksApi` constructor changing from `()` to `(http: HttpClient)` is a breaking change to anyone instantiating it directly; in practice, the only instantiation site is the `Junjo` constructor, so the impact is internal.

**Trade:** sub-namespacing on existing classes is a less common pattern than promoting siblings to the top level. We accept the inconsistency for the namespace ergonomics.

### Phase 6.1 jwtAdapter wraps `jose` as a runtime dependency of `@junjo/sdk`

**Decision:** the `jwtAdapter(opts)` implementation lives in `packages/sdk/src/adapters/jwt.ts` and uses `jose` (added as a regular dependency in `packages/sdk/package.json`, version `^6.2.3`). The adapter supports HMAC-SHA256 (`HS256`) plus the two asymmetric algorithms (`RS256`, `ES256`); for the asymmetric paths, the `key` option is a PEM-encoded SPKI public key. Configuration errors (empty key, unsupported algorithm, malformed PEM) throw `JunjoError({ code: "invalid_config" })`; legitimate verification failures (bad signature, expired, wrong `iss`/`aud`, missing claim) return `null` so the caller can branch uniformly on "session not authorized."

**Rationale:**
- VISION explicitly specifies `jose` as the JWT library for Phase 6.1 ("validates JWTs using `jose` (small, standards-compliant). Add as dep."). It is a pure-ESM library that runs identically in Node 20+ and modern browsers via Web Crypto, which matches the runtime portability story the rest of the SDK already commits to (see iter 027 / 031 decisions on Web Crypto over `node:crypto`). Hand-rolling JWT verification across three algorithms with claim validation is a security-sensitive path; "let `jose` do it" is the right call.
- `jose` ships a tiny core (~13 KB minified for the JWT verify subset) with zero transitive deps. Tree-shaking lets browser bundles drop the unused JWS / JWE / JWK helpers.
- Rather than installing `jose` as a peer dependency, we install it as a regular dependency: every consumer who imports `@junjo/sdk/adapters` paths through the JWT adapter today, and a peer dep would force every dev to install `jose` themselves for a single one-line import. The Clerk and Supabase adapters (Phase 6.2 / 6.3) WILL be peer deps because their packages are large and their use is opt-in.

**Trade:** the SDK package now installs `jose` even for consumers who only use Junjo for groups/permissions and never instantiate an auth adapter. The cost is small (~80 KB unminified) and the alternative (peer dep) trades one annoyance for another (devs forget to install it, the import fails at runtime). If the install size becomes a concern, the JWT adapter can move behind a `?optional` peer dep later, but that needs an SDK release with a deprecation notice.

### jwtAdapter pins the verifying algorithm

**Decision:** `jwtAdapter(opts)` requires `algorithm` (one of `"HS256"`, `"RS256"`, `"ES256"`); the verifier's `jwtVerify` call passes `algorithms: [opts.algorithm]` so a JWT signed with any other algorithm is rejected even if the key would technically validate it.

**Rationale:**
- The "alg=none" attack and the "RS256-as-HS256" key-confusion attack are both well-known JWT footguns when the verifier accepts the token's self-declared algorithm. Pinning the algorithm at adapter-construction time is the standard defense; it is one of the core selling points of using `jose` over hand-rolling.
- Devs who legitimately rotate algorithms (e.g., migrating from RS256 to ES256) deploy two adapters during the transition and try them in sequence (caller-side; not a concern for the SDK).

**Trade:** an issuer that legitimately mints both `HS256` and `RS256` tokens for the same audience requires two `jwtAdapter` instances on the receiving side. Acceptable; the alternative (allowing every algorithm the key supports) is the bug pattern this decision exists to prevent.

### jwtAdapter returns `null` on every verification failure; throws only on misconfiguration

**Decision:** `verifyToken(token)` returns `null` for: missing/empty/non-string tokens, malformed three-segment JWS, signature mismatch, expired tokens, future `nbf`, wrong `iss`, wrong/missing `aud`, missing or non-string user-id claim. The adapter throws `JunjoError({ code: "invalid_config" })` only when the static configuration is unusable: empty `key`, unsupported `algorithm`, malformed PEM block.

**Rationale:**
- The `AuthAdapter` interface is `verifyToken(token): Promise<{ userId } | null>`; the contract is "valid token -> userId, invalid -> null." Throwing on every parse failure would force every caller to wrap calls in try/catch and re-translate the error to the same null-vs-userId boolean.
- Configuration errors are a different category. They mean the deployed code cannot work for ANY token, ever; surfacing them at call time as `JunjoError("invalid_config")` makes them loud and correlated to a specific adapter instance.
- The PEM-import error path is lazy (deferred to first `verifyToken` call) so the constructor stays synchronous. The promise is cached so a misconfigured adapter throws on every call rather than silently degrading.

**Trade:** an SDK consumer who wants to surface "the token was expired" vs "the token signature was wrong" to end users cannot get that distinction from `verifyToken`'s return value alone. We accept that gap because the auth-adapter pathway feeds into Junjo's permission resolver, which only cares about "is this a valid user id." If a future use case needs verbose-failure-mode reporting, a second method (e.g., `inspectToken`) can be added additively without breaking the interface.

### jwtAdapter takes PEM SPKI for asymmetric algorithms; no JWKS endpoint support in V1

**Decision:** for `RS256` and `ES256`, the `key` option must be a PEM-encoded SPKI public key (the `-----BEGIN PUBLIC KEY-----` block). JWKS URLs (the `jose.createRemoteJWKSet` pathway) are NOT supported in V1; key rotation requires deploying a new adapter instance with the new public key.

**Rationale:**
- A surprisingly large fraction of JWT issuers in the small-game-developer niche either issue HS256 (shared secret) or hand out a static public key in their dashboard. JWKS rotation is more of an enterprise-auth concern and rarely matters for the V1 demographic.
- Adding JWKS support means adding a network fetch with caching, retry, and TTL semantics into the adapter constructor. That is a meaningful surface area expansion that we punt to Phase 6.4 (or whenever a real user asks for it).
- Devs who NEED JWKS support can build a thin wrapper: fetch the JWKS, pick the matching key by `kid`, construct a `jwtAdapter` per-request. Documented in the adapter's docs page.

**Trade:** providers that rotate signing keys frequently (Auth0 with rotating keysets, AWS Cognito) require a redeploy on every rotation. Acceptable for V1; the V2 helper or a second `jwtAdapterWithJwks` factory can land additively.

### `auth/` is a new top-level docs section; only `jwt.mdx` ships in this iteration

**Decision:** new `apps/docs/pages/auth/` directory with a per-adapter `*.mdx` page. `_meta.json` lists `jwt` for now; `clerk.mdx` and `supabase.mdx` will land alongside Phase 6.2 and 6.3. The top-level `pages/_meta.json` adds `"auth": "Auth"` between `api` and the not-yet-existing webhooks section.

**Rationale:**
- VISION's documentation discipline table explicitly maps "new auth adapter" to `apps/docs/pages/auth/<adapter>.mdx`. Following the prescribed shape.
- A separate `auth/` section (not a sub-page of SDK) is the right semantic placement: auth adapters are framework-shaped helpers that bridge the dev's existing identity provider to Junjo's `AuthAdapter` interface. They are not SDK methods on the `Junjo` instance.

**Trade:** none. The structure parallels how Stripe, Clerk, and Supabase document framework integrations (separate top-level section, per-framework page).

### clerkAdapter takes a function-shaped `verifyToken` option, not the Clerk client

**Decision:** `clerkAdapter(opts)` takes `{ verifyToken: (token: string) => Promise<payload>, userIdClaim?: string }`. The dev wires `@clerk/backend`'s standalone `verifyToken` into `opts.verifyToken`, pre-bound to their secret key (and optionally their audience / authorized parties). The adapter does not import `@clerk/backend` directly; the package stays a peer dep, not a regular dep.

**Rationale:**
- `@clerk/backend` v1+ exposes `verifyToken` as a standalone function, not as a method on a client object. Modeling the adapter input as "the Clerk client with a `.verifyToken` method" (the original stub's `ClerkLike` shape) didn't match the real package's API surface.
- A function-shaped option lets the dev decide which Clerk-specific options to bind (audience, authorized parties, JWT key from a custom key resolver). Re-exposing all of them on the adapter would lock Junjo to one specific `@clerk/backend` version.
- VISION explicitly says "Wraps `@clerk/backend` (peer dep, not direct dep, so users without Clerk don't pay the install cost)." The dev installs `@clerk/backend` themselves; the adapter is six lines of glue code in their app.

**Trade:** the dev writes two extra lines of integration code (the wrapping function literal). Acceptable; it is the same shape every Clerk integration uses with Express, Next.js middleware, etc.

### clerkAdapter throw-vs-null contract matches jwtAdapter

**Decision:** `clerkAdapter`'s `verifyToken` returns `null` for every legitimate verification failure: empty/non-string token; the wrapped Clerk verifier throws (any error); the wrapped verifier resolves with `null` or `undefined`; the configured user-id claim is missing, non-string, or empty. It throws `JunjoError({ code: "invalid_config" })` only when the static configuration is unusable (`opts.verifyToken` is not a function).

**Rationale:**
- Mirrors `jwtAdapter` (Phase 6.1 decision) so the throw-vs-null contract is consistent across every built-in adapter. Devs can safely uniformly treat `null` as "session not authorized" without per-adapter branching.
- Catching arbitrary errors from the wrapped verifier is a deliberate trade. Network errors against Clerk's JWKS endpoint, programmer errors in the wrapper, and "token signature mismatch" all collapse to `null` here. Documented in the failure-mode section of `apps/docs/pages/auth/clerk.mdx`. The alternative (re-throwing programmer errors) would force every caller to wrap calls in try/catch, which defeats the purpose of the adapter contract.
- Logging hooks for the swallowed errors are deferred to V2 (not in scope; would require an opt-in `onError` callback on the options bag).

**Trade:** a programmer error inside the user's `verifyToken` wrapper (e.g., a typo in their secret key env var) silently appears as "user not authenticated" rather than crashing on first call. The dev sees the symptom (no users authenticate) before they see the cause. We accept this; the alternative is leaking stack traces from a function we don't own.

### clerkAdapter exposes `userIdClaim` for parity with jwtAdapter

**Decision:** the adapter accepts an optional `userIdClaim` (defaults to `"sub"`). Devs using a custom Clerk session-token template that puts an internal id under a different claim (e.g., `app_user_id`) can override the read path without writing a custom adapter.

**Rationale:**
- Clerk's session templates let you forward arbitrary claims into the JWT; many production apps use them to embed an internal database id alongside Clerk's `user_2abc...` id.
- Parity with `jwtAdapter`'s `userIdClaim` keeps the adapter mental model uniform. A dev who has used `jwtAdapter` will reach for the same option name on `clerkAdapter` and find it.
- The cost is one line of indirection (`payload[userIdClaim]` instead of `payload.sub`); zero runtime cost in the default path.

**Trade:** none meaningful. The default behavior is unchanged from "read `sub`."

### clerkAdapter does not surface Clerk's audience / authorizedParties options

**Decision:** Clerk-specific verification options (`audience`, `authorizedParties`, custom JWT key, etc.) are configured on the `verifyToken` wrapper that the dev passes in, not on the adapter's options bag. The adapter only sees the resolved payload.

**Rationale:**
- These options live in `@clerk/backend`'s API surface and evolve across major versions. Re-exposing them on the adapter would either pin Junjo to one Clerk version or churn the adapter every release.
- The dev already controls the wrapper function; binding their own audience there is the natural place. The doc page makes this explicit with a code example.
- Keeps the adapter API minimal and forward-compatible.

**Trade:** the adapter cannot, on its own, enforce that the dev configured an audience. A misconfigured wrapper (e.g., omitting `audience` when their auth setup requires it) silently passes verification. Acceptable; this same trade exists with any wrapped library, and the cost of re-exposing the full Clerk options surface in the adapter is high.

### `apps/docs/pages/auth/_meta.json` adds `clerk` after `jwt`

**Decision:** the `auth/` section's nav order is `jwt` then `clerk`. Supabase will land alongside Phase 6.3 in the same alphabetical-by-default-with-jwt-first order.

**Rationale:**
- `jwt` is the most general adapter (covers any provider that mints JWTs); presenting it first surfaces the broadest applicable answer to "which adapter do I want?"
- Provider-specific adapters (Clerk, Supabase) are alphabetical underneath. As more land, this ordering scales without re-shuffling existing entries.

**Trade:** none. Pure docs nav choice.

### Phase 6.3 supabaseAdapter takes the Supabase client directly, not a function-shaped wrapper

**Decision:** `supabaseAdapter(opts)` takes `{ client: SupabaseClientLike, userIdField?: string }`. The dev constructs their `@supabase/supabase-js` client at app startup and passes it to the adapter; the adapter calls `client.auth.getUser(token)` on every verification. `@supabase/supabase-js` stays a peer dep, not a regular dep.

**Rationale:**
- VISION explicitly specifies "Wraps `@supabase/supabase-js` (peer dep)" and "Calls `supabase.auth.getUser(token)` and returns the user id." The natural Supabase usage is "construct a server-side client with a service-role or anon key, then validate user JWTs through it"; taking the client directly matches that mental model and means the same client can be reused for any other Supabase calls in the dev's backend.
- `clerkAdapter` (Phase 6.2) took a function-shaped `verifyToken` because `@clerk/backend` reshaped its API in v1+ (method-on-client became a standalone function). Supabase's `auth.getUser(token)` has been stable since `@supabase/supabase-js` v2 launched, so the API-stability concern that motivated the function-shape choice on Clerk does not apply here.
- The structural typing on `SupabaseClientLike` accepts any object with an `auth.getUser(token)` method; devs who want to inject test fakes or wrap the real client to remap fields can do so without a separate factory shape.

**Trade:** if `@supabase/supabase-js` ever reshapes the `auth.getUser` response envelope, the adapter and every consumer break together until the structural type is updated. Acceptable for V1 because the API is well-established; switching this adapter to a function-shaped option later is an additive change behind a deprecation cycle.

### supabaseAdapter throw-vs-null contract matches jwtAdapter and clerkAdapter

**Decision:** `supabaseAdapter`'s `verifyToken` returns `null` on every legitimate verification failure: empty/non-string token, `client.auth.getUser` throws, the response carries `error`, the response has `data` missing or null, `data.user` is null, the configured user-id field is missing / non-string / empty. It throws `JunjoError({ code: "invalid_config" })` only when the static configuration is unusable: `client` is missing, `client.auth` is missing, or `client.auth.getUser` is not a function.

**Rationale:**
- Mirrors `jwtAdapter` (Phase 6.1) and `clerkAdapter` (Phase 6.2) so the throw-vs-null contract is consistent across every built-in adapter. A dev branching on `await adapter.verifyToken(token)` works the same way regardless of which adapter is wired up.
- Supabase distinguishes "auth rejected the token" from "user does not exist" via the `error` field on the response, but both shapes are functionally equivalent to "this caller is not authorized" for Junjo's purposes; collapsing them into `null` keeps the contract simple. The alternative (returning structured failure reasons) would couple the SDK type to provider-specific error taxonomies.
- Catching network errors as `null` is a deliberate trade. A transient outage between the dev's server and Supabase's auth API surfaces as "user not authenticated" instead of a thrown stack trace; that is the same trade `clerkAdapter` makes against Clerk's JWKS endpoint, and it preserves the adapter contract.

**Trade:** transient network errors against Supabase's auth API silently appear as "user not authenticated" instead of crashing the request. Acceptable; the alternative leaks provider-specific error shapes through Junjo's interface, and the dev can build their own retry / circuit-breaker around the adapter if they need different behavior.

### supabaseAdapter exposes `userIdField` for parity, but only for top-level fields

**Decision:** the adapter accepts an optional `userIdField` (defaults to `"id"`). Devs who store an internal id on the User record under a different top-level field can override the read path. Nested fields under `app_metadata` or `user_metadata` are not supported in V1; devs who need them must wrap the client themselves.

**Rationale:**
- Parity with `jwtAdapter.userIdClaim` and `clerkAdapter.userIdClaim`. The option is named `userIdField` rather than `userIdClaim` because the value comes from a User record (a JS object with named fields), not a JWT payload (a "claims" object); the wording matches the data model the dev sees in Supabase's docs.
- Supporting a path expression (`app_metadata.app_user_id`) would force every other adapter to either pick up the same syntax (drift) or stay simple (asymmetry). Wrapping the client at integration time is the natural place to flatten / remap nested fields, and the cost (a 10-line client wrapper) is documented in the adapter's docs page.
- Most apps that adopt Supabase Auth use the default `id` field (Supabase's user UUID); the override path serves the small fraction that have a separate internal id.

**Trade:** apps that store their internal user id under `app_metadata.app_user_id` (a Supabase-conventional pattern) write a 10-line wrapper instead of a one-line option override. Acceptable; the wrapper is reusable and the alternative (a path-expression syntax) leaks complexity into every adapter.

### `apps/docs/pages/auth/_meta.json` adds `supabase` after `clerk`

**Decision:** the `auth/` section's nav order is `jwt`, `clerk`, `supabase`. Future provider-specific adapters land alphabetically underneath, with `jwt` permanently pinned first.

**Rationale:**
- Continues the iter-033 nav decision: most-general-first (`jwt`), then alphabetical for provider-specific entries. Supabase falls naturally after Clerk in alphabetical order.
- Pinning `jwt` first keeps the broadest applicable answer at the top of the nav for newcomers asking "which adapter do I want?"

**Trade:** none. Pure docs nav choice.

### supabaseAdapter does not cache verifications

**Decision:** the adapter calls `client.auth.getUser(token)` on every verification with no caching layer. Devs who need caching wrap the adapter themselves (or wrap the client) with their preferred TTL / invalidation policy.

**Rationale:**
- Supabase's auth API call is a network round trip on every verification, which is the highest-cost path in the adapter; in steady-state production this can be 10-50ms per call. Caching can dramatically improve throughput, but the right cache shape (TTL, key, invalidation on logout) depends entirely on the dev's session-lifetime tolerance and security model.
- A built-in cache would force one policy on every consumer, and worse, would make per-request authorization decisions on stale data unless the dev opted into invalidation hooks. The right default in V1 is "no cache, fully consistent with Supabase."
- Documented in the adapter's docs page so devs are not surprised by the cost.

**Trade:** high-traffic apps pay a Supabase round trip per request. Acceptable for V1; the adapter is correct by default, and caching is an additive concern that the dev controls.


### Phase 7.1 `JunjoProvider` takes `client` (not `value`) and accepts a constructed `Junjo` instance

**Decision:** `JunjoProvider` is a thin `<Context.Provider>` wrapper that takes `{ client: Junjo, children }`. The dev constructs a `Junjo` instance somewhere outside the React tree (typically once at app startup) and passes it in. `@junjo/react` does not own the SDK instances lifecycle.

**Rationale:**
- The SDK can be used independently of React (Node servers, edge functions, scripts that share a module with React components). Coupling instance construction to a React component would force every non-React caller to ignore that path or duplicate it.
- Naming the prop `client` rather than `value` follows the convention set by Stripes `<Elements stripe={stripe}>`, Apollos `<ApolloProvider client={client}>`, and React Querys `<QueryClientProvider client={qc}>`. Devs who have wired one of these before recognize the shape immediately; `value` would echo the underlying `Context.Provider` API and obscure intent.
- A future option to accept a `JunjoConfig` (so the provider constructs the client itself) would be additive on top of `client`. Starting with the explicit instance keeps V1 surface small.

**Trade:** devs see two layers (`new Junjo(...)` then `<JunjoProvider client={...}>`) instead of one. Acceptable; the trade buys reusability across non-React surfaces and matches industry-standard patterns.

### `useJunjo` throws when used outside a provider rather than returning `null`

**Decision:** `useJunjo()` reads from `JunjoContext` and throws `Error("useJunjo must be used inside a <JunjoProvider>")` when no provider is in scope. The hook never returns `null` or `undefined`.

**Rationale:**
- The downstream hooks that will land in Phases 7.2-7.5 (`useGroup`, `useCan`, `useMembers`, etc.) all assume a non-null `Junjo`. If `useJunjo` returned `Junjo | null`, every dependent hook would either replicate the null check or accept silent no-op behavior on misuse. Throwing once at the boundary keeps the rest of the React surface free of defensive branches.
- Calling a hook outside its provider is a programmer error, not a runtime condition. Throwing at the call site surfaces the mistake the first time it is wired, with a stack trace pointing directly at the offending component, instead of producing a confusing "nothing happens" symptom.
- The error message names the hook AND the provider so the fix is one search away.

**Trade:** SSR / pre-render paths that mount `<JunjoProvider>` only on the client need to either render the consumer subtree client-side too or short-circuit before the hook call. Standard React pattern; no special handling required.

### `JunjoContext` is module-private; only `JunjoProvider` and `useJunjo` are exported

**Decision:** `JunjoContext` lives in `packages/react/src/context.ts` but is NOT re-exported from `packages/react/src/index.ts`. Consumers can only interact with it through `JunjoProvider` (write side) and `useJunjo` (read side).

**Rationale:**
- Hiding the context object preserves the freedom to change the internal shape later (wrap in another provider, switch to a multi-context pattern for SSE subscriptions, etc.) without breaking callers.
- Devs who think they need direct context access for a custom edge case almost always actually need a new typed hook; bottling that motivation into a future PR is fine.

**Trade:** a small fraction of advanced devs may want to consume the context directly (e.g., to feed it to a non-hook code path inside a class component). Acceptable; the workaround is to wrap the value in a one-off custom hook + render-prop. We have not seen the need yet.

### `@junjo/react` test infra: vitest + jsdom + @testing-library/react

**Decision:** the React package tests run under Vitest with `environment: "jsdom"` and use `@testing-library/react` for component / hook rendering. The vitest config (`packages/react/vitest.config.ts`) sets `esbuild.jsx: "automatic"` so `.tsx` test files transpile under the React 17+ JSX runtime that the source already uses.

**Rationale:**
- Vitest is already the test runner across `@junjo/sdk` and `@junjo/server`; staying on it preserves a single test command (`npm test`) and a single config style. No second runner to maintain.
- jsdom is the standard browser-DOM emulator for React component tests; the alternative (`happy-dom`) is faster but has known incompatibilities with React 18 / 19 features. The throughput difference is irrelevant at our test count.
- `@testing-library/react` (v16) is the de facto standard for React testing and the version line that supports both React 18 and React 19; it ships `renderHook` so we can test hooks in isolation without writing a custom harness.
- Added as devDeps on `packages/react` (not the workspace root) so the SDK and server packages do not pull jsdom into their `npm install` graphs.

**Trade:** the verify gate now installs jsdom + @testing-library/react on every fresh clone. Acceptable; the install completes in one digit seconds and the alternative (no React tests) defers a quality gate to morning review.


### Phase 7.2 `useGroup` filters the initial roster to active members

**Decision:** `useGroup(groupId)` returns only members whose `status === "active"`. Members with status `left`, `kicked`, or `invited` are filtered out of the initial fetch and never enter `members`. `member.left` events remove from the list; `member.joined` events add to it (and the server-emitted `event.member` always carries `status: "active"`).

**Rationale:**
- The hook's name is `useGroup`. The dominant consumer pattern is a roster panel that lists "people in the group right now," not a history view; serving `left`/`kicked` members would force every consumer to add a status filter at render time and would surprise readers who expect `members` to mean "current members."
- The SDK's `members.list(groupId)` does not filter by status (per the iteration 015 decision: lists return rows in every status, no implicit `active` filter). Without client-side filtering in this hook, a member who left would still appear in the React tree until the next manual refetch.
- The two SSE events the hook subscribes to (`member.joined` / `member.left`) describe transitions, not status snapshots. Treating them as roster mutations rather than status edits keeps the application semantics simple: joined => append, left => remove. No UI logic needs to inspect `member.status`.
- A future consumer that needs the full status taxonomy (e.g., a "left this month" panel) is better served by a separate hook (`useMembers` is on the Phase 7.4 roadmap with explicit pagination, where a `status` filter belongs).

**Trade:** an "invited" member who has not yet accepted will not appear in the roster. That matches the user-facing meaning of "invited" (not yet a member). Devs who need a "pending invitations" view should reach for the (Phase 7.4) `useInvitations` hook instead.

### `useGroup` returns `Error | null` rather than `JunjoError | null`

**Decision:** the `error` field on `UseGroupResult` is typed as `Error | null`, not `JunjoError | null`. Both fetch errors (which are `JunjoError`s thrown by the SDK) and streaming errors (which arrive via the subscription's `onError` callback as plain `Error`s) flow into the same field. Consumers narrow with `instanceof JunjoError` if they need the typed `code`, `status`, and `message`.

**Rationale:**
- `Subscription.onError` in `@junjo/sdk` is typed as `(err: Error) => void` (network drops, malformed-frame parse failures, JSON parse failures). Forcing the field to `JunjoError` would either drop information from those non-JunjoError errors or force an awkward wrap.
- A single `error` field with a stable shape lets consumers render an error banner without branching on which subsystem failed. Consumers who care about the SDK's structured error envelope still get it via `instanceof`.
- This matches React Query / SWR's convention (`error` typed at the upcast level, with provider-specific narrowing left to the consumer).

**Trade:** TypeScript users who want `error.code` must narrow first. The instanceof check is a single line; acceptable.

### `useGroup` keeps the snapshot intact when a streaming error fires

**Decision:** when the subscription's `onError` fires (network drop, server-side stream close, mid-stream parse failure), the hook sets `error` but leaves `group` and `members` unchanged. The snapshot from the most recent successful fetch stays visible to the consumer. Calling `refetch` clears `error` and reopens the stream.

**Rationale:**
- The snapshot is still useful: it represents the state at the last fetch (or the last applied event before the stream broke). Clearing it would force every consumer to render an empty state on a transient drop, which is a worse UX than "the data you saw a moment ago plus a banner saying live updates have stopped."
- The hook does not auto-reconnect (per the V1 SDK rule: `groups.subscribe` is a one-shot stream). Auto-reconnect with replay would require server-side cursor support that V1 does not have. Surfacing `error` puts the recovery decision in the consumer's hands; calling `refetch` is the documented path.
- A separate "stream-only error" channel was considered (e.g., `streamError` distinct from `error`) but rejected because the recovery action is identical (call `refetch`) and a single field is simpler to consume.

**Trade:** a consumer that wants to distinguish "stream broke" from "fetch broke" must keep its own bit of state derived from the prior `error` value. Acceptable; the typical UI shows the same banner either way.

### `useGroup` uses a generation counter to discard stale fetches

**Decision:** the hook holds a `useRef<number>` generation counter that increments on every fetch entry (initial mount and every `refetch`). When a fetch resolves, the result is dispatched only if its generation matches the current ref value. Otherwise the result is dropped silently.

**Rationale:**
- Three concurrency hazards exist without it: (1) mount fetch races with a `groupId` change that triggers a second fetch; (2) two `refetch` calls fired in quick succession resolve out of order; (3) StrictMode double-mount in development overlaps two fetches.
- The pattern is established (it is the standard "abort-by-id" trick used widely in React data hooks) and adds ~3 lines.
- It works alongside the unmount cancellation flag rather than replacing it: the unmount flag prevents post-unmount dispatches; the generation counter prevents stale dispatches across overlapping fetches within a single mount.

**Trade:** a refetch that resolves after a `groupId` change is silently dropped. The user may briefly see stale data for the new group until the new fetch resolves. Acceptable; the alternative (cancellation via AbortSignal threaded through `groups.get` and `members.list`) would require widening the SDK signatures, which is not a V1 priority.

### Phase 7.3 `useCan` shares a per-provider permission cache

**Decision:** the cache lives in a separate React context (`PermissionCacheContext`) that `JunjoProvider` creates alongside `JunjoContext`. The cache instance is `useMemo`d on the `client` reference, so a fresh `<JunjoProvider client={X}>` mount (or a different `client` prop) creates a new cache. All `useCan` consumers under the same provider share that cache; consumers under different providers do not share.

**Rationale:**
- The roadmap explicitly says "caches per (userId, groupId, permission) tuple within the provider." A module-global Map would leak across multi-tenant scenarios (two `Junjo` instances pointing at different games would share entries); a per-instance Map keyed off `client` keeps the boundary tight.
- A separate context (rather than putting the cache on `Junjo` itself) keeps the SDK provider-shape-agnostic. The SDK already has `Junjo.can` / `Junjo.check` and a server-side per-process cache; the React cache is a *consumer-side* concern that should not bleed into SDK consumers who do not use React.
- `useSyncExternalStore` is the right primitive for "shared external store with subscriptions"; the cache exposes `subscribe(key, listener)` and `get(key)` for it. Using `useReducer` + a force-render trick would also work but is less idiomatic and harder to reason about under StrictMode.

**Trade:** consumers who want to share a cache across two unrelated `Junjo` instances cannot. They would need to render both under the same provider, which the API does not allow (one client per provider). Acceptable: the multi-client pattern is rare and is better solved with two separate `JunjoProvider` subtrees.

### `useCan` does not cache errors; only successful results stick

**Decision:** when `junjo.can(...)` rejects, the cache's inflight slot releases and the entry stays empty. The current consumer's `useCan` returns `undefined` (its effect already fired and will not re-fire on its own), but the next mount of `useCan` with the same key fires a fresh request.

**Rationale:**
- Caching errors permanently means a transient blip (a 502 from the server, a brief network loss) bricks the permission check for the lifetime of the provider. That is a worse UX than "next consumer retries."
- Caching errors with a short TTL would let the same consumer recover, but adds timing complexity and a test surface that does not pull weight in V1.
- The hook signature is `boolean | undefined` per spec, with no `error` field. Surfacing the error to the consumer would require widening the return type, which the roadmap explicitly does not call for.

**Trade:** a single mount that errors stays at `undefined` for as long as the component remains mounted (no automatic retry). Consumers who need stronger retry semantics can remount the component or wait for Phase 7.5 to land an explicit invalidation API.

### `useCan` returns `boolean | undefined` rather than a richer status object

**Decision:** the hook returns the bare three-state value (`true`, `false`, `undefined`) per the roadmap spec. It does NOT return `{ allowed, loading, error, source }` or similar.

**Rationale:**
- The roadmap is explicit: "Returns boolean (or undefined while loading)." Consumers should treat `undefined` as "not allowed yet" - which collapses the loading and error cases into a single render branch.
- For the dominant use case (gating a button or render branch), `if (canX !== true) return null` is the natural pattern. Adding a status object would force every consumer to destructure or to ignore fields they do not use.
- A future consumer that needs the resolution source (`role` vs `override` vs `default`) can call `junjo.check(...)` directly. A separate `useCheck` hook with a richer return type is additive if a real use case emerges.

**Trade:** consumers who want to distinguish "still loading" from "errored" cannot from this hook alone. They can compose with their own state if needed; the common case does not need the distinction.

### `useCan` uses `useSyncExternalStore` rather than `useState` + a force-render trick

**Decision:** the hook reads the cache via `useSyncExternalStore(cache.subscribe, cache.get, () => undefined)`. The third argument (server snapshot) returns `undefined` because the SDK cannot pre-fetch on the server in V1.

**Rationale:**
- `useSyncExternalStore` is React 18's purpose-built primitive for "shared external store with subscription"; the React docs explicitly recommend it for this exact pattern.
- It correctly handles StrictMode double-renders, concurrent rendering, and tearing under `useTransition`. A `useReducer` + manual subscribe / dispatch implementation would need to re-derive these properties.
- The peer-dep range (`react ^18 || ^19`) covers every React version where `useSyncExternalStore` exists.

**Trade:** none significant. `useSyncExternalStore`'s `getSnapshot` must return the same primitive when the value has not changed (otherwise React over-renders). For booleans (and `undefined`), JavaScript primitive equality handles this for free, so the constraint is satisfied trivially.

### Phase 7.4 `useMembers` defaults to `status: "active"` and filters client-side

**Decision:** the hook accepts `{ status?: MemberStatus | "all" }`, defaults to `"active"`, and applies the filter on the client after each `members.list` page returns. The server does NOT narrow by status; the SDK passes only `{ limit?, cursor? }` to `junjo.members.list`.

**Rationale:**
- The dominant consumer pattern is a roster panel showing currently-active members. Defaulting to `"active"` makes the common case zero-config; non-active rosters (audit panels, "ex-members" lists) are rare and pay the explicit option.
- Filtering client-side keeps the SDK surface narrow: no new query parameter on `members.list`, no new wire shape, no migration. If V1.X surfaces a status filter on the route, it would be additive and the React hook can opt in transparently.
- The server is already paginated; the worst-case overhead of client-side filtering is the same as the server returning a full page of mostly-non-matching members. For active-heavy groups (the common case), this is negligible.

**Trade:** a heavily-filtered group (e.g., one `active` member out of 1000 historical) requires several `fetchMore` calls before the consumer sees the desired entry. The docs page documents this explicitly. Acceptable for V1 because the dominant use case is the active filter and active members are usually the majority.

### `useMembers` exposes explicit `fetchMore` rather than auto-loading all pages

**Decision:** the hook returns `{ hasMore, fetchMore, loadingMore }` and only loads the first page on mount. Consumers call `fetchMore()` to load each subsequent page; the cursor is held internally.

**Rationale:**
- Auto-loading every page on mount would hammer the server for groups with thousands of members and waste bandwidth for consumers who only render the first page.
- The fetchMore-on-demand pattern matches every popular React data library (React Query's `fetchNextPage`, SWR Infinite, Apollo's `fetchMore`); developers will reach for this shape instinctively.
- Returning the cursor itself is rejected because it leaks the wire format into consumer code. Owning the cursor inside the hook keeps the consumer surface "click button, get more rows" without exposing pagination details.

**Trade:** consumers who want a "load all" pattern have to loop on `fetchMore` themselves, or accept the default first-page behavior. Acceptable: the pattern is two lines and the alternative would prematurely commit to behavior most consumers do not want.

### `useMembers` splits its fetch and subscribe effects so a status change does not re-open the SSE stream

**Decision:** the hook runs two `useEffect`s. Effect A (`[refetch]`, where `refetch` depends on `[junjo, groupId, status, limit]`) fires the initial fetch and re-fetches when filter / limit change. Effect B (`[junjo, groupId]`) opens and closes the SSE subscription. The subscribe handler reads the latest matcher via a `matchesRef`.

**Rationale:**
- Subscriptions are server resources. Tearing one down and reopening it because the consumer flipped a client-side filter would be wasteful and would briefly miss events during the gap.
- The `matchesRef` pattern (a ref updated each render that the long-lived handler closure reads) is the standard React idiom for "subscriber sees the latest props." It is correct under StrictMode (refs are not double-mounted) and avoids the stale-closure pitfall of reading `status` directly inside the handler.
- The alternative (a single `useEffect` with `[junjo, groupId, status, limit]` deps) would correctly tear down + reopen on every filter change but would also disconnect from the live stream during the gap. Worse for V1.

**Trade:** the matcher used by the subscribe handler can lag the rendered state by one tick (the ref updates during render; the handler runs whenever an event arrives). In practice the gap is one microtask and not user-visible. Acceptable.

### `useMembers` removes members on `member.left` regardless of filter

**Decision:** when a `member.left` event arrives for a user already in the visible roster, the hook removes them. It does NOT synthesize a left/kicked Member shape, even when the consumer's filter is `"all"` or `"left"`.

**Rationale:**
- The event payload (`{ userId, reason: "left" | "kicked", kickedBy? }`) does not carry the post-state member shape. Synthesizing one would require fabricating fields the event does not provide (a new `joinedAt`, a `status` derived from `reason`, etc.) and would diverge from what `members.list` would return on a refetch.
- For the dominant filter (`"active"`), the behavior is correct: the user is no longer active and should not be in the list.
- For other filters, the docs page tells the consumer to call `refetch` if they need precise lifecycle tracking. This is honest about what V1 can deliver and avoids painting the hook into a corner where the synthesized shape disagrees with the server.

**Trade:** consumers using `status: "all"` or `status: "left"` see members disappear briefly (until they refetch) when those members leave / get kicked. Acceptable; the dominant filter is "active" and a future event-payload widening (carrying the post-state Member) is additive.

### `useMembers` opens its own SSE subscription rather than sharing one with `useGroup`

**Decision:** if a screen renders both `useGroup` and `useMembers` for the same `groupId`, two parallel SSE subscriptions open against the server. The hook does not coordinate with `useGroup`; each owns its own subscription lifecycle.

**Rationale:**
- A shared subscription cache would require a cross-hook registry inside `JunjoProvider`, ref-counting, and careful cleanup ordering. That is exactly the kind of infrastructure Phase 7.5 ("optimistic updates layer") is the right place for; baking it in now would couple `useMembers`'s implementation to invariants we have not designed yet.
- Two subscriptions per screen is wasteful but correct in V1; the server tolerates duplicate subscribers per group.
- The two hooks have different lifecycle needs (`useMembers` recovers via `refetch` + `fetchMore`; `useGroup` recovers via `refetch`). Sharing a subscription would force one of them to inherit the other's recovery model.

**Trade:** developers rendering both hooks on one screen open two streams. The docs page calls this out explicitly and recommends choosing one hook per screen unless both result shapes are needed. Phase 7.5 will fold them into a shared cache transparently.


### Phase 7.4 `useInvitations` defaults to `status: "pending"` and combines server-side narrowing with a client-side matcher

**Decision:** the hook accepts `{ status?: "pending" | "used" | "expired" | "all" }` and defaults to `"pending"`. It maps the status to the server's `includeExpired` / `includeUsed` flags on `junjo.invitations.list` (so the server narrows the result set), and then applies a client-side matcher that drops rows the inclusive flags return alongside the requested ones.

**Rationale:**
- The server's flags are inclusive ("also include expired" / "also include used"), not exclusive. Asking for "only used" still requires a client-side filter to drop the pending rows the server returned alongside the used ones.
- The dominant consumer pattern is a "Pending Invitations" admin panel; defaulting to `"pending"` makes the common case zero-config.
- Server-side narrowing minimizes wire traffic for the common case (`pending` is the smallest result set; expired and used rows can grow unboundedly over time). The client-side matcher exists only to clean up the inclusive-flag overflow.
- Mirrors the `useMembers` precedent of "filter on the client even when the server has flags" while taking advantage of the server flags that already exist for invitations specifically.

**Trade:** the hook duplicates filter logic that already exists conceptually on the server. Acceptable: the server's flags are inclusive, so a strict server-side-only filter would require new query parameters (e.g. `?status=used`). That's a roadmap-V1.X widening; the React hook can opt in transparently.

### `useInvitations` only handles `member.invited` and `member.joined` for live updates

**Decision:** the hook reacts to two SSE event types: `member.invited` (append a new invitation, filter-aware) and `member.joined` (transition direct invitations targeting the joining user from pending to used; either drop them or update them in place depending on the active filter). Every other event type is a no-op.

**Rationale:**
- `member.invited` and `member.joined` are the only events whose payload is rich enough to apply locally. Revoke and decline emit no events at all (per iteration 026's split: "mutations whose audit action has no `JunjoEvent`-union counterpart publish nothing"). Expiration is not an event - it's a derived state from `expiresAt < now`.
- Adding a polling timer to re-evaluate expirations would add real complexity (a `setInterval` plus a dependency on wall-clock skew). For V1, leaving expired rows visible until the next `refetch` is honest about what the data layer can deliver.
- The docs page explicitly tells consumers to call `refetch` after `revoke`, `decline`, or when expiration timing matters. This matches the established pattern: live updates handle the common cases, and consumers reach for `refetch` to bridge the gaps.

**Trade:** the visible list can lag the server until the next user action triggers a refetch. Acceptable in V1; Phase 7.5 (optimistic updates layer) is the right place to add automatic invalidation on revoke / decline mutations.

### `useInvitations` does not auto-correlate open-code invitations to `member.joined`

**Decision:** when a `member.joined` event arrives, only direct invitations (where `targetUserId === event.userId`) are transitioned to used. Open-code invitations (`targetUserId: null`) are left untouched.

**Rationale:**
- The `member.joined` event payload (`{ userId, member }`) does not carry the invitation id that was used. The server records that id in the audit log (see iteration 013's `payload: { memberId, invitationId, code }`) but does not propagate it onto the live event.
- For direct invitations the correlation is unambiguous: there is at most one pending invitation per `(groupId, targetUserId)` pair the server enforces. For open-code invitations a single accept could correspond to any of several active codes, and the hook has no way to choose.
- Synthesizing a "use up the oldest open-code invitation" heuristic would be wrong on basically any concurrent scenario and would silently disagree with the server's actual record.

**Trade:** consumers showing open-code invitations need to call `refetch` after `acceptInvitation` to see the post-state. Acceptable: open codes are typically published via shareable URLs (Discord, Slack, etc.) where the consumer's UI is not the redemption surface anyway.

### `useInvitations` evaluates `expiresAt` against `new Date()` at filter time, with no auto-tick

**Decision:** the matcher reads `new Date()` each time it runs (during initial fetch, fetchMore, and event dispatch). The hook does NOT run a `setInterval` to re-evaluate the matcher when wall-clock time crosses an `expiresAt` boundary.

**Rationale:**
- A timer adds complexity (cleanup, dependence on wall-clock skew, test-determinism issues with fake timers) for a niche use case. The dominant case is a panel that re-renders on user action - call `refetch` when the user clicks "refresh."
- Reading `new Date()` at filter time is sufficient for the events that fire (each event triggers a render in which the matcher re-runs); only the case "no events fire AND wall-clock crosses expiresAt" goes unhandled.
- The docs explicitly call this out as a V1 limitation with the recommendation to `refetch` periodically if the consumer cares.

**Trade:** an invitation that expires while the panel is mounted with no events firing stays visible until the next user action. Acceptable; consumers needing real-time expiration can poll with `refetch` on a timer themselves.

### `useInvitations` deduplicates by invitation `id` and not `code`

**Decision:** `fetch_more_success` and `member.invited` (re-emit) both deduplicate using the invitation's database id (branded `InvitationId`), not the human-shareable `code`.

**Rationale:**
- The id is the stable primary key; the code is human-facing but never duplicated either, so the choice is mostly cosmetic. The id is consistent with the `useMembers` precedent (deduplicating by `userId`, the natural primary key).
- Preserves the door for future invitation rotation (e.g. a code refresh) where the underlying invitation row would keep its id.

**Trade:** none significant. Both fields are unique within a group; `id` is the safer long-term choice.


### Phase 7.4 `useAuditLog` does not subscribe to SSE in V1; live updates are refetch-driven

**Decision:** unlike `useGroup` / `useMembers` / `useInvitations`, `useAuditLog` does NOT open an SSE subscription. The hook fetches on mount, paginates via `fetchMore`, and refreshes via `refetch`. Live updates are refetch-driven only (consumers poll, drive `refetch` from their own mutations, or wait for a future `audit.created` event).

**Rationale:**
- Audit entries do not have a corresponding `JunjoEvent` payload that carries the audit-entry id. The server writes the id and the canonical payload shape inside the same transaction that emits the event, but it does not propagate the id to the event. So the hook cannot synthesize new entries from `member.joined` / `role.changed` / etc. without diverging from the server's recorded entries (different ids, possibly different payload shapes).
- The alternative was "subscribe to events and on each event arrival fire a small first-page refetch to pick up new entries." Rejected: every event triggers a network call, which is a lot of load for a panel that may be rendered on every admin view; and merging a fresh first page with a partial paginated list is racy with `fetchMore`.
- A future server-side `audit.created` event in the `JunjoEvent` union would carry the full server-shape entry and let the hook subscribe like the others. That is a roadmap-V1.X widening; the V1 hook ships with the simpler fetch-only contract and explicitly documents the limitation.

**Trade:** the audit log can lag the server until the next `refetch`. Acceptable: audit log is a low-frequency view (admin panels, debug tools); consumers who need fresh data can poll, refresh manually, or wire `refetch` into their own mutations. Polling and on-mutation-refetch stay correct after a future `audit.created` event lands.

### `useAuditLog` paginates by ISO timestamp cursor stored as a string and converted to Date for the SDK

**Decision:** the hook stores `nextCursor` as a string (the server's ISO 8601 `createdAt` of the last page item) and converts to `Date` via `new Date(cursor)` when calling `audit.list({ before })`. Pagination is timestamp-based, not opaque-cursor-based.

**Rationale:**
- The server's audit-list endpoint (per iteration 028) paginates by `?before=<ISO>` rather than an opaque cursor; `Page<AuditEntry>.nextCursor` is the ISO `createdAt` of the last item.
- Storing the cursor as a string keeps the React state shape JSON-serializable (debuggable in React DevTools); converting to `Date` happens at the SDK boundary where the typed `before: Date` lives.
- Mirrors the SDK's own pagination example in `apps/docs/pages/sdk/audit.mdx`.

**Trade:** if two entries share `createdAt` to millisecond precision the page boundary may skip them. Documented as eventually-consistent; matches the underlying SDK / server contract.

### `useAuditLog` actions filter uses a sort-stable cache key

**Decision:** the hook computes its dependency key for `actions` as `actions.slice().sort().join("|")`. Two `actions` arrays with the same membership but different reference (or different order) produce the same key and do NOT trigger a refetch; only a real membership change does.

**Rationale:**
- Order is irrelevant to the server (the `?actions=...&actions=...` query is interpreted as a set / OR-filter), so reordering should not be a refetch trigger.
- Reference inequality on each render is the common case when consumers pass `["member.invited"]` inline; treating that as a refetch trigger would hammer the server every render.
- The string key feeds a `useMemo` whose only dep is the key itself; the actual `actions` array passes through a ref to the SDK call, so the latest reference still reaches the network.

**Trade:** a consumer who really wanted to force a refetch by passing a fresh array reference would not get one. Acceptable: that is what `refetch` is for.

### `useAuditLog` does no client-side filtering; the server is the only filter

**Decision:** unlike `useMembers` (client filter on `status`) or `useInvitations` (two-layer server + client filter), `useAuditLog` forwards the `actions` filter to the server verbatim and applies no client-side narrowing.

**Rationale:**
- The server's `?actions=` filter is exclusive (returns only matching entries), unlike the inclusive `includeExpired` / `includeUsed` flags on invitations. There is nothing for a client filter to clean up.
- Audit entries are append-only and the visible list is bounded by the cursor; there is no live event stream to apply rules to.
- Keeping the hook as "fetch and display" minimizes complexity; consumers wanting more sophisticated filtering can post-process `entries` themselves.

**Trade:** none significant. The simplicity is the win.

### `useAuditLog` empty `actions: []` is treated as no filter

**Decision:** an empty array (`opts.actions = []`) is omitted from the wire call (the SDK never sees an `actions` key in the options bag). The result is identical to passing no `actions` at all: the server returns entries in every action category.

**Rationale:**
- Mirrors the SDK and server convention: empty array means "no filter" everywhere in the audit stack.
- Avoids a degenerate `?actions=` query string that the server's Zod schema would currently accept but might reject in a future widening.
- Lets consumers conditionally pass an array (e.g. `actions: filter || []`) without surprise behavior on an empty selection.

**Trade:** consumers wanting to differentiate "no filter" from "filter to empty list" cannot. The latter is conceptually nonsensical (the audit log entries exist; an empty filter would always return zero entries) so this is the right choice.


### Phase 7.5 splits across iterations: 7.5a generic mutation primitive, 7.5b/c per-list optimistic helpers

**Decision:** Phase 7.5 ("Optimistic updates") is split mirroring the Phase 5.1 a/b/c precedent. 7.5a (this iteration) ships a generic `useMutation` primitive following React Query's `mutationFn` + `onMutate` (returns context) + `onError` (uses context to roll back) pattern. 7.5b/c will fold those snapshot + rollback wirings into the existing list hooks (`useMembers`, `useInvitations`, `useGroup`) directly.

**Rationale:**
- A full optimistic-updates layer touching all four list hooks plus a mutation flow is too much for one iteration.
- A generic primitive is independently useful (consumers wire optimistic snapshots themselves today) and is the foundation any per-list helper builds on.
- The React Query mutation API is the dominant convention in the React ecosystem; consumers familiar with it pick `useMutation` up immediately. New mental model would not have helped.
- Splitting also gives Gabe a chance to redirect after seeing the primitive land before the per-list helpers are built; the per-list shape (where snapshot lives, how SSE reconciles vs optimistic) has more design surface than the primitive itself.

**Trade:** consumers who want a one-line `useKickMember(...)` helper today still need to wire the snapshot themselves. The doc page shows the full pattern (`useMembers` snapshot via `useState` mirror, `onMutate` returns it, `onError` restores).

### `useMutation` follows React Query's mutation API

**Decision:** `useMutation<TData, TError, TVariables, TContext>({ mutationFn, onMutate?, onSuccess?, onError?, onSettled? })` returning `{ mutate, mutateAsync, status, data, error, isIdle, isPending, isSuccess, isError, reset }`. `onMutate(vars)` returns a `TContext` that threads through to `onSuccess`, `onError`, and `onSettled`.

**Rationale:**
- React Query's mutation API has been the dominant React-mutation pattern for ~5 years; consumers know it; documentation is widely available; the optimistic-update pattern (snapshot in onMutate, rollback in onError) is well-understood.
- A four-state status (`idle` / `pending` / `success` / `error`) maps cleanly onto common UI patterns (button disabled while pending, error banner on error, etc.) without consumers having to derive booleans themselves.
- Generic `TContext` is the only sane way to type an optimistic-snapshot pattern: consumers know what they snapshotted; the hook just threads it through.

**Trade:** introduces a learning curve for anyone who does not know React Query. Acceptable; the API is small and the docs page covers the full lifecycle.

### `useMutation` state transitions reflect only the mutation's outcome, not callbacks'

**Decision:** if `mutationFn` resolves successfully, the state is `success` regardless of what `onSuccess` / `onSettled` do. An error thrown inside `onSuccess` propagates from `mutateAsync` but does NOT flip the state to `error`. Errors thrown inside `onError` are caught (the original `mutationFn` error still propagates from `mutateAsync`).

**Rationale:**
- The mutation either happened on the server or it did not. That outcome is what `status` should reflect; a buggy `onSuccess` callback should not retroactively make a successful mutation appear failed.
- React Query has the same contract.
- Errors thrown inside `onError` would be a "rollback failed during rollback" scenario; suppressing them keeps the chain clean and lets the original error reach the consumer.

**Trade:** if a consumer relies on `useMutation` to report callback failures, they need to handle that in the callback itself. Acceptable: the consumer wrote the callback, they know what to do with its errors.

### `useMutation` uses `safeCall` helper to call lifecycle callbacks without breaking the chain

**Decision:** internal `safeCall(callback)` helper wraps each callback invocation in try/catch and returns the captured error (or `undefined`). The four lifecycle callbacks (`onSuccess`, `onError`, `onSettled`, `onSettled`-after-error) all run through `safeCall`, then the captured errors propagate from `mutateAsync` in priority order.

**Rationale:**
- Without `safeCall`, an error in `onSuccess` would skip `onSettled` (the contract says `onSettled` always runs).
- Avoids deeply nested try/catch/finally that would obscure the lifecycle.
- The `safeCall` return value (the error or undefined) lets `mutateAsync` decide which error to throw: `successErr` first (the user's explicit success-handler error), then `settledErr` (the cleanup error).

**Trade:** the implementation is slightly less direct than try/catch/finally. Worth it for the cleanliness of the four-phase lifecycle.

### `useMutation` snapshots options at call time via optionsRef; callbacks always see the *latest* render

**Decision:** the hook stores its options in a `useRef` that is updated on every render. When `mutateAsync` is called, it reads `optionsRef.current` once and uses that snapshot for the entire lifecycle. A re-render between `mutate` and the eventual `onSuccess` does NOT redirect the in-flight mutation to the new callbacks; the captured snapshot wins.

**Rationale:**
- Predictability: the same `mutate(vars)` call always runs the same callback chain it started with. No surprise where a re-render mid-flight redirects state to a fresh component.
- React Query has the same behavior (callbacks captured at call time).
- The `useCallback` for `mutate` and `mutateAsync` does NOT depend on the options, so they have stable identities across renders. This avoids breaking memoization in consumer components.

**Trade:** if a consumer wants the latest callback to run on the most recent mutation, they must call `mutate` after the re-render. Almost never matters; mutations are fire-once-per-click in practice.

### Phase 7.5b: `useMembers` exposes `applyOptimistic(updater): rollback`, not named per-mutation helpers

**Decision:** Phase 7.5b adds one method to `UseMembersResult`: `applyOptimistic(updater: (prev: Member[]) => Member[]): () => void`. It dispatches an `optimistic_apply` reducer action that runs the updater and returns a closure that dispatches `optimistic_rollback` with the snapshot captured at call time. No `kickMember` / `assignRole` / `removeRole` / `inviteMember` named helpers ship in V1.

**Rationale:**
- The roadmap calls out three optimistic mutations (kick, invite, role assignment) that share one pattern: snapshot, mutate locally, restore on error. A single primitive covers all three plus arbitrary custom mutations against the local roster.
- Named helpers would force a return-shape decision for each (do they expose `useMutation`-style status? do they swallow errors? do they take the SDK call inline?) which is premature when the consumer's `useMutation` already owns that contract cleanly.
- Stays composable with the existing Phase 7.5a primitive: consumers wire `applyOptimistic` from `onMutate` (returning the rollback closure as part of the typed `TContext`) and call it from `onError`. The docs page shows kick + role assignment patterns inline.
- Keeps the result type small. Adding three named helpers would balloon `UseMembersResult` and entrench API decisions before we know whether consumers actually want them.

**Trade:** consumers writing the kick mutation type out the snapshot wiring themselves (one onMutate + one onError line). Acceptable - the example is in the docs; the wiring is fire-once-per-feature, not fire-once-per-call.

### `applyOptimistic` snapshot-and-restore semantics: rollback restores to the exact pre-update array; intermediate SSE events are lost on rollback

**Decision:** the rollback closure stores `state.members` as it was when `applyOptimistic` was called and restores it verbatim on dispatch. SSE events that arrived between `applyOptimistic` and the rollback are dropped on rollback. The reducer collapses identical-reference rollback snapshots back to the same state to skip the React re-render.

**Rationale:**
- This is React Query's mutation-rollback contract. Consumers familiar with React Query expect it.
- Computing the inverse of an arbitrary updater is impossible without forcing the consumer to provide an inverse function, which would double the API surface and is harder to reason about.
- The mutation window is short (typically ms to a few seconds). The probability of an unrelated SSE event landing inside that window is small in practice; even when it happens, the next `refetch` reconciles.
- Documented in the user-facing page with the recommendation to call `refetch()` from `onError` after `rollback()` for UI that is sensitive to it.

**Trade:** an SSE event that fires during a doomed mutation is lost on rollback. Acceptable for V1. A future iteration could ship an "apply on top of latest" rollback semantics if multi-tenant high-throughput consumers report it as a real problem.

### `applyOptimistic` is provided as a stable callback reference across renders

**Decision:** `applyOptimistic` is wrapped in `useCallback` with no dependencies (the snapshot is captured at *invocation* via a ref, not via the callback's closure). This means the same function identity persists across renders, so consumer code can pass it through `useMutation`'s `onMutate` without forcing remounts of the mutation hook on every render.

**Rationale:**
- `useMutation`'s callbacks are read through `optionsRef`, which is updated on every render; but a stable `applyOptimistic` reference keeps the mutation's `useCallback` identities stable too, so memoized child components do not re-render unnecessarily.
- The members snapshot lives in a ref (`membersRef.current = state.members`) that is read at the moment `applyOptimistic` is called, not when the callback was created. This is the standard "read latest state from a ref inside a stable callback" idiom.

**Trade:** the snapshot read is implicit (consumers cannot inspect what was captured). Acceptable - the rollback closure is the only thing that uses the snapshot, and it captures it as a parameter.

### Concurrent overlapping `applyOptimistic` calls get LIFO rollback semantics

**Decision:** if two mutations call `applyOptimistic` concurrently (mutation A first, then mutation B), each captures its own snapshot. If A rolls back later, it restores to the state-at-A's-call, which discards B's still-applied optimistic update. Mutations rolling back in different order to their `applyOptimistic` calls can therefore overwrite each other's state.

**Rationale:**
- Same as the snapshot-restore contract above: this is React Query's mutation-rollback behavior.
- Tracking a stack of pending optimistic updates and re-applying the survivors on rollback is significantly more complex and changes the mental model from "pure state restore" to "ordered overlay merge"; not worth shipping in V1.
- In practice, simultaneous mutations against the same roster are rare; the common case is single-mutation-at-a-time button clicks. The doc page documents this trade.

**Trade:** apps that genuinely run multiple concurrent optimistic mutations (e.g. bulk-kick UI) will see weirdness on partial failure. Mitigation: call `refetch()` from `onSettled` to reconcile. Documented.

### Phase 7.5c: `useGroup.applyOptimistic` takes a `{ group, members }` snapshot updater (one method, atomic snapshot)

**Decision:** `useGroup` exposes a single `applyOptimistic(updater: (prev: { group, members }) => { group, members }): rollback` method, not separate `applyOptimisticGroup` and `applyOptimisticMembers` helpers. The hook captures one snapshot containing both fields and dispatches an `optimistic_apply` reducer action that runs the updater against `{ group: state.group, members: state.members }`; the rollback closure restores both fields together.

**Rationale:**
- `group` and `members` are two slices of the same logical entity. Mutations frequently need to update them in lockstep (e.g., a kick that drops the member row AND bumps `group.memberCount` so cached UI stays consistent). Two separate methods would force consumers to call them in sequence, which is racier and exposes the inconsistent intermediate state.
- A single atomic snapshot also gives a single rollback closure, which is what `useMutation`'s `onMutate -> context -> onError(rollback)` flow expects. Two methods would mean tracking two rollback closures in the mutation's context.
- Consumers updating only one field spread the other through unchanged in the updater: `{ group: prev.group, members: ... }` for a kick, `{ group: ..., members: prev.members }` for a rename. The shape is verbose by one line; the trade buys atomicity.

**Trade:** consumers updating only one field write a one-line passthrough for the other. Acceptable - the alternative (two methods) would have leaked the bookkeeping onto every consumer instead.

### Phase 7.5c: `useInvitations.applyOptimistic` is a direct port of the `useMembers` shape

**Decision:** `useInvitations` exposes `applyOptimistic(updater: (prev: Invitation[]) => Invitation[]): rollback` with the same single-list-updater signature, the same `invitationsRef` snapshot capture, the same identity-equal short-circuit, and the same LIFO concurrent-rollback semantics as `useMembers`.

**Rationale:**
- Both hooks track a single list as their primary mutable surface; the API can be identical.
- A consistent helper shape across hooks reduces the cognitive load when consumers move between mutating rosters and mutating invitation panels.
- The decisions for `useMembers.applyOptimistic` (no per-mutation named helpers, snapshot-and-restore semantics, stable callback identity, LIFO rollback) all apply here verbatim and need no per-hook reasoning.

**Trade:** none beyond the inherited trades documented for `useMembers.applyOptimistic`.

### Phase 7.5c: `useGroup` exposes a `GroupSnapshot` type so consumers can name the updater shape

**Decision:** the `useGroup` updater is typed as `(prev: GroupSnapshot) => GroupSnapshot`, where `GroupSnapshot = { group: Group | null; members: Member[] }`. Both type aliases (`GroupSnapshot`, `GroupUpdater`) are re-exported from `@junjo/react`.

**Rationale:**
- Inline `(prev: { group: Group | null; members: Member[] }) => ...` is technically equivalent but verbose at the call site, especially when a consumer wants to factor the updater out into a helper for testing or sharing across components.
- The exported type alias gives consumers a shorthand for typing helpers that build optimistic updates without re-typing the shape.

**Trade:** more surface area on the public API. Minor, and additive: the inline shape still works for consumers who do not import the alias.

### Phase 9.1: webhook endpoint `format` is a per-endpoint enum (`"junjo" | "discord"`), default `"junjo"`

**Decision:** `WebhookEndpoint` grows a `format` column (Postgres `TEXT NOT NULL DEFAULT 'junjo'`) that decides the wire shape applied at delivery time. `"junjo"` (the default) keeps the existing behavior: raw `JunjoEvent` JSON with the canonical `x-junjo-*` signed headers. `"discord"` produces a Discord embed payload via the new `discordFormatter.ts` module and skips the HMAC headers entirely. Validation lives in `WEBHOOK_FORMATS = ["junjo", "discord"] as const` in `routes/webhooks.schema.ts`; unknown values return 400 on create / update.

**Rationale:**
- Devs running a Discord-only workflow want to point Junjo at a Discord webhook URL and have events show up as readable embeds, not raw JunjoEvent JSON. The dominant alternative (relay through their own server) is significant infra for a feature that is actually a small data transformation.
- Per-endpoint (not per-event-type, not global) lets a single game pipe `member.joined` to Discord AND keep raw events flowing to their own backend by configuring two endpoints. Aligns with how Stripe / GitHub webhooks model destinations.
- Defaulting to `"junjo"` preserves backwards compatibility: every existing endpoint row gets `'junjo'` from the column default, so the worker behavior for already-deployed endpoints is unchanged.
- Slack lands as `format: "slack"` in Phase 9.2 with the same shape (no schema change, just a new enum value and a sibling `slackFormatter.ts`).

**Trade:** the format set is closed (devs can't define their own). For V1 this is the right boundary; arbitrary outbound transforms belong in a relay the dev controls. If a fourth target ever needs to land, the cost is one new enum entry plus a formatter module.

### Phase 9.1: Discord deliveries skip HMAC and `x-junjo-*` headers

**Decision:** when `endpoint.format === "discord"`, the worker writes `content-type: application/json` and nothing else. No `x-junjo-event`, `x-junjo-event-id`, `x-junjo-delivery-id`, `x-junjo-timestamp`, or `x-junjo-signature` headers; no HMAC computation. The endpoint's stored `secret` is ignored on the delivery path (but kept in the row, in case the dev later switches the format back to `"junjo"`).

**Rationale:**
- Discord webhook URLs are themselves the auth token (`https://discord.com/api/webhooks/<id>/<token>`). A leaked URL is the same threat surface as a leaked HMAC secret. Adding HMAC headers on top would be redundant and would confuse developers reading their own access logs.
- Discord's webhook API documents that unknown headers are ignored. Sending the `x-junjo-*` set would still work, but would (1) leak Junjo-internal metadata into Discord's request logs and (2) suggest to a misconfigured endpoint reader that the payload is verifiable when it isn't.
- Receivers of `format: "discord"` deliveries are by definition Discord (or a Discord-shaped consumer); they don't run `junjo.webhooks.verify`, so the signature would never be checked anyway.

**Trade:** if a dev configures `format: "discord"` but accidentally points the URL at their own server (instead of Discord), they receive an unauthenticated payload. We accept this: the URL itself is the only authentication for this format, and the SDK / docs are explicit that the URL is the secret.

### Phase 9.1: stored payload stays raw (`JunjoEvent` JSON), formatting happens at delivery time

**Decision:** `WebhookDelivery.payload` continues to store `serializeEventForStorage(event)` (the round-tripped `JunjoEvent`) regardless of the endpoint's `format`. The Discord embed is computed fresh by `formatJunjoEventForDiscord(payload)` inside `deliverOne`, every attempt.

**Rationale:**
- A delivery row created when `format = "junjo"` and then re-targeted by a `PATCH /v1/webhooks/:id` to `format = "discord"` should arrive in the new format. Storing the formatted payload at enqueue time would freeze the wire shape at the wrong moment.
- The formatter is pure and cheap; running it per attempt costs ~microseconds and avoids any "stored format vs current format" reconciliation logic.
- Re-delivery / debugging tooling can render the same row in either format without rewriting the database.

**Trade:** every retry recomputes the embed. Acceptable - the formatter is allocation-light and runs at most 6 times per delivery.

### Phase 9.1: Discord formatter is forward-compatible against unknown event types

**Decision:** `formatJunjoEventForDiscord` switches on `payload.type`. Anything not in the switch falls through to a generic grey embed (`Junjo event: <type>`) with the type and event id as fields.

**Rationale:**
- `JunjoEventType` is open in the sense that future Junjo releases can add new event variants. A rolling deploy where the worker is on a newer release than the formatter (or vice versa) could otherwise produce 500s mid-delivery.
- Treating unknown types as "still deliverable, just less pretty" is the right failure mode for an outbound integration: the dev still sees the activity in Discord, even without bespoke styling.

**Trade:** new event types ship to Discord without per-type embed customization until a follow-up commit lands. Documented in the Discord docs page so devs know to expect it.

### Phase 9.1: Discord embed field values truncated at 1024 chars

**Decision:** the formatter applies a hard cap on every field value (`FIELD_VALUE_MAX_LENGTH = 1024`) using a single-character ellipsis suffix when truncation kicks in.

**Rationale:**
- Discord rejects payloads with field values exceeding 1024 chars with a 400 response. The retry policy would then mark the delivery as `failed` immediately (4xx is permanent), which is the wrong behavior for a Junjo bug spilling oversized data.
- The typical event has tiny field values (user ids, group ids, role names). The cap only kicks in for `role.changed` events with very large `added` / `removed` arrays - rare in practice but possible.

**Trade:** very-long role lists get a `…` suffix instead of full enumeration. Acceptable - the Discord page is for at-a-glance activity, not a complete audit log (which lives at `audit.list`).

### Phase 9.2: Slack added to the closed `WebhookEndpointFormat` enum

**Decision:** `"slack"` is a third value in the `WebhookEndpointFormat` union, sitting alongside `"junjo"` and `"discord"`. The schema-side enum (`WEBHOOK_FORMATS` in `routes/webhooks.schema.ts`) and the Postgres `format` column accept it, the worker dispatches to `formatJunjoEventForSlack` when it sees the value, and the existing `format` field on `CreateWebhookEndpointInput` / `UpdateWebhookEndpointInput` carries it without API surface change. No schema migration: the column already exists with a string default and no enum constraint.

**Rationale:**
- Phase 9.1 explicitly anticipated this: "Slack lands as `format: "slack"` in Phase 9.2 with the same shape (no schema change, just a new enum value and a sibling `slackFormatter.ts`)."
- Both Discord and Slack incoming-webhook URLs follow the same auth model (URL is the secret), share the same retry semantics, and target the same use case (channel-side activity feed). Treating them as siblings rather than as a deeper format taxonomy keeps the enum closed and the worker code linear.
- A test that previously used `format: "slack"` as the unknown-format placeholder broke and was migrated to `format: "teams"` (still rejected by the enum). Documented in the iteration log.

**Trade:** the closed-enum stance still holds. A future `"teams"` (Microsoft Teams) or `"webhook-shape-X"` will be one decision entry plus one formatter module. Devs needing arbitrary outbound shapes still run their own relay.

### Phase 9.2: Slack uses Block Kit (`blocks` array) plus a top-level `text` fallback

**Decision:** the formatter emits `{ text, blocks: [...] }` per Slack incoming-webhook payload spec. `text` is a one-line summary used as the mobile push notification preview and old-client fallback; `blocks` is a Block Kit array with a `header` block, a `section` block carrying the summary, a `section` block of two-column field pairs (each is a single `mrkdwn` text element with a bolded label, a literal newline, then the value), and a `context` block carrying the Junjo event id and `occurredAt`.

**Rationale:**
- Block Kit is Slack's recommended message shape and what Slack's own first-party integrations use. Pure-`text` posts are visually flat in modern Slack clients; Block Kit gets the polished, scannable layout.
- The `text` fallback is required: without it, Slack logs a warning and mobile push notifications show "an empty message". One extra string is cheap.
- The four-block structure (header / summary / fields / context) matches what Stripe, Linear, and GitHub send to Slack for similar event-feed use cases. Familiar to devs, easy for them to filter on.

**Trade:** the `blocks` payload is more bytes than a pure-`text` post. Negligible (Slack's 40 KB cap is many orders of magnitude away). Block Kit does not yet support all formatting niceties of Discord embeds (no per-block color stripe, no embed thumbnails) - acceptable for V1.

### Phase 9.2: Slack field values truncated at 2000 chars; section text at 3000 chars

**Decision:** the formatter caps each `mrkdwn` field at 2000 chars and each section text block at 3000 chars, with a single-character ellipsis suffix on truncation. These are Slack's documented per-component limits.

**Rationale:**
- Slack rejects payloads exceeding the per-component caps with a 400. The retry policy treats 400 as terminal failure (`failed` immediately, no retry), which is the wrong behavior for a Junjo bug spilling oversized data.
- Slack's caps differ from Discord's (2000 / 3000 vs Discord's 1024 / 4096). The formatter uses Slack's numbers directly rather than a shared cross-formatter constant.
- The cap only triggers for `role.changed` with very large `added` / `removed` lists; the typical event flows through verbatim.

**Trade:** very-long role lists get a `…` suffix. Same deal as Discord - the Slack page is for at-a-glance activity, not a complete audit log.

### Phase 9.2: Slack delivery skips HMAC headers (matches Discord stance)

**Decision:** when `endpoint.format === "slack"`, the worker writes `content-type: application/json` and nothing else. No `x-junjo-*` headers, no HMAC computation. The `secret` column is unused on the Slack delivery path but kept stored.

**Rationale:**
- Slack incoming-webhook URLs (`https://hooks.slack.com/services/T<workspace>/B<bot>/<token>`) are themselves the auth token. Same threat model as Discord: a leaked URL is a leaked secret.
- Slack ignores unknown headers; sending `x-junjo-*` would only leak Junjo-internal metadata into Slack's request logs.
- Receivers of `format: "slack"` are by definition Slack (or a Slack-shaped consumer); they don't run `junjo.webhooks.verify`.
- Mirrors the Phase 9.1 Discord stance, so the worker has a uniform "skip headers for non-junjo formats" branch instead of a per-provider exception list.

**Trade:** identical to Discord's. Documented on the user-facing Slack page.

### Phase 9.2: Slack formatter is forward-compatible against unknown event types

**Decision:** `formatJunjoEventForSlack` switches on `payload.type`. Unknown types fall through to a generic message with title `Junjo event: <type>` and fields carrying the type and event id.

**Rationale:**
- Same rationale as the Discord formatter's forward-compat: a rolling deploy that adds a new `JunjoEventType` should not crash the Slack delivery path.
- Slack does not have a per-event "color category" like Discord embeds, so the unknown-type branch is visually identical to a known-type message except for the title and fields. No grey-vs-red color signal needed.

**Trade:** new event types ship to Slack without per-type customization until the formatter ships an updated mapping. Same as Discord; documented in the user-facing Slack page.

### Phase 13.1: docs onboarding is three pages: introduction, getting started, tutorial

**Decision:** the new-user onboarding flow lives across three pages at the docs site root: `index.mdx` (the introduction - what Junjo is, what it gives you, what it is not, plus links into the rest of the site), `getting-started.mdx` (the install path: pick a server, install the SDK, construct a client, make your first call), and `tutorial.mdx` (the five-minute walkthrough that creates a group, invites a user, accepts the invitation, assigns a role, grants a permission, checks the permission, and opens an SSE subscription). The previous `index.mdx` placeholder ("This site is a placeholder.") is replaced.

**Rationale:**
- One page would be too long to scan and would mix two distinct intents: "what is this and should I bother" vs "show me how to use it." Splitting them lets a reader skim the introduction in 20 seconds before committing to the install steps.
- A separate tutorial page lets us link readers directly into a worked example from any other doc page (common pattern from the SDK reference: "see the tutorial for how this fits together"). Having it embedded in the getting-started page would force every link to scroll a long way down.
- Three pages keep each one focused: introduction is benefit-led, getting-started is install-led, tutorial is code-led. Matches the convention used by Stripe, Auth0, Clerk, and React Query, which is what new-V1 readers will be measuring this site against.
- All three are linked from the top-level `_meta.json` ordering (`index` -> `getting-started` -> `tutorial` -> `sdk` -> `react` -> `api` -> `auth`), which is the natural reading order: read what it is, install it, do the tutorial, then dive into the reference.

**Trade:** three pages instead of one means three places to keep the install snippet up to date when (e.g.) a new package ships or a new env var becomes required. Acceptable: the snippets live in plain MDX, not in code, and the introduction's snippet is intentionally tiny (one `npm install` line) to minimize duplication. The tutorial does NOT repeat the install steps - it links back to getting-started.

### Phase 13.2: SDK reference pages are hand-written, not auto-generated from JSDoc

**Decision:** every page under `apps/docs/pages/sdk/` is hand-authored MDX. Junjo does NOT run typedoc, api-extractor, or any other JSDoc-to-MDX pipeline against `packages/sdk/src/index.ts`. Each page is written alongside the iteration that ships the corresponding SDK feature: when a new method ships, its iteration commit also adds the prose, options table, errors table, examples, and "see also" cross-links to the API page in `apps/docs/pages/api/`.

**Rationale:**
- A reference page does more than restate types. The shipped `apps/docs/pages/sdk/groups.mdx`, `members.mdx`, `roles.mdx`, etc. carry a wire-shape table, the request / response examples in idiomatic call form, an errors-by-code table cross-linked to the server route, behavior notes (idempotence, no-op semantics, audit-entry shape, soft-delete window, retry policy), and pagination recipes. None of that comes out of JSDoc; an auto-generator would produce a thin shell that readers would still need to bounce out of to find the actual semantics.
- The cross-linking matrix is bidirectional and dense. Every SDK page links to the matching `apps/docs/pages/api/<resource>.mdx`; every API page links back to the SDK page. A generator that emits one page per export does not produce that linking automatically and would have to be configured per-symbol (which is approximately the cost of just hand-writing).
- Junjo's pattern of "write the page when the feature lands" already worked across 7 phases (groups, invitations, members, roles, permissions, audit, webhooks) and 9 pages of SDK reference. The cost is O(1) per iteration and lands in the same commit as the code, so it never drifts from the implementation. Switching to a generator now would invalidate that body of writing and either replace it with thinner output or require a long-lived plugin to merge generator output with hand-prose, which carries its own maintenance cost.
- Writing the SDK reference by hand is exactly the same labor pattern as the API reference under `apps/docs/pages/api/` (also hand-written), the React reference under `apps/docs/pages/react/`, and the auth adapter pages under `apps/docs/pages/auth/`. One uniform authoring stance across the docs site beats a hybrid where some pages auto-generate and others don't.

**Trade:** when an SDK signature changes, the page must be hand-edited to match. The documentation discipline rule in VISION.md ("Every iteration that adds, changes, or removes user-facing behavior MUST update the corresponding docs in the same commit.") catches this on the iteration that makes the change; the iteration log's `## Docs` section is the self-audit. We accept that risk in exchange for the prose quality; if a future audit shows pages drifting from `packages/sdk/src/`, the response is a one-time sweep, not a generator pivot.

**Future additions:** if and when the SDK surface grows past what hand-writing can keep up with (e.g., dozens of new methods per release on a steady cadence), a generator-augmented approach is the natural escape hatch: generate a typed-signatures appendix per page from the public type surface and merge with the hand-written prose at build time. V1 does not need this.


### Phase 13.3: self-host page lives at the docs root, not under a sub-section

**Decision:** the operational guide for running the open-source server lives at `apps/docs/pages/self-host.mdx` (top-level slug `/self-host`), not nested under `apps/docs/pages/api/` or any other section. It is wired into the top-level nav between `tutorial` and `sdk`.

**Rationale:**
- Self-hosters and API consumers are different audiences. An API consumer wants to know "what does this route do" (the right home is `apps/docs/pages/api/`); a self-hoster wants to know "what do I run, what env vars, how do I migrate, how do I issue a key" (a different mental model). Burying the operations guide under `api/` would force operators to scroll past per-route reference to find their ops checklist, and would imply that the page is route documentation when it is process documentation.
- The natural reading order is intro -> install -> tutorial -> operations -> reference. `_meta.json` ordering reflects that flow: `index` (what is it) -> `getting-started` (install) -> `tutorial` (use it) -> `self-host` (run it) -> `sdk` / `react` / `api` / `auth` (reference). A reader who has finished the tutorial and wants to go to production reaches `self-host` next.
- Stripe, Auth0, Supabase, and Clerk all keep their hosting / deployment guides as top-level slugs distinct from per-resource API reference. Same convention.
- The page replaces what `packages/server/README.md` used to be the only home for. `README.md` stays as the in-repo developer reference; `self-host.mdx` is the docs-site polished version that links into other docs pages and that downstream readers can find from search engines without cloning the repo.

**Trade:** the file has no parent directory of its own (no `self-host/index.mdx` + sub-pages). If the operational surface grows enough to need a multi-page treatment (separate "Docker", "Kubernetes", "Backups", "Observability" pages), the file converts to a directory and the existing slug stays valid as `self-host/index.mdx`. V1 fits comfortably on one page; the trade is solving today's problem without pre-building for a hypothetical future split.


### Phase 13.4: auth section gets an overview page plus a "BYO" cookbook page

**Decision:** the `apps/docs/pages/auth/` section grows two new pages: `index.mdx` (the cookbook overview that the existing five `/auth` cross-references resolve to) and `byo.mdx` (the build-your-own recipe page that VISION's Phase 13.4 calls for). The three previously-shipped per-adapter pages (`jwt.mdx`, `clerk.mdx`, `supabase.mdx`) are unchanged. Section ordering in `_meta.json`: `index` -> `jwt` -> `clerk` -> `supabase` -> `byo`.

**Rationale:**
- Five existing cross-references in the docs site already link to the bare `/auth` slug (in `getting-started.mdx`, `index.mdx`, `self-host.mdx`, `tutorial.mdx`). Without an `auth/index.mdx`, all of those 404. The overview page is a forced discoverability move, not optional.
- The overview page does the framing that no per-adapter page does in isolation: what the `AuthAdapter` interface looks like, why its single-method shape is the boundary, the user-id contract (opaque-string + don't-rotate-it + render-numerics-as-strings), the throw-vs-null parity rule, and the "when to use which" table. The per-adapter pages each open with their own framing pitched at "you already chose this provider"; the overview is pitched at "you have not chosen yet."
- The BYO page is the one VISION explicitly calls out in Phase 13.4. Without it, anyone whose auth provider is not Clerk / Supabase / JWT (Auth0 with JWKS rotation, Lucia / hand-rolled session-token stores, Roblox's player API, multi-tenant apps that need to layer adapters) has to reverse-engineer the contract from the three existing pages.
- The cookbook format (one page with five concrete recipes: opaque session store, Auth0 / JWKS, Roblox UserId, passthrough for tests, layered/firstMatch) is the standard escape-hatch shape for auth integrations: "here are five worked examples, copy the closest match, adapt." Stripe / Auth0 / Supabase / Clerk all maintain similar cookbook pages for their integration patterns; matches the convention.
- BYO is a single page (not five), because the recipes themselves are short (10-30 lines each). Splitting them into per-recipe pages would inflate the nav and force readers to bounce between pages to compare patterns. One-page cookbook lets readers ctrl-F across recipes.

**Trade:** the BYO page hand-writes a `firstMatch` adapter and several illustrative wrappers (`sessionStoreAdapter`, `auth0Adapter`, `robloxUserIdAdapter`, `staticUserAdapter`) that Junjo does NOT ship as code. The wrappers exist only as docs prose. Promoting any of them into `packages/sdk/src/adapters/` would commit Junjo to maintaining them; keeping them as cookbook examples lets devs copy-adapt without ongoing version-pinning costs. The Phase 8.3 `RobloxUserIdAdapter` (which DOES ship as code, but in `junjo-roblox`, the Luau SDK) is cross-referenced from the recipe so the relationship between the two is explicit.

**Future additions:** if a recipe pattern proves popular enough that every dev hand-rolls the same wrapper, the right move is to ship it as code under `@junjo/sdk/adapters` and convert the recipe into a per-adapter page (matching the jwt / clerk / supabase precedent). V1 does not need this.

### Phase 8.1: Roblox SDK ships as a single `Junjo.lua` file with internal `Http` and `JunjoError` classes

**Decision:** the entire Phase 8.1 surface lives in `packages/sdk-roblox/src/Junjo.lua` (a single Lua module). The internal `Http` class and `JunjoError` table-with-metatable live in the same file rather than separate `Http.lua` / `JunjoError.lua` siblings. Phase 8.2 will rename `Junjo.lua` to `init.lua` and add per-namespace siblings (`Groups.lua`, `Members.lua`, etc.) at that point.

**Rationale:**
- Phase 8.1's surface is small (`Junjo.new`, `junjo.http:get/:post/:patch/:put/:delete`, `Junjo.Null`, `Junjo.JunjoError`). Splitting it across three files would create more import boilerplate than the saved code-density justifies, and the `Http` class is purely internal (callers never instantiate it directly).
- Roblox's standard module convention is `ModuleScript` (single file) for simple modules and `Folder/init.lua` (multi-file) for compound modules. Phase 8.1 fits the simple case; Phase 8.2 needs the compound case (one namespace per file). Migrating from the simple shape to the compound shape is one rename plus N new siblings, which is cheap.
- The README example (`require(ReplicatedStorage.Junjo)`) works identically against either layout, so consumers see no churn at the Phase 8.1 -> 8.2 transition.

**Trade:** if a future iteration needs to share `JunjoError` or the `Http` class outside `Junjo.lua` (e.g. an in-package test harness, or a plugin script in the same Roblox project), it would need to extract those symbols into their own ModuleScripts. Acceptable: when it actually happens, do the extraction. Premature splitting now costs more than it saves.

### Phase 8.1: `Junjo.Null` sentinel uses `newproxy` + placeholder-string substitution to express JSON null in PATCH bodies

**Decision:** `Junjo.Null = newproxy(false)` is a unique userdata token. Body encoding walks the table tree and substitutes every `Junjo.Null` reference with a randomized placeholder string (`"__JUNJO_NULL_3f6c9a01__"`); after `HttpService:JSONEncode` runs, the encoder string-substitutes `"\"__JUNJO_NULL_3f6c9a01__\""` with the literal JSON `null`. Callers express `{ defaultRoleId = Junjo.Null }` to send `"defaultRoleId": null`.

**Rationale:**
- Lua tables treat `nil` as "key absent" (the iteration semantics of `pairs` and `next`), and Roblox's `HttpService:JSONEncode` does NOT expose a JSON-null helper. Without an explicit sentinel, callers cannot send `{ "defaultRoleId": null }` from Lua at all.
- The substitution-via-placeholder trick is the standard Lua workaround. The token includes a randomized hex suffix so an accidental collision with caller content is vanishingly unlikely (and would only matter if a string field accidentally contained that exact value, which would not pass code review).
- `newproxy` is the cheapest way to create a unique userdata reference. Roblox's Luau supports it natively. The alternative (a unique table reference like `{}`) would also work but `newproxy` makes intent clearer (this is a sentinel, not a struct).
- The Phase 8.2 namespace methods (`groups.update` etc.) will accept the same partial-body shape as the TypeScript SDK's `UpdateGroupInput` etc. The sentinel is the bridge that lets Lua callers express the full surface today rather than waiting for a more elaborate body-builder helper.

**Trade:** the sentinel is reference-equal-only (`==` against `Junjo.Null`). Tables that go through serialization libraries that copy values (deep-clone, immutable.js-style libs, cross-Roblox-instance transfer) can lose the sentinel reference. Acceptable for V1: the sentinel only needs to survive from the user's `junjo.http:patch(...)` call site through the synchronous body-encode path, and it does. If a future iteration needs to round-trip nulls through SerDe, switch to a string-literal sentinel (e.g. `Junjo.Null = "<JUNJO_NULL>"`).

### Phase 8.1: `apiKeySecret` triggers `HttpService:GetSecret`, with `apiKey` as the literal-string fallback

**Decision:** `Junjo.new(config)` accepts both `apiKey` (a literal string OR a Roblox `Secret` userdata) and `apiKeySecret` (a Roblox secret-store name). When `apiKeySecret` is supplied the SDK calls `HttpService:GetSecret(apiKeySecret)` inside a `pcall`; on success the returned value (which may be a `Secret` userdata or a string depending on Roblox version) is concatenated into the auth header. On failure (HttpService disabled, secret not registered, etc.) the SDK falls back to `apiKey` when present, otherwise raises `invalid_config`. Specifying only `apiKey` skips the secret lookup entirely.

**Rationale:**
- Roblox's `Secret` type is opaque: `tostring(secret)` returns a placeholder like `<<HTTP_SECRET>>`, not the actual key. The Secret can only be resolved inside `HttpService:RequestAsync` itself. So the SDK has to thread the `Secret` through verbatim into the header, not extract a string from it.
- String-concatenation against a `Secret` produces another `Secret` (Roblox's documented behavior). So `"Bearer " .. secret` works whether `secret` is a string OR a Secret, and `RequestAsync` substitutes the actual value at request time without ever exposing it to Lua. This means the SDK's HTTP wrapper does not need a separate "is this a Secret" code path: the same header-construction line works for both.
- The two-field config (apiKey + apiKeySecret) lets devs put the secret name in source-controlled code (`apiKeySecret = "JUNJO_API_KEY"`) while keeping a literal-string fallback for local Studio testing where the secret is not registered (`apiKey = "junjo_test.localdev"`). The fallback path is the production-friendly default: in production both fields can be absent of the literal and the secret name resolves; in dev the secret name is missing and the literal kicks in.
- VISION's Phase 8.1 spec calls out exactly this fallback shape ("API key: read via `HttpService:GetSecret(secretName)`, fall back to passing apiKey in `config` if `HttpService:GetSecret` errors"). The decision matches the spec verbatim.

**Trade:** the SDK does not assume a magic default secret name like `"JUNJO_API_KEY"` when neither field is supplied. Callers must opt in by setting `apiKeySecret` explicitly. Acceptable: implicit default secret names are surprising in test environments and would conflict with multi-game setups where multiple Junjo keys live in the same Roblox project.

### Phase 8.1: errors are raised with `error(JunjoError, 0)` rather than `error(string)`

**Decision:** every non-2xx response and every config validation failure raises a `JunjoError` table (built with `setmetatable({}, JunjoError)`) via `error(table, 0)`. The `0` level argument suppresses Lua's automatic file:line prefix so the value `pcall` returns is the raw table. The exported `Junjo.JunjoError.is(value)` helper checks the metatable so consumers can branch on `if Junjo.JunjoError.is(err) then ... else error(err) end` after `pcall`.

**Rationale:**
- Mirrors the TypeScript SDK's `JunjoError` contract (`{ code, status, message }`). Consumers who already speak Junjo on TS get the same field names and branching pattern on Lua.
- Branching on `err.code` (stable taxonomy) is more robust than parsing `tostring(err)` (a freeform message). The `__tostring` metamethod still produces a readable summary for `print(err)` / log lines.
- Lua's `error(value, 0)` accepts any value; the `0` level avoids polluting structured errors with file:line junk that would force consumers to peel off a prefix before they could read `err.code`.
- The `JunjoError.is(value)` shape (rather than `instanceof JunjoError`) is the idiomatic Lua check: `getmetatable(value) == JunjoError`. It is the Lua equivalent of TypeScript's `err instanceof JunjoError` and serves the same role.

**Trade:** unstructured Lua errors (a coding bug in the SDK or in the consumer's pcall'd block) still arrive as strings or other values. Consumers that catch with `pcall` must use `Junjo.JunjoError.is(err)` to distinguish "the SDK rejected the request" from "the SDK or my code crashed". Documented in the docs page; the same shape every Lua library that uses structured errors lands on.

### Phase 8.1: Roblox docs land at `apps/docs/pages/roblox/`, distinct from `/sdk` (TypeScript)

**Decision:** the Roblox SDK gets its own top-level docs section at `apps/docs/pages/roblox/`, parallel to `/sdk` (TypeScript) and `/react`. The top-level `_meta.json` orders it as `index -> getting-started -> tutorial -> self-host -> sdk -> react -> roblox -> api -> auth`. Phase 8.1 ships only `roblox/index.mdx` (the overview); future Phase 8 iterations can add per-namespace sub-pages (`roblox/groups.mdx` etc.) as the API grows.

**Rationale:**
- Roblox is a distinct runtime with distinct conventions (Luau syntax, `HttpService` quirks, `Secret` userdata handling, no streaming HTTP). Co-locating with `/sdk` would force every code example to be either Lua-only (alienating TS readers) or dual-language (inflating page size). Splitting matches how Stripe documents Stripe for iOS / Android / .NET separately, not as variations under Stripe.js.
- The natural reading order is: read what Junjo is, install the server, run the tutorial, then dive into whichever client SDK matches your runtime. Putting `roblox` after `sdk` and `react` (the two npm packages) groups all client SDKs together, alphabetical within "non-npm" tier.
- Phase 8.1 is small enough (one page) that a single `roblox/index.mdx` with a "what ships today / what lands later" status table is the right shape today. The directory makes future expansion (one page per namespace) drop-in: just add `roblox/groups.mdx` plus a row in `_meta.json`.

**Trade:** new top-level section adds one nav entry. Acceptable: the Junjo nav is already eight entries deep, one more is cheap; and the alternative (burying Roblox under `/sdk/roblox`) would imply the Roblox client is a sub-variant of the TypeScript SDK rather than a sibling.

### Phase 8.2: Roblox SDK source splits into `init.lua` + per-namespace siblings + extracted `JunjoError` / `Http` / `Null` modules

**Decision:** the Phase 8.1 single-file `Junjo.lua` is renamed to `init.lua` and joined by sibling ModuleScripts: `JunjoError.lua` (the error class), `Null.lua` (the JSON-null sentinel), `Http.lua` (the HTTP wrapper class), and per-namespace `groups.lua` / `members.lua` / `roles.lua` / `invitations.lua` / `audit.lua` / `webhooks.lua`. The composition (config validation, namespace wiring, top-level `:can` / `:check`) lives in `init.lua`. Iteration 052's decision forecast that this transition would happen in 8.2; this iteration carries it out.

**Rationale:**
- VISION's Phase 8.2 spec is explicit: "Each namespace is its own Luau module under `packages/sdk-roblox/src/` (e.g., `groups.lua`, `members.lua`)". Mirrors the TypeScript SDK's per-resource layout (`packages/sdk/src/groups.ts` / `members.ts` / etc.).
- Roblox's `init.lua` convention works the same as Python's `__init__.py`: a file named `init.lua` inside a folder *becomes* the ModuleScript at the folder level, with sibling files exposed as child ModuleScripts. So `require(ReplicatedStorage.Junjo)` continues to resolve to `init.lua` after Rojo / Wally / model-export sync; consumers see no churn at the 8.1 -> 8.2 transition.
- Extracting `JunjoError` to its own file is required: every namespace module needs `JunjoError.is(value)` for the `tryGet` "translate not_found to nil" pattern. Putting it in `init.lua` would create a circular `require` (init -> namespace -> init) that Lua does not deadlock on but does return an empty intermediate state, leading to nil-method bugs.
- Extracting `Http` and `Null` to their own files is the same reasoning: namespace files need them, init also needs them, and Lua's `require` cache guarantees every consumer gets the same module instance (so `Junjo.Null == require(script.Parent.Null)` holds across all callers, which the body-encoder's reference-equality check relies on).
- Lowercase namespace filenames (`groups.lua` vs `Groups.lua`) match VISION's spec verbatim. PascalCase for class-shaped helpers (`JunjoError.lua`, `Http.lua`, `Null.lua`) differentiates "this is a class / sentinel" from "this is a namespace table".

**Trade:** more files (10 instead of 1). Acceptable: the alternative is a single 800+-line `init.lua` with everything inline, which would obscure the per-namespace surface and make code review harder. Each namespace file is now ~50-150 lines and reads top-to-bottom as the TS SDK module it mirrors.

### Phase 8.2: Roblox namespace methods are colon-style (`junjo.groups:create({...})`) returning the parsed wire shape verbatim

**Decision:** every per-namespace method follows the colon-call convention (`junjo.groups:create({...})`, `junjo.members:assignRole(g, u, r)`, `junjo:can(u, g, p)`). Methods receive the namespace's `self` (which carries the `_http` reference) and return the parsed server response verbatim - no deserialization layer, no Date rehydration, no branded-id tagging. Timestamps stay as ISO 8601 strings; the consumer calls `DateTime.fromIsoDate(s)` if they want a Roblox `DateTime` value.

**Rationale:**
- VISION's Phase 8.2 spec uses colon-call syntax in its example (`junjo.groups:create({ kind = "guild", name = "..." })`). Matches Lua-class idiom (the `:` syntax is the standard way to express "method with implicit self") and reads naturally for Roblox developers.
- Skipping deserialization keeps the Roblox SDK thin and predictable: what the server sends is what the consumer sees. The TypeScript SDK rehydrates `Date` because JS has a built-in `Date` type with idiomatic `.getTime()` / `.toISOString()` semantics. Roblox has `DateTime` (strict-month-not-zero-indexed) and `os.time` (Unix epoch seconds) - both Roblox-specific - so picking either as the SDK-default would force the choice on consumers who might prefer the other.
- Branded-id types (`GroupId`, `RoleId`, etc.) are TypeScript-only - they compile away to plain strings. Lua has no equivalent type system, so there is nothing to preserve at runtime. Wire ids stay as strings.
- The lookup-returns-nil-on-404 contract (`groups:get`, `members:get`, etc.) is preserved via a private `tryGet` helper in each namespace that wraps the call in `pcall` and translates `JunjoError({code = "not_found"})` to `nil`. Every other error code re-throws verbatim.

**Trade:** consumers who want timestamps as numbers / DateTimes pay one `DateTime.fromIsoDate(s)` call per field. Acceptable: most consumers either render the ISO string verbatim (logs, debugging) or convert per-call where they need it. The alternative (deserializing by default) imposes a runtime cost on every response and forces the ISO-vs-DateTime-vs-os.time choice on consumers who don't care.

### Phase 8.2: `groups:setParent` accepts both `nil` and `Junjo.Null` to clear; every other "clear" path requires `Junjo.Null` explicitly

**Decision:** `junjo.groups:setParent(groupId, parentGroupId)` treats `nil` AND `Junjo.Null` identically (both clear the parent on the server). Every other PATCH-style mutation (`groups:update`, `members:setNotes`, `members:setMetadata`, etc.) requires the caller to pass `Junjo.Null` explicitly when they want to clear a server-side field; passing plain `nil` omits the field from the request body (the "absent means no change" convention).

**Rationale:**
- Lua tables cannot carry plain `nil` values: `{ k = nil }` is exactly `{}` after construction. So a Lua API that takes a `string | nil` argument has no way to distinguish "the caller explicitly chose nil" from "the caller forgot to pass anything". For a single positional arg like `setParent(groupId, parentGroupId)`, treating both as "clear" is the only useful behavior.
- For partial-update bodies (`groups:update(id, { name = ..., defaultRoleId = ... })`), the caller has full control over which keys appear in the table. Passing `{ name = "Renamed" }` reasonably means "update only name"; passing `{ name = "Renamed", defaultRoleId = nil }` is also `{ name = "Renamed" }` (Lua absorbs the nil). So the body-side convention "nil is absent; Junjo.Null is explicit null" matches Lua's own semantics and matches every other Junjo PATCH route's contract.
- The asymmetry between `setParent` and `update` is intentional: `setParent` has a single "this field" semantic, so mapping nil to "clear that field" is unambiguous. `update` has many fields, so mapping nil to "clear all the fields you didn't mention" would be a footgun.
- VISION does not call out this rule explicitly; the SDK chooses the most useful behavior at each call site.

**Trade:** documenting the asymmetry takes a paragraph in the docs page. Acceptable: a single asymmetric callout is cheaper than always requiring `Junjo.Null` (which would force `setParent(g, Junjo.Null)` for the most common "remove from hierarchy" operation; that reads worse than `setParent(g, nil)` or `setParent(g)`).

### Phase 8.2: Roblox SDK does NOT mirror `groups.subscribe` (SSE) or `webhooks:verify` / `:middleware` (receiver-side)

**Decision:** the per-namespace surface mirrors the TS SDK's `groups`, `members`, `roles`, `invitations`, `audit`, `webhooks.endpoints` namespaces and the top-level `:can` / `:check`. The TS SDK's `groups.subscribe(groupId, handler)` (SSE stream) and `junjo.webhooks:verify(...)` / `junjo.webhooks:middleware(...)` (HTTP receiver helpers) are intentionally not mirrored on Roblox in V1.

**Rationale:**
- `groups.subscribe`: Roblox's `HttpService:RequestAsync` does not stream; it reads the full response body before resolving. SSE is a streaming protocol. Adding `groups.subscribe` would either fake-stream by polling (wrong semantics, bad UX) or wait for `MessagingService` integration (post-V1). VISION's Phase 8.2 spec calls this out: "skip `subscribe` / SSE for V1 since Roblox HttpService doesn't do streaming; revisit with MessagingService later".
- `webhooks:verify` / `:middleware`: a Roblox game server cannot expose an HTTP endpoint (Roblox's network model is outbound-only HttpService + Roblox-internal RemoteEvents / RemoteFunctions). So a Roblox game is never a webhook receiver, and helpers for receiver-side delivery validation have no use case. The `webhooks.endpoints` CRUD surface (creating / updating / listing webhook configurations) IS mirrored, since a Roblox game might programmatically configure its own webhook endpoints.

**Trade:** the Roblox SDK is a strict subset of the TS SDK. Acceptable: the missing pieces are runtime-defined, not design choices. A consumer who needs SSE-equivalent live updates between Roblox servers uses `MessagingService` directly (the post-V1 plan); a consumer who needs to receive Junjo webhooks runs a separate Node service.

### Phase 8.2: `Http` exposes a `:postRaw(path, body, contentType)` method for non-JSON bodies (`groups:bulkInvite`)

**Decision:** the HTTP wrapper grows a `:postRaw(path, body, contentType)` method that POSTs the body verbatim with a caller-supplied `Content-Type` header, skipping the JSON encode + `Junjo.Null` substitution path. Used internally by `groups:bulkInvite` to deliver a CSV body with `text/csv`. Mirrors the TS SDK's `HttpClient.postRaw` from iteration 017.

**Rationale:**
- `bulkInvite` is the only V1 route that takes a non-JSON body; carving out a single helper keeps the JSON-default path simple (every other namespace method goes through `:post(path, body)`). Adding a content-type optional arg to `:post` would conflate two axes (JSON vs non-JSON, and POST vs non-POST) and complicate the wrapper signature for everyone.
- The TS SDK chose the same shape for the same reason. Consistency between SDKs reduces cognitive load for consumers reading both.
- The Roblox version of `bulkInvite` accepts only a string body (the TS SDK additionally accepts `ReadableStream<Uint8Array>`); Roblox's `HttpService` does not consume streams, so the SDK signature drops the stream variant. The string-only path covers the realistic Roblox use case (a CSV built in-memory or read from a Roblox `DataStore` blob).

**Trade:** one extra public method on `junjo.http`. Acceptable: bulk-invite is a documented use case in Phase 2.8; the Roblox SDK without a way to deliver CSV bodies would silently miss one TS-SDK feature. Naming `postRaw` matches the TS SDK exactly so consumers searching documentation find both.

### Phase 8.3: `RobloxUserIdAdapter` is a renderer (`:resolve(value?)`), not a TypeScript-style `AuthAdapter`

**Decision:** the built-in adapter shipped at `packages/sdk-roblox/src/adapters/RobloxUserId.lua` exposes a single method `:resolve(value?)` that converts a `Player`, a positive integer, an explicit string, or a nil-meaning-`Players.LocalPlayer` to the opaque-string user id Junjo persists. It is NOT the TypeScript `AuthAdapter` shape (no `verifyToken`, no async, no `Promise<{ userId } | null>` return) and is NOT passed to `Junjo.new(config)` as a `authAdapter` field. The adapter is used standalone (`Junjo.RobloxUserIdAdapter()`) and called explicitly from the consumer's request-building code.

**Rationale:**
- VISION's Phase 8.3 spec describes the adapter as "Reads `game:GetService("Players").LocalPlayer.UserId` in client contexts, or accepts an explicit UserId for server-side / tests. Returns the id as a string." That is a renderer specification, not a verifier.
- Roblox does not give the dev's backend a session token for the player. The trust boundary in Roblox is the game server itself: when `Players.PlayerAdded` fires with a `Player` instance, the script already trusts that the player is authenticated (Roblox handled the platform-level auth before populating the `Player`). The TypeScript `AuthAdapter` interface exists because in a Node backend the dev DOES receive an opaque session token from the client and needs to verify it against an upstream provider; that flow has no Roblox counterpart.
- Even if the adapter were async + token-shaped, the `Junjo.new(config)` factory shipped in Phase 8.1 doesn't have an `authAdapter` config field (the Roblox SDK doesn't have a `whoami` flow that would consume one). Wiring an unused option just to match the TS shape would be fake.
- Calling `:resolve(player)` explicitly at the request-building site (`junjo.groups:inviteByUserId(group.id, userIds:resolve(player))`) is more readable than a hidden `Junjo.new({ authAdapter = ... })` config that gets called somewhere down the stack. It's a thin function disguised as an adapter; the explicit-call shape advertises that.

**Trade:** the Roblox adapter is asymmetric with the three TS SDK adapters (`jwt`, `clerk`, `supabase`) which all implement `AuthAdapter.verifyToken`. Acceptable: the asymmetry reflects a real runtime difference. The shared concept ("a thing that knows how to produce a Junjo user id") is preserved by both API shapes; the implementation detail (token-verifier vs renderer) tracks the runtime's actual contract.

### Phase 8.3: `:resolve(value?)` accepts four argument shapes (Player, integer, string, nil)

**Decision:** the adapter's single method accepts: a `Player` instance (or stub table with a numeric `UserId` field), a positive integer (rendered with `tostring`), a non-empty string (returned verbatim), or `nil` (reads `Players.LocalPlayer.UserId`). Every failure raises `JunjoError({ code = "invalid_config" })`.

**Rationale:**
- The `Player`-instance shape is the dominant case (server-side scripts have a `Player` from a `PlayerAdded` event or a `RemoteEvent` invocation).
- The integer shape covers the case where the consumer already extracted the UserId for some reason and just wants the adapter for the `tostring` conversion.
- The string shape is a passthrough: useful when chaining adapters (a layered "first one that produces a string wins" pattern would be common in multi-tenant games), or when the consumer has an id from a different source (e.g. a teamspeak handle stored on a player) and is funneling everything through one adapter.
- The nil shape is for `LocalScript` contexts (client-side) where `Players.LocalPlayer` is populated. Server-side this raises `invalid_config` because `LocalPlayer` is `nil` server-side; raising explicitly with a useful message is better than a downstream "attempt to index a nil value" Lua error.
- All four shapes feed into the same downstream string id, so consumers can substitute one for another without changing call shape elsewhere.

**Trade:** more validation surface (four kinds to type-check). Acceptable: each branch is 3-5 lines; the alternative of "only accept Player" forces consumers to write `tostring(player.UserId)` or `tostring(userId)` themselves, which defeats the adapter's whole purpose of centralizing the conversion.

### Phase 8.3: `explicitUserId` constructor option for tests / scripted automation

**Decision:** `Junjo.RobloxUserIdAdapter({ explicitUserId = "12345" })` returns an adapter whose `:resolve()` ignores its argument and always returns `"12345"`. Accepts a non-empty string OR a positive integer (rendered with `tostring`). Documented as "tests / scripted automation only".

**Rationale:**
- Mirrors the TS SDK's `staticUserAdapter` recipe in `apps/docs/pages/auth/byo.mdx` (recipe 4): a "skip verification entirely" passthrough for testing.
- Without it, tests that exercise Junjo wrappers around the adapter need to either construct a fake `Players` service with a `LocalPlayer.UserId` (verbose) or build a stub Player table (also verbose). One option-bag field collapses both to one line.
- The "tests only" warning in the docs body matches the same warning the TS `staticUserAdapter` recipe uses; copying the warning verbatim keeps the failure-mode story consistent across SDKs.

**Trade:** misuse risk. A production deployment with this option set returns the same id for every player, which is exactly wrong. Acceptable: the option is opt-in (the default `RobloxUserIdAdapter()` reads from the `Player` argument), the warning lives in both the inline doc-comment and the user-facing docs page, and the alternative (no test-friendly path) would push consumers toward shipping bespoke fakes that diverge from the production adapter.

### Phase 8.3: adapter raises `JunjoError({ code = "invalid_config" })` on every failure path; never produces a server-defined code

**Decision:** every error the adapter raises uses `code = "invalid_config"`. Empty strings, zero, negative numbers, non-integer numbers, missing `UserId` field on a Player, server-side calls without a Player argument, malformed `explicitUserId` - all `invalid_config`.

**Rationale:**
- The adapter never calls the Junjo API, so it cannot produce a server-side error code (`not_found`, `permission_denied`, etc.). Every failure is a programmer error: passing the wrong argument, calling `:resolve()` from the wrong context, supplying a malformed config option.
- Matches the TS SDK's three adapters (`jwt`, `clerk`, `supabase`) which all reserve `invalid_config` for setup-time misconfiguration that should fail loud at startup. The adapter follows the same throw-vs-null contract: if the runtime contract is broken, throw; if the contract is honored, return a value.
- Roblox's `Players.LocalPlayer` being `nil` on the server is not a runtime failure - it is a context error (the consumer called the wrong method shape for the wrong context), so it raises with a message guiding the consumer to `:resolve(player)`.

**Trade:** consumers branching on `err.code` to distinguish "bad input" vs "wrong context" cannot do so via the code. Acceptable: the message text carries the distinguishing detail (`expected a Player; got nil`, `Players.LocalPlayer is nil`), and adding a second code (`wrong_context`?) for one adapter would diverge from the TS adapter contract for no gain.

### Phase 8.3: adapter under `packages/sdk-roblox/src/adapters/` (subfolder), not as a sibling top-level file

**Decision:** the adapter lives at `packages/sdk-roblox/src/adapters/RobloxUserId.lua`, in its own subfolder, and is required via `require(script.adapters.RobloxUserId)` from `init.lua`. This matches the TypeScript SDK's `packages/sdk/src/adapters/{jwt,clerk,supabase}.ts` layout (subfolder per SDK for adapter modules).

**Rationale:**
- Roblox's folder-as-ModuleScript convention means a subfolder reads as a sub-namespace at the require level. A future second adapter (a JWT-token-verifier for Roblox-hosted REST APIs that DO issue session tokens, for instance) lands as `adapters/JwtUserId.lua` without polluting the top-level file list.
- Mirrors the TS SDK layout, so a developer reading both SDKs sees the same `adapters/` shape on both sides.
- PascalCase filename (`RobloxUserId.lua` not `robloxUserId.lua`) matches the existing convention for class-shaped helpers (`JunjoError.lua`, `Http.lua`, `Null.lua`). Lowercase namespace files (`groups.lua`, `members.lua`) are reserved for namespace tables.

**Trade:** one more directory in the source tree for one file. Acceptable: future adapters are expected (Phase 8 in VISION calls Phase 8.3 the start of the adapter family even though only one ships in V1), and the subfolder convention is what every contributor will reach for first when adding the second one.

### Phase 10.1: `findOrCreateJunjoUser` recovers from P2002 by catching + re-selecting, not by upsert

**Decision:** the race-safety pattern is "try the two-row create in its own transaction; if it fails with P2002 on the `(gameId, externalUserId)` unique index, re-select the winner's mapping and return its `junjoUserId`." Not an upsert, not a DB-level advisory lock, not a single-statement INSERT-ON-CONFLICT.

**Rationale:**
- The two-row create has a structural ordering constraint: `ExternalIdentity.junjoUserId` is a foreign key, so the `JunjoUser` has to exist before the `ExternalIdentity` row. A naive `prisma.externalIdentity.upsert` can't express the "create the parent JunjoUser if and only if we're inserting" branch.
- Both rows have to commit atomically. If we created the JunjoUser first outside a transaction and then lost the ExternalIdentity race, the JunjoUser would orphan. The inner `prisma.$transaction` ensures the JunjoUser create rolls back when the ExternalIdentity unique-violation fires (Postgres marks the transaction failed, Prisma surfaces it as P2002, no row commits). So the loser leaves no orphan.
- A Postgres advisory lock would serialize concurrent creates without surfacing failures, but introduces lock-management failure modes (orphaned locks if the process dies between acquire and release) for a problem the unique index already solves correctly.
- The pattern is symmetric with how every other Junjo route handles unique-constraint races (PrimaryKey-on-content tables: `RolePermission`, `MemberRole`, `MemberPermissionOverride`, `Invitation.code`): catch P2002, treat as "someone else won," recover.

**Trade:** the recover path opens a fresh transaction even when there's no actual race. Acceptable: the fast-path `findUnique` covers the common case (existing identity), and the slow path runs once per brand-new external id per game.

### Phase 10.1: `findOrCreateJunjoUser` requires a top-level `PrismaClient`, not a `Prisma.TransactionClient`

**Decision:** the helper's first argument is typed as `PrismaClient` (was `IdentityClient = PrismaClient | Prisma.TransactionClient`). Callers that need atomicity with downstream writes (the accept and decline routes both wrote `GroupMember` + `AuditEntry` + `Invitation.update` alongside the find-or-create) pre-resolve the user first, then enter their main transaction with the resolved `junjoUserId`.

**Rationale:**
- Postgres marks a transaction as failed after a unique-constraint violation and refuses subsequent statements until rollback. The recovery path (catch P2002, re-select winner) needs to issue queries that commit independently of any caller transaction; that's only possible if the helper owns its own transaction. Calling the helper from inside `prisma.$transaction(async (tx) => ...)` would poison the outer transaction on a race.
- The pre-resolved `junjoUserId` is idempotent (the next call returns the same id), so if the main transaction subsequently fails (e.g., `already_member`), the JunjoUser stays. Not a leak: the row is reused on the next attempt.
- The atomic group of writes that actually needs co-commit is `GroupMember` + `AuditEntry` + `Invitation.update`. The JunjoUser/ExternalIdentity create predates the redemption logic and has its own atomicity guarantees inside the helper.

**Trade:** the route handler now does two round trips (resolve, then transaction) instead of one. Acceptable: the throughput cost is negligible (an extra microsecond on the resolved-already path; one transaction commit on the brand-new path), and the alternative (transaction inside transaction with manual SAVEPOINT management) is not exposed by Prisma's API.

### Phase 10.1: per-request `c.var.junjoUserId` cache deferred to a future wire-shape change

**Decision:** Phase 10.1 ships the race-safe `findOrCreateJunjoUser` helper but does NOT integrate it into `apiKeyMiddleware` to populate `c.var.junjoUserId`. Routes continue to call the helper themselves with the userId carried in their request body or path.

**Rationale:**
- VISION's spec for 10.1 asks for "Cache the mapping per request via `c.var.junjoUserId` so downstream handlers don't re-query." The cache only pays off if a single request resolves the same external user id twice; today no V1 route does that (`bulkInvite` already batches its lookups; every other authed route needs at most one resolve).
- Middleware integration requires a single-source-of-truth wire convention for "the current authenticated user" (e.g., a request-wide `X-Junjo-Authenticated-User: <externalId>` header set by every SDK call after auth-adapter verification). V1 doesn't have that convention: routes carry user ids per-route via body or path, and many routes (group list, role get, audit list, permission check) have no current-user semantic at all.
- Adding the header now would be a wire-shape change touching the SDK and every authed route. That's a separate iteration; folding it into 10.1 would expand scope past "ExternalIdentity resolution flow."

**Trade:** the helper's call sites repeat the resolve pattern. Acceptable: only two call sites today (accept, decline), both already explicit; future routes get the same explicit call pattern. When a header convention lands (probably bundled with the auth-adapter-server-side work hinted at in VISION), middleware integration is a small additive change that uses the same helper unchanged.

### Phase 10.1: race test fires N concurrent calls, asserts on row counts

**Decision:** the concurrent-create test fires `Promise.all` over 8 calls to `findOrCreateJunjoUser` for the same brand-new `(gameId, externalUserId)` pair, then asserts: every call returns the same id, exactly one `JunjoUser` row exists, exactly one `ExternalIdentity` row exists. Not a mock-based test, not a manually-injected delay, not a single deterministic conflict.

**Rationale:**
- Real concurrent calls against the same Postgres database give the unique-constraint serializer the opportunity to fire. The test exercises the actual recovery path (one winner, N-1 losers each catching P2002 and re-selecting).
- Mocking the conflict would test the catch-and-re-select branch in isolation, but would not exercise the integration: that the `prisma.$transaction` rollback discards the loser's candidate `JunjoUser`, that the unique index is wired to the right column pair, that the re-select sees the winner's committed row.
- N=8 is more than enough to make the race actually happen on the test runner (the unique constraint serializes inserts, so at least N-1 of them WILL hit P2002 and exercise the recovery path on every run). N=2 would be flaky on a fast machine where the first call commits before the second begins.
- A second test ("recovers when the first call wins and a concurrent second call hits the unique constraint") verifies the deterministic case where the existing identity is read on the fast path AND new concurrent racers all converge to the same id.

**Trade:** the test is non-deterministic in WHICH winner appears (the test doesn't assert which `junjoUserId` value is returned, just that all callers agree). Acceptable: the spec is "no duplicates"; the winner's identity is irrelevant to correctness.

### Phase 10.1: identity tests live in `identity.test.ts`, not folded into route tests

**Decision:** the new test file `packages/server/src/identity.test.ts` exercises `findOrCreateJunjoUser` and `findJunjoUserId` directly, separate from the route-test files (`routes/groups.test.ts`, `routes/invitations.test.ts`) that already exercise these helpers indirectly through the accept / leave / kick flows.

**Rationale:**
- The race-safety and concurrent-create scenarios spec'd in VISION are properties of the helper, not properties of any route. Putting them in a route test file conflates "did the route's audit entry shape change?" with "is the helper race-safe?" - failures would be ambiguous.
- The route tests cover the integration path (helper called inside a real route handler with API-key middleware in scope); the identity tests cover the unit path (helper called directly with a `PrismaClient`). Both paths matter; neither subsumes the other.
- Future identity work (the cross-game admin lookup in Phase 10.2, an eventual `c.var.junjoUserId` middleware integration) gets a natural home in `identity.test.ts` instead of bloating route test files.

**Trade:** one more test file in `packages/server/src`. Acceptable: matches the precedent of `softDelete.test.ts`, `apiKey.test.ts`, `errors.test.ts`, `permissionCache.test.ts` - module-scoped tests next to their module.

### Phase 10.2: cross-game user query lives at `GET /v1/users/:junjoUserId/games`, gated by a separate admin token

**Decision:** Phase 10.2 ships `GET /v1/users/:junjoUserId/games` returning `{ junjoUserId, games: [{ gameId, externalUserId, joinedGroupCount }] }`. The route is gated by a server-wide `JUNJO_ADMIN_TOKEN` env var (separate auth scheme from per-game API keys), checked by a new `adminAuthMiddleware` that constant-time-compares the presented Bearer token against the configured value. The admin route is registered in `app.ts` BEFORE the per-game `apiKeyMiddleware` so the per-route admin middleware is the only auth check that runs.

**Rationale:**
- VISION's Phase 10.2 spec calls for "an admin token (separate from per-game API keys; document a single `JUNJO_ADMIN_TOKEN` env var on the server, checked via `Authorization: Bearer ${admin_token}`)". A per-game API key is the wrong shape for cross-game queries: it identifies which game is calling, but the cross-game endpoint operates across all of them.
- The admin token is a single secret per deployment, intended for the dashboard or operator scripts. The dashboard reads it from its own env (`JUNJO_ADMIN_TOKEN`) and includes it on every cross-game request.
- Registering the route before `apiKeyMiddleware` follows the same "public route inside `/v1`" pattern set by `getInvitationByCodeHandler` (iter 012); the per-route admin middleware is the only auth check that runs because `apiKeyMiddleware` would only attach later in the chain (the admin handler returns a Response without calling next, so apiKey never executes).

**Trade:** two distinct auth-failure error codes (`invalid_api_key` and `invalid_admin_token`) instead of one shared 401. The trade is intentional: the codes name the calling shape, so a misconfigured client knows whether they used the wrong token or the wrong endpoint without having to interpret a generic 401.

### Phase 10.2: `JUNJO_ADMIN_TOKEN` is optional; unset means "endpoints disabled"

**Decision:** `JUNJO_ADMIN_TOKEN` is an optional env var (Zod: `z.string().min(1).optional()`). When unset, every request to an admin endpoint returns `401 invalid_admin_token` with the message "admin endpoints are disabled on this server". Self-hosters with one game per server can ignore the env var entirely; cloud / dashboard deployments set it to a long random string at deploy time.

**Rationale:**
- A required env var would break self-host onboarding for setups that don't need cross-game visibility (a single-game self-host doesn't need this endpoint at all).
- A default value (e.g. an empty string treated as "open") would be a security footgun: any deployer who forgets to override it ships an open admin endpoint.
- The "disabled" stance treats absence-of-config as "off" rather than "open" - the safe default for a security-relevant feature. It also gives operators a deliberate kill switch (unset the env var, restart, every admin endpoint goes 401).
- Empty-string is rejected by the Zod schema (`min(1)`) so a stray `JUNJO_ADMIN_TOKEN=` line in a `.env` file fails fast at startup rather than silently disabling the endpoints.

**Trade:** the wrong message ("disabled") on a misconfigured deployer who DID intend to use the feature. Acceptable: the message is explicit, and the operator's first instinct ("did I forget to set the env var?") is the right diagnostic step.

### Phase 10.2: admin token compared in constant time via `node:crypto.timingSafeEqual`

**Decision:** the admin middleware compares the presented Bearer token to the configured token using a UTF-8-buffer-based constant-time comparison (`Buffer.from(a, "utf8")` + `timingSafeEqual`). Length mismatch returns `false` after a dummy compare against itself (so the early-return path resembles the equal-length compare in runtime).

**Rationale:**
- Token comparison is a security-sensitive code path. `===` is fast-path optimized to compare prefix lengths first and return early on the first differing byte; an attacker measuring response timing across many requests can in principle leak the token byte-by-byte.
- `node:crypto.timingSafeEqual` is the standard Node solution. The buffer wrapping is needed because the underlying check operates on byte buffers; the UTF-8 encoding is unambiguous and matches how the tokens are transmitted.
- The length-mismatch case still has to short-circuit (timingSafeEqual throws on unequal lengths), but the dummy `timingSafeEqual(aBuf, aBuf)` keeps the runtime bounded by the longer buffer's length rather than by the shorter one. The leak is reduced to "is the token shorter or longer than the configured value", which is far less useful than per-byte content leak.

**Trade:** ~microsecond overhead per request on a path that already does I/O (the surrounding HTTP stack dwarfs it). Acceptable; correctness > perf.

### Phase 10.2: `joinedGroupCount` counts active members in non-soft-deleted groups only

**Decision:** the `joinedGroupCount` field counts `GroupMember` rows where `status === "active"` AND the parent group has `softDeletedAt: null`. Members in `left` / `kicked` / `invited` status do not count; soft-deleted groups do not contribute even if the user has an active row in them (the row is preserved on group soft-delete for audit history but the group is effectively gone for everything else).

**Rationale:**
- Matches the existing `Group.memberCount` precedent (set in Phase 1.2): the dashboard renders "this group has N members" using the same active-only rule, so the cross-game lookup uses the same definition.
- Matches the permission resolver's "non-active member = `source: none`" rule (Phase 3.5): a user in `kicked` status cannot exercise permissions, and "this user is in N games" should match the user's apparent reach in the system.
- A consumer that wants the lifecycle-history view can count `GroupMember` rows directly via a future endpoint or via Postgres directly; conflating the two views into a single field would be misleading on the dashboard's overview.

**Trade:** the answer to "how many groups was this user EVER in across this game" is not directly available from this endpoint. Acceptable: that's a different question (lifecycle history, not current footprint), and the audit log already carries `member.left` / `member.invited` events that reconstruct it.

### Phase 10.2: a `junjoUserId` with no `ExternalIdentity` rows returns 200 with `games: []`, not 404

**Decision:** when the supplied `junjoUserId` has no `ExternalIdentity` rows in any game, the route returns `200 OK` with `{ junjoUserId, games: [] }` rather than `404 not_found`. Same response shape for "user we have never seen" and "user known but no cross-game footprint yet".

**Rationale:**
- The two cases are indistinguishable from the consumer's perspective: both mean "this user has zero games to show". Forcing the consumer to handle two response shapes for the same observable answer is ergonomic friction without information value.
- Returning `404` would leak existence: an attacker who can hit the admin endpoint could enumerate `JunjoUser` ids by observing 200-vs-404 responses. Collapsing the cases removes that signal.
- Consistent with `members.listForUser` (Phase 2.6), which returns `[]` for an unknown external user id rather than `404`. Same rationale.

**Trade:** the consumer cannot distinguish "I queried the right id but the user isn't in any games" from "I queried a typo'd id that doesn't exist at all". Acceptable: the dashboard query path already validates ids out-of-band, and the admin endpoint isn't the right place to enforce id-shape validation.

### Phase 10.2: no SDK method for the cross-game endpoint

**Decision:** the per-game `@junjo/sdk` does NOT add a `junjo.users.listGames(...)` method or any other admin-shaped surface. The dashboard calls the endpoint directly via `fetch`.

**Rationale:**
- The per-game SDK shape is "one `Junjo` instance, one API key, one game". An admin-shaped method on this client would either ignore the configured per-game API key (confusing) or accept a separate `adminToken` argument (a different auth model awkwardly grafted onto a per-game client).
- VISION 10.2 explicitly says "SDK: skip for V1 (admin-only endpoint; not part of the public per-game SDK). The dashboard uses it directly via fetch."
- A dedicated `@junjo/admin-sdk` package would be over-engineering for a single endpoint. If the cross-game admin surface ever grows past two or three endpoints, a separate package becomes worth its weight; until then, hand-rolled `fetch` calls in the dashboard are the right shape.

**Trade:** dashboards copy the `Authorization: Bearer ${JUNJO_ADMIN_TOKEN}` boilerplate at every call site. Acceptable: there's only one call site today (the user-detail page; lands in Phase 11), and the docs page (`apps/docs/pages/api/admin.mdx`) shows the canonical pattern.

### Phase 10.2: cloud-only modules marked with `// @cloud-only` headers

**Decision:** new files added in Phase 10.2 (`packages/server/src/middleware/adminAuth.ts`, `packages/server/src/routes/admin.ts`) start with a `// @cloud-only` comment header. The header is not currently consumed by any build tool; it's a marker for a future self-host build flag that excludes admin-only modules.

**Rationale:**
- VISION Phase 10 explicitly calls for the marker: "Mark cloud-only modules with a `// @cloud-only` comment header so a future self-host build can exclude them via a build flag, but do not skip building or testing them in the loop."
- A header is the smallest possible signal that requires zero runtime cost and zero build-system change today. When the self-host build splits, a simple grep / AST visit can identify modules to drop.
- Keeping admin code in the same package as the OSS server (rather than a separate `@junjo/server-cloud`) avoids module-graph splits during V1 development; the marker is the easy split point for later.

**Trade:** the marker is informational only - a future maintainer could ignore it and the build would still work. Acceptable: the rule is documented in VISION, and the marker is a clear semaphore for code-review.


### Phase 11.1: Phase 11.1 splits into 11.1a (toolchain + auth + SDK singleton) and 11.1b (layout shell)

**Decision:** Phase 11.1 ("Tech stack + auth + layout shell") splits across two iterations. 11.1a (this iteration) ships the Tailwind toolchain, the HTTP Basic Auth middleware, the lazy SDK singleton, and the env validator. 11.1b ships the shadcn/ui CLI install, the sidebar layout shell, the four nav routes, and the light/dark toggle. PROGRESS.md is updated with the split.

**Rationale:**
- Phase 11.1 lists five concrete deliverables (Tailwind install, Tailwind config, Basic Auth middleware, layout shell, SDK singleton). One commit per iteration is a hard rule; bundling all five into one commit defeats the "smallest reviewable unit" goal.
- The natural seam: 11.1a is invisible scaffolding (no UI changes a human would notice; deps + auth + plumbing). 11.1b is where the visual surface lands. Splitting at the seam keeps each commit's blast radius small.
- Mirrors the established pattern from 5.1a/b/c (event hub split) and 7.5a/b/c (mutation primitive + per-list helpers).

**Trade:** the dashboard is half-functional after 11.1a (Basic Auth gate is up, Tailwind is wired, the SDK is callable from a Server Component, but there's no real UI). Acceptable: the placeholder home page renders, the dev can verify auth works against a local server, and 11.1b lands next iteration.

### Phase 11.1a: HTTP Basic Auth via Next.js middleware reading `DASHBOARD_ADMIN_USER` / `DASHBOARD_ADMIN_PASSWORD`

**Decision:** the dashboard is gated by HTTP Basic Auth, implemented in `apps/dashboard/middleware.ts`. The middleware reads `DASHBOARD_ADMIN_USER` and `DASHBOARD_ADMIN_PASSWORD` from `process.env` on every request. Either env var unset returns `401` with the explicit "credentials are not configured" message; bad credentials return `401`; valid credentials let the request through via `NextResponse.next()`. Credential comparison is constant-time via a hand-rolled XOR-OR loop over UTF-8-encoded byte arrays.

**Rationale:**
- VISION's Phase 11 architectural conventions are explicit: "HTTP Basic Auth via Next.js middleware reading `DASHBOARD_ADMIN_USER` / `DASHBOARD_ADMIN_PASSWORD` from env. Document in `apps/dashboard/README.md` that production deployments should put it behind Clerk / Auth0 / a corporate auth proxy."
- Reading env at request time (not at module load) means the credentials can rotate without restarting the dashboard; Next.js Edge runtime supports `process.env` access inside middleware.
- The hand-rolled constant-time compare mirrors the SDK's webhook signature verification (iter 031) and Phase 10.2's admin token comparison: Edge runtime has no `node:crypto.timingSafeEqual`, so all three sites use the same XOR-OR pattern.
- The "credentials not configured" failure mode is louder than a silent open dashboard (the security footgun that motivated Phase 10.2's admin-token-unset-means-disabled rule). Operators who forget the env vars hit a clear, actionable 401 message.

**Trade:** Basic Auth is plain-text-over-TLS, has no logout flow, and exposes the password in `Authorization` headers on every request. Acceptable for V1 because the dashboard is internal tooling; production deployments are documented as needing a stronger auth proxy in front. The README calls this out explicitly.

### Phase 11.1a: dashboard SDK singleton is lazy and `import "server-only"`-guarded

**Decision:** `apps/dashboard/lib/junjo.ts` exports `getJunjo()` which returns a module-cached `Junjo` instance, constructed on first call from `JUNJO_BASE_URL` + `JUNJO_ADMIN_API_KEY`. The module starts with `import "server-only"`. `getAdminToken()` returns the optional `JUNJO_ADMIN_TOKEN` for cross-game admin endpoints (Phase 10.2).

**Rationale:**
- Lazy construction avoids `next build`'s static-route discovery crashing on a deploy where one of the env vars is intentionally absent. The cost is one extra `if (cached) return cached` check per request, dwarfed by I/O.
- `import "server-only"` is a Next.js convention: the package's only job is to throw if a Client Component tries to import it. Without the guard, an accidental `"use client"` import would leak `JUNJO_ADMIN_API_KEY` (and any other secrets pulled in transitively) into the browser bundle. The guard is a 3-line module; the cost is one new dep.
- Two helper functions (`getAdminToken`, `getJunjoBaseUrl`) cover the cross-game admin endpoint path that VISION's Phase 11 spec calls out for hand-rolled `fetch` (since the per-game SDK does not expose the cross-game query).

**Trade:** the singleton is shared across all requests in the Node process. Mutations to the SDK instance (none in V1) would race; reads are safe. Acceptable: `Junjo` carries only configuration (no per-request state), and HTTP requests are issued through the platform fetch.

### Phase 11.1a: dashboard env validation via Zod, cached after first parse

**Decision:** `apps/dashboard/lib/env.ts` defines a Zod schema covering `JUNJO_BASE_URL` (defaults to `http://localhost:8787`), `JUNJO_ADMIN_API_KEY` (required, non-empty), and `JUNJO_ADMIN_TOKEN` (optional, non-empty when set). `loadDashboardEnv()` parses `process.env` on first call, caches the result, and rethrows with a flat issue-list message on failure. A `resetDashboardEnvCache()` test escape hatch is exported but not part of the public surface.

**Rationale:**
- Mirrors the server's `packages/server/src/env.ts` Zod loader. Same convention; same failure-mode shape; same lazy-validation rule (parse on demand, not at module load).
- Default value for `JUNJO_BASE_URL` matches the local dev case (the `@junjo/server` workspace runs on `8787`); the dev does nothing extra to wire the dashboard against a local server. Production deploys explicitly set the var to their cloud server's origin.
- `JUNJO_ADMIN_TOKEN` mirrors the server's optional treatment (Phase 10.2): unset is fine, the cross-game features just disappear from the UI.

**Trade:** caching means that after the first successful parse, `process.env` mutations are not re-read. Acceptable: in practice env vars do not mutate at runtime in Next.js deployments, and the test escape hatch covers the unit-test case.

### Phase 11.1a: Tailwind v3 with shadcn-style CSS variables, dark mode default

**Decision:** the dashboard uses Tailwind v3 (not v4) with the shadcn-canonical CSS-variable theme in `app/globals.css`. The `:root` block defines the light-mode HSL triplets; the `.dark` block overrides them. The root layout sets `<html lang="en" className="dark">` so dark mode is the default; light-mode toggle lands in 11.1b.

**Rationale:**
- shadcn/ui (which 11.1b will install) is built around Tailwind v3's CSS-variable theming convention. Tailwind v4's config differences would require deviating from shadcn's defaults, which means hand-porting every primitive copy-pasted from the shadcn registry.
- VISION's Phase 11 conventions explicitly call out shadcn/ui as the UI library; defaulting to Tailwind v3 keeps the upgrade path open. Tailwind v4 graduates only after shadcn migrates.
- Dark mode default matches VISION's "look-and-feel target: Vercel dashboard / Stripe dashboard / Linear admin" stance. Operators who want light mode toggle it explicitly.

**Trade:** Tailwind v4 ships meaningful perf wins. Acceptable: dashboard build perf is not a V1 bottleneck, and switching to v4 later is a contained migration (config file shape changes, but the CSS-variable theming shape is preserved).

### Phase 11.1b: shadcn primitives are hand-vendored, not installed via the shadcn CLI

**Decision:** `apps/dashboard/components/ui/` is populated by hand-writing the shadcn primitive code directly (canonical registry source) rather than running `npx shadcn@latest init` and `npx shadcn add ...`. Phase 11.1b ships only the primitives the layout shell + theme toggle actually need (`button.tsx`); future iterations add primitives to the same directory as features land that need them.

**Rationale:**
- The shadcn CLI is interactive; running it inside a non-interactive loop iteration would either get stuck on a prompt or require crafting a `components.json` ahead of time. Skipping the CLI removes one failure mode and keeps the iteration deterministic.
- shadcn explicitly markets itself as "copy-paste components"; the registry source is the contract, not the CLI. Vendoring the source byte-identical (with the proprietary license header prepended) preserves the shadcn upgrade path - a future iteration can `git diff` against the upstream registry to merge upstream fixes.
- Aligns with the iteration 057 stance ("shadcn-canonical CSS-variable theming") and VISION's "pull components into `components/ui/` as they're needed (don't bulk-install)" rule. Bulk-installing all 30+ shadcn primitives at once would inflate the surface area before any of them have a caller; hand-vendoring on demand keeps the directory honest.
- The `button.tsx` source is a verbatim copy of shadcn's published Button (including `cva` variants and `Slot` `asChild`); no behavior changes from the canonical version.

**Trade:** future maintainers cannot run `npx shadcn add input` and have the CLI know about the existing `components.json`. They have to copy-paste the source manually. Acceptable: copy-paste IS shadcn's intended workflow; the CLI is a convenience layer on top.

### Phase 11.1b: theme switching via `next-themes` with `defaultTheme: "dark"` + `enableSystem`

**Decision:** the root layout wraps `<body>` in a `ThemeProvider` (a thin client wrapper around `next-themes`) configured with `attribute="class"` (writes `class="dark"` or `class="light"` on `<html>`), `defaultTheme="dark"`, `enableSystem` (respects `prefers-color-scheme` when no localStorage value is present), and `disableTransitionOnChange` (prevents Tailwind's transition utilities from running during a theme flip). The hardcoded `className="dark"` from iteration 057's `<html>` element is removed; `next-themes` injects the class via an inline script before hydration.

**Rationale:**
- `next-themes` is the dominant React theme-switching library (~1.2M weekly downloads, written by the Next.js team). Hand-rolling localStorage + system-preference + SSR-safe class-injection logic is ~80 lines of subtle code; the dep is ~3 KB minified.
- `attribute="class"` matches Tailwind's `darkMode: "class"` config (set in `tailwind.config.ts` in iteration 057). Switching to a `data-theme` attribute would require also flipping Tailwind's config.
- `defaultTheme="dark"` matches VISION's "look-and-feel target" (Vercel / Stripe / Linear). `enableSystem` is the polite default - users who prefer light themes get them on first visit without action.
- `disableTransitionOnChange` is the standard recipe to avoid the "every element flashes" bug when the theme flips: Tailwind transitions interpolate background-color through hideous greys.
- `suppressHydrationWarning` on `<html>` (already in place from iteration 057) accommodates the className mismatch that next-themes' inline script intentionally creates between SSR HTML and hydrated DOM.

**Trade:** loading `next-themes` adds one more npm package and one more layer of indirection. Acceptable: the package is tiny, well-maintained, and saves us from owning a non-trivial cross-cutting concern.

### Phase 11.1b: layout shell uses a Next.js route group `(dashboard)`, not a wrapper component

**Decision:** every authenticated dashboard page lives under `apps/dashboard/app/(dashboard)/`. The route group's `layout.tsx` provides the sidebar + main-content shell; pages render their own `<Topbar>` so each can carry route-specific title + description text. The previous `apps/dashboard/app/page.tsx` was deleted; the new home is `app/(dashboard)/page.tsx`.

**Rationale:**
- Route groups are Next.js's idiomatic way to share a layout across a subset of routes without leaking into the URL. The path is still `/`, `/games`, `/audit`, etc. - the `(dashboard)` segment is a directory-only convention.
- This pattern leaves room for future non-dashboard routes (e.g., a future `/login` page that should NOT have the sidebar; or a `/share/[token]` public preview page). Wrapping every page in `<DashboardShell>{...}</DashboardShell>` would require manual opt-out at every site that doesn't want the shell.
- Per-page `<Topbar>` (rather than per-layout topbar reading metadata) keeps the title + description close to the page they describe and lets pages render route-specific actions in the topbar's `actions` slot. Matches the convention used by Stripe's dashboard and Linear's admin.

**Trade:** four nav-route stubs now exist as boilerplate placeholders that will be rewritten in 11.2-11.9 + 12.1-12.5. Acceptable: each stub is ~20 lines, the route exists so the sidebar links resolve correctly, and the active-route highlight in the sidebar is visible end-to-end from this iteration onward.

### Phase 11.1b: sidebar is hand-written, not the shadcn `<Sidebar>` composite

**Decision:** the sidebar lives in `components/dashboard/sidebar-nav.tsx` as two small components (`SidebarBrand`, `SidebarNav`), composed inline by the route-group layout. The shadcn registry's `<Sidebar>` primitive (a complex composite involving `<Sheet>`, collapsibles, mobile-drawer state, and ~600 lines of component code) is intentionally NOT vendored.

**Rationale:**
- The shadcn `<Sidebar>` is overkill for V1: it solves the mobile-drawer + collapsible-rail + nested-section problems, none of which the V1 dashboard surfaces today. The hand-written sidebar is ~50 lines of straightforward JSX.
- Mobile collapse is hidden behind `md:block` for now (sidebar disappears below md breakpoint; main content gets the full width). A future iteration can swap to the shadcn composite if mobile dashboard use becomes a real requirement; the swap is local to the layout.
- Active-route detection uses `usePathname` + a small `pathname.startsWith(...)` check. The home (`/`) special-cases exact match so it doesn't highlight on every route.

**Trade:** the dashboard is unusable on mobile (the sidebar is hidden, no replacement nav shows up). Acceptable: dashboard consumers are operators sitting at a desk; mobile parity isn't a V1 goal and the trade-off is documented in the roadmap.
