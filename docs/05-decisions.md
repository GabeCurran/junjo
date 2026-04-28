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

---

## Open questions

- Initial domain: `junjo.io` only, or also grab `junjo.gg` (gaming TLD) as redirect?
- npm org: try to claim `@junjo` first, fallback to `@junjo-dev` if taken
