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
- 11.1b: sidebar + topbar layout shell, four nav-route stubs, light/dark theme
  toggle, hand-vendored shadcn `Button` primitive.
- 11.2a: cross-game admin endpoints (`GET /v1/admin/stats`, `GET /v1/admin/audit`).
- 11.2b (this iteration): home page consuming those endpoints. Four overview
  cards (games, groups, active members, audit events in 24h) + a recent activity
  feed (latest 20 audit entries across every game). Both panels stream via
  React `Suspense` and cache for 60s via Next.js `revalidate`. Renders an inline
  empty state when `JUNJO_ADMIN_TOKEN` is unset rather than crashing the route.
  Hand-vendored shadcn `Card` primitive ships alongside.
- 11.3a: cross-game games + API key management endpoints (`GET/POST /v1/admin/games`,
  game detail, `GET/POST /v1/admin/games/:gameId/api-keys`, key revoke).
- 11.3b-i: games list page consuming those endpoints. Server
  Component `<GamesList>` renders a five-column table (Name, Groups, Active
  members, API keys, Created) inside a `<Suspense>` boundary; `<CreateGameDialog>`
  in the topbar's `actions` slot wraps a `<form>` whose `action` prop is a
  `useFormState`-bound Server Action that validates via Zod, calls
  `createAdminGame`, and `revalidatePath`s the games list. Hand-vendored shadcn
  `Dialog`, `Input`, `Label` primitives ship alongside, plus
  `tailwindcss-animate` for the dialog's transition classes.
- 11.3b-ii (this iteration, closes Phase 11.3): game detail page at
  `(dashboard)/games/[gameId]/page.tsx`. Renders a header with the game's name
  and three stat tiles (groups, active members, active API keys), then an API
  keys section that lists every key (active + revoked) with a `Revoke` button
  per row. Issuing a new key opens a dialog whose Server Action returns the
  full `prefix.secret` form once; the dialog displays it in a copy-to-clipboard
  affordance with a destructive "store this now" warning. Revoke confirmation
  is a separate dialog. The page calls `notFound()` when the gameId is not
  resolvable, so the route returns Next.js's 404 page rather than a generic
  error card. Hand-vendored shadcn `Badge` primitive ships alongside.
- 11.4a: cross-game admin endpoint backing the group browser
  (`GET /v1/admin/games/:gameId/groups` with q + kind + visibility filters,
  createdAt / name / memberCount sort, offset pagination).
- 11.4b (closes Phase 11.4): groups page at
  `(dashboard)/games/[gameId]/groups/page.tsx`. Server Component parses
  `searchParams` into a typed `GroupsQueryState` (lenient: invalid values
  fall through to defaults rather than 400) and forwards it to
  `fetchAdminGroupsForGame`. The result is rendered by `<GroupsTable>`, a
  Client Component built on TanStack Table v8 with server-driven sorting,
  filtering, and pagination (the table is a presentation layer; URL state
  is the source of truth). Search input has a 350ms debounce, filter
  selects forward `kind` and `visibility` to the URL, sortable column
  headers cycle desc -> asc -> desc on the three server-supported fields,
  pagination has Previous / Next plus a page-size selector. Row click and
  the "Open" affordance navigate to `/games/[gameId]/groups/[groupId]`.
- 11.5a: cross-game admin endpoints backing the group detail page (the
  single-group fetch reuses `WireAdminGroup`; the members list at
  `GET /v1/admin/games/:gameId/groups/:groupId/members` with q +
  status filters, offset pagination, role chips populated).
- 11.5b: group detail page at
  `(dashboard)/games/[gameId]/groups/[groupId]/page.tsx`. Server
  Component renders `<GroupDetailHeader>` (group name + kind badge +
  visibility badge with lock / eye / eye-off icon + creation/updated
  timestamps + a single Active members stat tile) plus a Client
  Component `<MembersTable>` (TanStack Table v8 with server-driven
  sorting / filtering / pagination, role chips with colored dots, status
  Badge per row, public-note truncation with `title` tooltip, 350ms
  debounced search, status select with the four statuses + an `all`
  wildcard, page-size selector, Previous / Next pagination).
- 11.5c-i: cross-game admin row-action endpoints (kick member, PATCH
  for notes / metadata, set permission override, clear permission
  override, list permission overrides) under
  `/v1/admin/games/:gameId/groups/:groupId/members/:userId/...`.
- 11.5c-ii (this iteration, closes Phase 11.5c): MembersTable row
  actions wired to those endpoints. Each row carries four affordances
  (Notes, Override, Overrides, Kick), each opening its own modal:
  `<EditMemberNotesDialog>` (two textareas for public + private notes,
  empty input normalized to `null`), `<SetPermissionOverrideDialog>`
  (permission key input + grant / revoke radio cards),
  `<ViewPermissionOverridesDialog>` (fetches the override list on open
  via a Server Action, renders rows with permission key + grant /
  revoke badge + clear button per row, re-fetches after each clear),
  `<KickMemberDialog>` (destructive confirmation with optional reason
  textarea; idempotent on already-kicked / left). Server Actions live
  in `app/(dashboard)/games/[gameId]/groups/[groupId]/actions.ts`. The
  three form-driven dialogs use `useFormState` + `useFormStatus`; the
  view-overrides dialog calls plain-shape Server Actions from a
  `useEffect` on open and from per-row clear buttons. Hand-vendored
  shadcn `Textarea` primitive ships alongside.
- 11.5d, 11.6 - 11.9: invite-member tabbed dialog, roles + permissions
  + audit + relationships + sub-groups tabs, audit viewer, permission
  tester (one section per iteration).
- 12.1 - 12.5: Analytics surface (Tremor charts).
