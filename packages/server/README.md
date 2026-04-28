# @junjo/server

The Junjo HTTP API, SSE event stream, and webhook dispatcher. Hono on Node, Postgres via Prisma. Cloud and self-host run the same binary; configure with `DATABASE_URL` and an auth-adapter env var.

## Self-host

```
docker run -e DATABASE_URL=postgres://... -p 8787:8787 ghcr.io/junjo/server:latest
```

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
| `npm run prisma:format` | `prisma format` against `prisma/schema.prisma`. Also runs as part of the verify gate. |
| `npm run prisma:generate` | One-shot regenerate of the Prisma client. Normally unnecessary because `postinstall` handles it. |

The `postinstall` script runs `prisma generate` automatically after every `npm install` so the typechecker can find the generated client on a fresh clone.

### Environment variables

| Name | Required | Notes |
|------|----------|-------|
| `DATABASE_URL` | yes (runtime) | Postgres connection string used by the running server. |
| `TEST_DATABASE_URL` | yes (for DB-backed tests) | Postgres connection string used by Vitest tests that touch the database. Leave unset to skip those tests; non-DB tests still run. |
| `PORT` | no | HTTP listen port. Defaults to `8787`. Must be a positive integer. |
| `NODE_ENV` | no | One of `development`, `test`, `production`. Defaults to `development`. Controls the Prisma client globalThis cache (only enabled outside production). |
| `JUNJO_BASE_URL` | no | Public base URL of this server. Used when building links (e.g., invitation share URLs). Optional during local dev. |

`loadEnv()` in `src/env.ts` validates every variable above through a Zod schema; missing or malformed values throw a single readable error at startup.

## Running tests

Server tests use a real Postgres connection rather than mocking Prisma. We picked a `TEST_DATABASE_URL` env-var fixture over `testcontainers` so the test runner has no Docker dependency. See `docs/05-decisions.md` (2026-04-28: Server test fixture).

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

Tests that import from `src/testdb.ts` will throw a clear error if `TEST_DATABASE_URL` is unset. Tests that do not need the database (pure unit tests) keep running regardless.
