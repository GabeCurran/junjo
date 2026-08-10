# @junjo/server

The Junjo HTTP API, SSE event stream, and webhook dispatcher. Hono on Node, Postgres via Prisma. Cloud and self-host run the same binary; configure with `DATABASE_URL` and an auth-adapter env var.

## Self-host

There is no published registry image yet. Build one from the repo's root `Dockerfile` (its default `WORKSPACE=server` target is this server; the image applies pending migrations on boot):

```
docker build -t junjo-server .
docker run -e DATABASE_URL=postgres://... -p 8787:8787 junjo-server
```

The full walkthrough (compose recipe, env vars, key issuance, reverse proxy) lives at [docs.junjo.io/self-host](https://docs.junjo.io/self-host).

## Local dev

```
npm run dev
```

The Prisma schema lives at `prisma/schema.prisma`. Committed migrations live at `prisma/migrations/` and are applied by `npm run db:migrate` (production path) or recreated locally by `npm run db:migrate:dev` when the schema changes.

### Database scripts

| Script | What it does |
|--------|--------------|
| `npm run db:migrate` | Applies any pending committed migrations against `DATABASE_URL`. This is the production / deploy path; it never writes new migrations. |
| `npm run db:migrate:dev` | Compares the schema to the database, generates a new migration if needed, applies it, and regenerates the Prisma client. Use this whenever you edit `prisma/schema.prisma`. |
| `npm run db:reset` | Drops the schema, reapplies every committed migration, and skips seeding. Used by tests to start from a known-empty state. Destructive: do not point at a database with real data. |
| `npm run db:seed` | Creates one Game and one API key against `DATABASE_URL`, prints both to stdout. The full API key value is shown exactly once; it cannot be recovered later. Optional flag: `npm run db:seed -- --name "My Game"`. |
| `npm run prisma:format` | `prisma format` against `prisma/schema.prisma`. Also runs as part of the verify gate. |
| `npm run prisma:generate` | One-shot regenerate of the Prisma client. Normally unnecessary because `postinstall` handles it. |
| `npm run bench` | Runs the Vitest benchmark suite under `src/bench/`. Requires `BENCH_DATABASE_URL` (or `TEST_DATABASE_URL` as a fallback). Writes `bench-results/baseline.json` (gitignored). See "Performance benchmarks" below. |

The `postinstall` script runs `prisma generate` automatically after every `npm install` so the typechecker can find the generated client on a fresh clone.

### Environment variables

| Name | Required | Notes |
|------|----------|-------|
| `DATABASE_URL` | yes (runtime) | Postgres connection string used by the running server. |
| `TEST_DATABASE_URL` | yes (for DB-backed tests) | Postgres connection string used by Vitest tests that touch the database. Leave unset to skip those tests; non-DB tests still run. |
| `PORT` | no | HTTP listen port. Defaults to `8787`. Must be a positive integer. |
| `NODE_ENV` | no | One of `development`, `test`, `production`. Defaults to `development`. Controls the Prisma client globalThis cache (only enabled outside production). |
| `JUNJO_BASE_URL` | no | Public base URL of this deployment. Parsed and validated by `loadEnv()` but reserved: no server code path reads it today (the cloud dashboard consumes it). Unrelated to the SDK's `inviteBaseUrl`, which is client-side config for `inviteByLink`. Safe to leave unset. |
| `JUNJO_ADMIN_TOKEN` | no | Server-wide bearer token that gates the cross-game admin endpoints (`GET /v1/users/:junjoUserId/games`, see [`apps/docs/pages/api-reference/admin.mdx`](../../apps/docs/pages/api-reference/admin.mdx)). When unset the admin endpoints return `401 invalid_admin_token` for every request, which is the right default for self-hosters with one game per server. Cloud / dashboard deployments set this to a long random string. The token is compared in constant time. |
| `RATE_LIMIT_PER_MINUTE` | no | Sustained refill rate of the token-bucket rate limit on `/v1/*` routes. Every request drains a shared per-source bucket sized at 20x the per-key budget (so fleets and dashboards behind one egress fit, while one source cannot mint fresh budgets by rotating fabricated keys or headers); requests carrying a parseable API key also drain that key prefix's bucket before the scrypt verify cost. Defaults to `600`. Set to `0` to disable rate limiting entirely (useful for self-hosters running behind their own gateway). Must be a non-negative integer. |
| `TRUST_PROXY` | no | Set to `true` when a trusted proxy fronts the server and appends the client address to `x-forwarded-for` (Railway, nginx, any standard LB); the rate limiter then keys keyless traffic on the rightmost header hop, the one value clients cannot forge. Default `false` ignores the header entirely and uses the socket address, which is correct for direct exposure. Cloud deployments behind Railway must set this to `true`, or all keyless traffic shares the proxy's socket-address bucket. |
| `RATE_LIMIT_BURST` | no | Maximum bucket capacity for the per-API-key rate limit. Defaults to `100`: a saturated bucket lets up to 100 requests through back-to-back before the sustained rate caps further calls. Set to `0` to disable. Must be a non-negative integer. Both `RATE_LIMIT_PER_MINUTE` and `RATE_LIMIT_BURST` must be positive for rate limiting to be active; setting either to zero disables the middleware. |
| `LOG_LEVEL` | no | Minimum level emitted by the structured logger. One of `error`, `warn`, `info`, `debug`, `silent`. Defaults to `info`. `silent` suppresses every line; useful for tests and noisy CI runs. The runtime emits one JSON object per line on stdout when `NODE_ENV=production`; in any other environment lines are pretty-printed via `pino-pretty` for readability. |
| `WEBHOOK_ALLOW_PRIVATE_HOSTS` | no | When unset / `false`, `POST /v1/webhooks` and `PATCH /v1/webhooks/:id` reject URLs whose hostname is loopback (`localhost`, `127/8`, `::1`), link-local (`169.254/16`, `fe80::/10`, includes the AWS / GCP / Azure metadata endpoint), RFC1918 private (`10/8`, `172.16/12`, `192.168/16`), RFC6598 CGNAT, IPv6 ULA, or `0.0.0.0`. The check is lexical (no DNS resolution, so DNS rebinding still wins; the V1 backstop is operator network policy). Set to `true` or `1` ONLY for self-host development where receivers run on the same machine. |
| `JUNJO_MAX_PAGE_SIZE` | no | Upper bound on the `?limit=` query parameter for every list endpoint (`/v1/groups`, members, invitations, audit, friends, admin lists, etc.). Defaults to `100`, matching cloud's abuse-protection ceiling. Read at boot; the SDK and webhook delivery worker honor whatever the server accepts, so raising it is purely a server-side decision. Must be a positive integer. |
| `BENCH_DATABASE_URL` | no (for `npm run bench`) | Postgres connection string for `vitest bench`. Falls back to `TEST_DATABASE_URL` when unset. Bench runs seed ~10K groups, 100K members, 50K audit entries on first invocation (the seed is keyed by a marker game and skipped on subsequent runs); pointing this at a database you care about is destructive. |

`loadEnv()` in `src/env.ts` validates every variable above through a Zod schema; missing or malformed values throw a single readable error at startup.

## Running tests

Server tests use a real Postgres connection rather than mocking Prisma. We picked a `TEST_DATABASE_URL` env-var fixture over `testcontainers` so the test runner has no Docker dependency.

The simplest local setup is a Postgres container that you bring up once and reuse:

```
docker run --rm -d --name junjo-test-pg \
  -e POSTGRES_PASSWORD=junjo -e POSTGRES_DB=junjo_test \
  -p 5433:5432 postgres:16
export TEST_DATABASE_URL=postgres://postgres:junjo@localhost:5433/junjo_test
```

Any other Postgres instance works too. The schema is reset between test files; do not point this at a database you care about.

Run the test suite:

```
npm test --workspace @junjo/server
```

Tests that import from `src/testdb.ts` will throw a clear error if `TEST_DATABASE_URL` is unset. Tests that exercise the schema directly (currently `seed.test.ts`) use `describe.skipIf(!process.env.TEST_DATABASE_URL)` so they no-op cleanly when the env var is absent and run end-to-end against the migrated database when it is set. Tests that do not need the database (pure unit tests) keep running regardless.

### Seed helpers

`src/seed.ts` exports two helpers used by tests and the `db:seed` CLI:

- `createGame(name, prisma?)` inserts a `Game` row and returns it.
- `createApiKey(gameId, prisma?)` generates a fresh `prefix.secret` pair, stores the hashed secret, and returns `{ apiKey, raw }` so the caller can use the plaintext once before it disappears.

Both accept an optional `PrismaClient` (default: the singleton from `src/db.ts`) so tests can pass a client bound to `TEST_DATABASE_URL`.

## Performance benchmarks

Vitest's built-in `bench()` API powers the perf suite in `src/bench/*.bench.ts`. Bench files use the `.bench.ts` extension so they are invisible to `npm test` (which only matches `*.test.ts`) and run only via `npm run bench`.

```
export BENCH_DATABASE_URL=postgres://postgres:junjo@localhost:5433/junjo_bench
npm run bench --workspace @junjo/server
```

The first invocation seeds the database with the targets in `src/bench/setup.ts` (10K groups, 100K members, 50K audit entries). Seed time is dominated by `createMany` and runs in roughly 30-60 seconds on a local Postgres. Subsequent runs short-circuit when they detect the marker game (`__bench_marker_v1__`); the data is reused. Bumping any target invalidates the marker and forces a re-seed.

`--outputJson=bench-results/baseline.json` writes a structured result file under `packages/server/bench-results/` (gitignored). To compare a candidate run against the committed baseline:

```
npm run bench -- --compare=bench-results/baseline.json
```

Bench results are an order-of-magnitude reference, not a contractual SLO; rerun on your own hardware before comparing. The harness writes a JSON report under `bench-results/` that you can diff across runs.
