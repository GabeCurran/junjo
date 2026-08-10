# Contributing to Junjo

Thanks for taking the time to contribute. This file covers the workflow,
conventions, and expectations.

## Local setup

```sh
git clone https://github.com/GabeCurran/junjo
cd junjo
npm install
npm run dev
```

The first `npm run dev` boots a Postgres container, generates dev env
files, seeds a demo dataset, and starts the server, dashboard, and docs
site in parallel. See the root README for more.

## Verify gate

Before opening a PR, the same checks CI runs should pass locally:

```sh
npm run check       # biome lint + format
npm run check:style # forbid em-dashes / en-dashes / emoji
npm run typecheck   # tsc --noEmit across every workspace
npm test            # vitest across every workspace
```

The Postgres-backed integration tests under `packages/server/src/integration/`
auto-skip when `TEST_DATABASE_URL` is unset. To run them, point that env
var at the local container (the dev script already brings up):

```sh
export TEST_DATABASE_URL=postgres://postgres:junjo@localhost:5433/junjo_test
npm test
```

On Windows PowerShell:

```powershell
$env:TEST_DATABASE_URL = "postgres://postgres:junjo@localhost:5433/junjo_test"
npm test
```

**Warning: the dev database and the test database are the same database.**
`scripts/ensure-pg.mjs` writes an identical `DATABASE_URL` and
`TEST_DATABASE_URL` (both point at `junjo_test` on the dev container),
and the DB-backed server tests truncate every table in `beforeEach` (see
`packages/server/vitest.config.ts`). Running `npm test` while `npm run
dev` is up therefore wipes the seeded demo data and the demo API key out
from under the running server. Either stop the dev stack and reseed
afterward (`npm run dev` reseeds on its next boot), or point
`TEST_DATABASE_URL` at a separate throwaway database before running the
suite.

## Conventions

- **No em-dashes, en-dashes, or emoji** in source files. The
  `npm run check:style` script enforces this.
- **Biome** is the formatter and linter. Configuration lives at
  `biome.json`; do not introduce eslint or prettier alongside it.
- **TypeScript everywhere** in `packages/` and `apps/`. Prefer
  `unknown` over `any`; turn off lint rules per-line only with a clear
  reason in the comment.
- **Server Components by default** in `apps/dashboard`. Mark client
  components explicitly with `"use client"`.
- **Per-package LICENSE.** Anything new under `packages/` that should
  be MIT needs its own `LICENSE` file (copy from a sibling).

## Commits and PRs

- One logical change per commit. Subject in imperative mood
  (`feat: add ...`, `fix: ...`, `chore: ...`).
- The body explains *why* the change is needed; the diff explains
  *what* it does.
- Keep PRs focused. Refactors land separately from feature work.

## Where issues go

Bug reports and feature requests live in
[GitHub Issues](https://github.com/GabeCurran/junjo/issues). Use the
templates: bug reports need reproduction steps; feature proposals need
a use case.

Security vulnerabilities go to **gabecurran01@gmail.com**, not GitHub
Issues. See [SECURITY.md](./SECURITY.md).
