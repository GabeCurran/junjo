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

