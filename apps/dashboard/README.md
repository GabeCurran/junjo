# @junjo/dashboard

Junjo cloud admin + analytics dashboard. Next.js 15 App Router. **Proprietary** (see `LICENSE`).

Not part of the OSS distribution. Self-hosters get the server + SDKs; the dashboard is cloud-only.

## Local dev

```sh
# from the repo root
npm install
# create apps/dashboard/.env.local with the variables below
cd apps/dashboard
npm run dev
```

The dashboard expects a Junjo server running at `JUNJO_BASE_URL` (defaults to
`http://localhost:8787`). Bring one up with `npm run dev -w @junjo/server`.

## Required env vars

| Name | Required | Default | Notes |
| ---- | -------- | ------- | ----- |
| `JUNJO_BASE_URL` | optional | `http://localhost:8787` | Origin of the Junjo server. |
| `JUNJO_ADMIN_API_KEY` | required | - | Per-game API key the dashboard uses for SDK calls. Issue one with `npm run db:seed -w @junjo/server`. |
| `JUNJO_ADMIN_TOKEN` | optional | unset | The cross-game admin token (Phase 10.2). Required only for the cross-game user query; if unset, those views render an empty state. |
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
  rather than installed via the shadcn CLI. Vendor on demand: pull a primitive in the
  iteration that first needs it, not before. Source matches the canonical registry
  byte-for-byte (with the proprietary license header prepended).
- Theme switching uses `next-themes`. The toggle in the topbar flips between dark and
  light via the `.dark` class on `<html>`.

## What ships when

- 11.1a: Tailwind toolchain, HTTP Basic Auth middleware, SDK singleton.
- 11.1b (this iteration): sidebar + topbar layout shell, four nav-route stubs,
  light/dark theme toggle, hand-vendored shadcn `Button` primitive.
- 11.2 - 11.9: Home, games list, group browser, group detail tabs, audit viewer,
  permission tester (one section per iteration).
- 12.1 - 12.5: Analytics surface (Tremor charts).
