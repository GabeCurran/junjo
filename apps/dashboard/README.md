# @junjo/dashboard

Junjo cloud admin + analytics dashboard. Next.js 15 App Router. **Proprietary** (see `LICENSE`).

Not part of the OSS distribution. Self-hosters get the server + SDKs; the dashboard is cloud-only.

## Local dev

The simplest path is to run `npm run dev` from the repo root: it boots
Postgres, auto-generates `.env.local` here on first run, seeds the demo
dataset, and starts the dashboard alongside the server and docs site.
The dashboard then sits at http://localhost:3000 (basic-auth `admin` /
`admin`).

To run the dashboard alone (a separate Junjo server already up at
`JUNJO_BASE_URL`):

```sh
# from the repo root
npm install
# .env.local must exist with the variables below; the root `npm run dev`
# generates one for you, otherwise create it manually.
npm run dev -w @junjo/dashboard
```

## Required env vars

| Name | Required | Default | Notes |
| ---- | -------- | ------- | ----- |
| `JUNJO_BASE_URL` | optional | `http://localhost:8787` | Origin of the Junjo server. |
| `JUNJO_ADMIN_API_KEY` | required | - | Per-game API key the dashboard uses for SDK calls. Issue one with `npm run db:seed -w @junjo/server`. |
| `JUNJO_ADMIN_TOKEN` | optional | unset | The cross-game admin token. Required only for the cross-game user query; if unset, those views render an empty state. |
| `JUNJO_INVITE_BASE_URL` | optional | falls back to `JUNJO_BASE_URL` | URL prefix the invite-member dialog uses when constructing shareable invite links. The dashboard does not host the acceptance flow itself; set this to the origin of the dev's player-facing app that resolves `/invite/<code>`. |
| `JUNJO_DOCS_BASE_URL` | optional | unset | Base URL for the Junjo docs site. The analytics empty state deep-links operators at `<JUNJO_DOCS_BASE_URL>/tutorial`. When unset, the empty state still renders but omits the link (operators see a hint pointing at the tutorial path on their own docs deployment). |
| `DASHBOARD_ADMIN_USER` | required | - | HTTP Basic Auth username gating every dashboard route. |
| `DASHBOARD_ADMIN_PASSWORD` | required | - | HTTP Basic Auth password. |

If either `DASHBOARD_ADMIN_USER` or `DASHBOARD_ADMIN_PASSWORD` is unset, every request
returns `401` with the message "dashboard credentials are not configured".

If `JUNJO_ADMIN_API_KEY` is unset, the first Server Component that calls the SDK throws
"dashboard environment is misconfigured". The SDK singleton is lazily constructed so the
absence does not crash `next build` static-route discovery.

## Production deployment

The HTTP Basic Auth gate is intended as a V1 simplification for local + small-team use.
For real deployments, put the dashboard behind a stronger auth proxy (Clerk, Auth0,
Cloudflare Access, a corporate SSO gateway) and either disable the Basic Auth gate by
setting credentials your proxy injects, or layer them. The Basic Auth check runs in
Next.js middleware (`middleware.ts`); bypassing it requires modifying that file.

## End-to-end tests (Playwright)

V1 ships a small Playwright suite under `apps/dashboard/e2e/`. The bar is
"present and passing locally"; CI integration is deferred to a separate
workstream.

```sh
# from the repo root, one-time per machine:
npx playwright install chromium

# bring up Postgres + the Junjo server in one terminal:
npm run dev -w @junjo/server

# bring up the Junjo server admin token + a seeded admin API key, then run
# the suite (it boots `next dev` for you on port 13030):
JUNJO_BASE_URL=http://127.0.0.1:8787 \
  JUNJO_ADMIN_API_KEY=<seeded-key> \
  JUNJO_ADMIN_TOKEN=<admin-token> \
  DASHBOARD_ADMIN_USER=admin \
  DASHBOARD_ADMIN_PASSWORD=admin-e2e-password \
  npm run e2e -w @junjo/dashboard
```

Two specs ship today:

- `e2e/smoke.spec.ts` confirms each top-level dashboard route renders
  without a 5xx, has the correct `<title>`, and exposes the five-item
  sidebar nav. Also asserts the Basic Auth gate denies missing
  credentials. Runs without a Junjo server reachable.
- `e2e/happy-path.spec.ts` walks the canonical operator flow: create a
  game via the dashboard dialog, issue an API key (capturing the
  one-shot secret from the dialog), seed a group via direct
  `POST /v1/groups` against `JUNJO_BASE_URL` with that secret, then
  navigate back into the groups table and the group detail page. The
  spec auto-skips when the Junjo server at `JUNJO_BASE_URL` is not
  reachable.

The Playwright config lives at `apps/dashboard/playwright.config.ts`.
The `e2e/` directory is excluded from the dashboard's `tsc --noEmit`
typecheck because Playwright provides its own type-checking via the
`playwright test` runner; this keeps the production typecheck cycle
fast and free of test-only dependencies.

## Conventions

- License header on every TypeScript file:
  `// @license All Rights Reserved (see apps/dashboard/LICENSE)`
- Server Components by default; mark Client Components explicitly with `"use client"`.
- Data fetching happens in Server Components. Mutations go through Server Actions.
- The Junjo SDK singleton lives in `lib/junjo.ts` and is `import "server-only"`-guarded.
- Tailwind v3 with shadcn-style CSS variables in `app/globals.css`.
- Authenticated pages live in the `app/(dashboard)/` route group (Next.js route-group
  syntax: parentheses keep the segment out of the URL while sharing a layout).
- shadcn primitives are hand-vendored into `components/ui/` (one primitive per file)
  rather than installed via the shadcn CLI. Source matches the canonical registry
  byte-for-byte (with the proprietary license header prepended).
- Theme switching uses `next-themes`. The toggle in the topbar flips between dark and
  light via the `.dark` class on `<html>`.
