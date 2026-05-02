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
| `JUNJO_INVITE_BASE_URL` | optional | falls back to `JUNJO_BASE_URL` | URL prefix the invite-member dialog uses when constructing shareable invite links (Phase 11.5d-ii). The dashboard does not host the acceptance flow itself; set this to the origin of the dev's player-facing app that resolves `/invite/<code>`. |
| `JUNJO_DOCS_BASE_URL` | optional | unset | Base URL for the Junjo docs site. The Phase 12.1 analytics empty state deep-links operators at `<JUNJO_DOCS_BASE_URL>/tutorial`. When unset, the empty state still renders but omits the link (operators see a hint pointing at the tutorial path on their own docs deployment). |
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
  `useActionState`-bound Server Action that validates via Zod, calls
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
  three form-driven dialogs use `useActionState` + `useFormStatus`; the
  view-overrides dialog calls plain-shape Server Actions from a
  `useEffect` on open and from per-row clear buttons. Hand-vendored
  shadcn `Textarea` primitive ships alongside.
- 11.5d-i: cross-game admin invitation endpoint
  (`POST /v1/admin/games/:gameId/groups/:groupId/invitations`) mirroring
  the per-game `POST /v1/groups/:id/invitations` body shape and audit /
  event semantics. Body `{ targetUserId?, roleId?, expiresIn? }` (all
  optional; `{}` produces an open-code invitation with no role and no
  expiry). Audit `payload.source = "admin"` distinguishes admin-issued
  invitations from per-game-key calls.
- 11.5d-ii (this iteration, closes Phase 11.5d): MembersTable invite-member
  dialog at the right end of the table toolbar. Three tabs - by user id
  (direct invitation; closes on success), by code (open invitation; shows
  the generated code with a copy-to-clipboard affordance), by link (open
  invitation; constructs `<JUNJO_INVITE_BASE_URL>/invite/<code>` and shows
  the URL with the same copy affordance). All three tabs call the same
  `inviteMemberAction` Server Action, which validates the form fields
  client-side, calls `createAdminGroupInvitation` from `lib/admin.ts`, and
  `revalidatePath`s the parent page on success.
- 11.6a-i: cross-game admin roles CRUD endpoints under
  `/v1/admin/games/:gameId/groups/:groupId/roles` and
  `/v1/admin/games/:gameId/roles/:roleId`. Mirrors per-game route
  semantics (audit shapes, idempotence rules, JunjoEvent dispatch).
- 11.6a-ii: cross-game admin role-permission grant / revoke endpoints
  plus the per-game permission catalog endpoint
  (`GET /v1/admin/games/:gameId/permissions`).
- 11.6b: group detail page grows tab navigation (URL-driven via
  `?tab=`; Members is the default, Roles is the new addition). The
  Members tab keeps its existing canonical URL so prior bookmarks
  still resolve. The Roles tab renders a hand-rolled HTML table
  sorted by priority desc with Name + Priority + Color swatch +
  Default badge + Permissions chips per row, each row carrying Edit
  and Delete affordances. Three new dialogs (`<CreateRoleDialog>`,
  `<EditRoleDialog>`, `<DeleteRoleDialog>`) consume three new Server
  Actions (`createRoleAction`, `updateRoleAction`, `deleteRoleAction`)
  in the existing route-scoped actions file.
- 11.6c (closes Phase 11.6): group detail page grows
  a third tab (Permissions) under the same `?tab=` navigation. The
  matrix renders roles as rows (priority desc) and registered
  permission keys as columns (sorted ascending) with a checkbox per
  cell; toggling a cell calls `grantRolePermissionAction` /
  `revokeRolePermissionAction` and optimistically flips local state
  for snappy UX. An inline "Register a new permission key" input adds
  transient columns locally; the first cell-grant on a local-only
  key persists it via the server's auto-register-on-first-grant rule
  and the next revalidation pulls it into the catalog. Empty states
  steer the operator to the Roles tab (no roles) or to the inline
  register input (no keys).
- 11.7a-i: cross-game admin audit endpoint
  (`GET /v1/admin/games/:gameId/groups/:groupId/audit`) shipped on
  the server. Mirrors the per-game `GET /v1/groups/:id/audit` route
  byte-for-byte (same query schema, same timestamp-based pagination,
  same `Page<WireAuditEntry>` response shape). Reuses
  `serializeAuditEntry` and `WireAuditEntry` from `routes/audit.ts`
  directly.
- 11.7a-ii: group detail page grows a fourth tab
  (Audit) under the same `?tab=` navigation. The Server Component
  reads namespaced `auditActions` / `auditBefore` / `auditLimit`
  query params (lenient parse; invalid values fall through to
  defaults), fetches via `fetchAdminGroupAudit`, and renders the
  `<AuditFeed>` Client Component. The feed shows action key in
  monospace, optional actor and target ids, relative timestamps via
  `Intl.RelativeTimeFormat` (with absolute time on hover), and a
  `<details>` payload preview. Toolbar carries a single-action
  filter dropdown over `ADMIN_AUDIT_ACTIONS` (23 entries plus an
  "All actions" wildcard) and a 25 / 50 / 100 page-size selector.
  Pagination is cursor-based: "Next" pushes the response's
  `nextCursor` as `auditBefore`; "Previous" calls `router.back()`
  because cursor-based pagination cannot run the inverse query of
  `createdAt < before`. A "Jump to newest" affordance clears the
  cursor when the operator is past the first page.
- 11.7b-i: cross-game admin relationships endpoints
  (`PUT/DELETE/GET /v1/admin/games/:gameId/groups/:a/relationships/:b`,
  `GET .../relationships`) shipped on the server. Mirror the per-game
  Phase 4.1 routes byte-for-byte (idempotence, audit shapes,
  `group.relationship.changed` JunjoEvent dispatch). Reuse
  `serializeGroupRelationship` + `WireGroupRelationship` from
  `routes/relationships.ts` directly.
- 11.7b-ii: group detail page grows a fifth tab (Relationships) under
  the same `?tab=` navigation. The Server Component fetches the
  outgoing directed links via `fetchAdminGroupRelationships` and
  renders the `<RelationshipsTable>` Client Component. Each row
  carries the other group id, type, and `since` timestamp. The
  header "Add relationship" button opens a `<SetRelationshipDialog>`
  that round-trips through a `useActionState`-bound
  `setRelationshipAction`; per-row "Edit" reuses the same dialog
  with the row's `groupBId` locked + `type` pre-filled (PUT
  semantics on the underlying endpoint cover both create-new and
  edit-type). Per-row "Clear" opens a destructive-confirmation
  dialog with an optional `mutual` checkbox so the operator can
  clear both directions in one shot; the dialog calls
  `clearRelationshipAction` imperatively from `onClick` (matches
  the iter-069 view-overrides precedent for plain async actions
  invoked outside a `<form>`).
- 11.7c-i: cross-game admin sub-group hierarchy endpoints
  (`PUT /v1/admin/games/:gameId/groups/:groupId/parent`,
  `GET .../children`) shipped on the server. Mirror the per-game
  Phase 4.2 routes byte-for-byte (idempotence on matching value,
  cycle detection bounded at depth 100, audit `group.parent.set` /
  `group.parent.cleared`, `group.updated` JunjoEvent dispatch on
  the changed direction).
- 11.7c-ii: group detail page grows a sixth tab (Sub-groups) under
  the same `?tab=` navigation, closing Phase 11.7. Server Component
  fetches the current group + direct children in parallel
  (`fetchAdminGroup` + `fetchAdminGroupChildren`) and renders the
  `<SubGroupsTable>` Client Component, which stacks two cards:
  parent-breadcrumb (showing the parent's id + Open link, or an
  empty state) and a hand-rolled children table (Name, Kind,
  Members, Created, Open + Remove actions). Three dialogs back the
  four operations: `<SetParentDialog>` (form-driven, `useActionState`,
  used for both Set parent and Edit parent), `<AddChildDialog>`
  (form-driven, same Server Action with `parentGroupId` fixed and
  `targetGroupId` user-supplied), and `<ClearParentDialog>`
  (destructive-confirmation, `useTransition`, used for both Clear
  parent and per-row Remove child). Both Server Actions
  (`setParentAction` form-driven, `clearParentAction` plain-async)
  call the same `setAdminGroupParent` wire helper; the clear path
  is just `setAdminGroupParent(target, { parentGroupId: null })`.
- 11.8a: cross-game admin per-game audit endpoint
  (`GET /v1/admin/games/:gameId/audit`) shipped on the server.
  Reuses the iter-059 `WireAdminAuditEntry` shape (gameId + gameName
  + groupId + groupName + groupSoftDeleted) wrapped in a paginated
  envelope (`nextCursor` for timestamp-based pagination). Includes
  soft-deleted-group entries (the audit log preserves history
  regardless of group lifecycle); each row carries `groupSoftDeleted`
  so the dashboard can mark them visually. Filters: `actions[]`,
  `actorUserId`, `targetId`, `since` (inclusive), `before` (exclusive).
- 11.8b (this iteration): game-wide audit log viewer at
  `app/(dashboard)/games/[gameId]/audit/page.tsx`, closing Phase
  11.8. Server Component lenient-parses URL state into a
  `GameAuditQueryState` and runs `Promise.all([fetchAdminGame,
  fetchAdminGameAudit])` in parallel; the game fetch hits the same
  60s revalidate cache the game detail page populates, so it is
  effectively free. Renders the new `<GameAuditFeed>` Client
  Component with five filter inputs (action select, actor / target
  text inputs with 350ms debounce, `<input type="datetime-local">`
  for the From / To date range), page-size selector, Previous /
  Next / Jump-to-newest pagination, and an "Export CSV" button.
  CSV export is per-page (operator sees what they get on screen);
  multi-page export deferred. The pagination cursor and the user's
  `endDate` filter are separate URL params (`cursor` and `end`);
  the wire request resolves to `before = cursor ?? endDate` so a
  paginated walk overrides the user's filter only while paging is
  active. Game detail page topbar grows an "Audit log" link next
  to "All games" so operators can find the new page.
- 11.9a-i: cross-game admin permission check endpoint
  (`GET /v1/admin/games/:gameId/permissions/check`) shipped on the
  server. Mirrors the per-game `GET /v1/permissions/check` byte-for-
  byte (same query shape, same `PermissionCheckResult` wire format,
  same resolution order, shared singleton `permissionCache`); reuses
  `resolvePermission` from `routes/permissions.ts` directly via the
  cloud-only boundary cross-import precedent.
- 11.9a-ii: permission check tester at
  `app/(dashboard)/games/[gameId]/permissions/check/page.tsx`. Form
  takes (userId, groupId, permission), runs the new
  `checkPermissionAction` Server Action against
  `fetchAdminPermissionCheck`, and renders a result panel with
  Allowed/Denied + source + viaRoleId badges plus a one-line plain-
  English explanation per the `PermissionSource` taxonomy ("Granted
  by role <id>", "Revoked by member-level override", "Active member
  with no role-derived grant and no override - permission denied by
  default", "Not a member of the group, or member is not in active
  status"). The form keeps the operator's last submitted values via
  `defaultValue` echoes from the Server Action's `inputs` field, so
  re-running with a tweaked permission key is one keystroke + Run.
  Discovery via a new "Permission check" link in the game detail
  page topbar (alongside "Audit log" + "All games"). The top-level
  `/permissions` placeholder updated to point operators at the per-
  game tester (since permissions are always game-scoped). Phase 11.9
  closes here.
- 12.1: analytics shell + Tremor setup. Installs
  `@tremor/react` 3.18 (which brings Recharts 2.x as a transitive
  dep) and adds Tremor's content path to `tailwind.config.ts` so
  Tailwind does not purge Tremor classnames in production. The
  analytics surface lives at
  `app/(dashboard)/games/[gameId]/analytics/page.tsx`: Server
  Component lenient-parses `?range=` (24h / 7d / 30d / 90d / custom)
  and forwards to a hand-rolled `<DateRangePicker>` Client Component
  that renders five styled labels wrapping native `<input
  type="radio">` elements (matches the iter-075 native-checkbox a11y
  precedent). Custom range exposes two `<input type="datetime-local">`
  fields plus an Apply button; URL pushes use `router.replace(...,
  { scroll: false })`. The top-level `/analytics` placeholder updates
  to a router pointing operators at the Games list (analytics is
  per-game). Game detail page topbar grows an "Analytics" link next
  to Permission check + Audit log. Two server-side resolvers
  (`resolveRangeFrom`, `resolveRangeTo`) ship in the page module ready
  for 12.2 - 12.5 to consume when individual charts land.
- 12.2a: cross-game admin group-churn analytics endpoint
  `GET /v1/admin/games/:gameId/analytics/group-churn?from=&to=` returns
  the binned tenure histogram of departures (kicked + left members)
  for groups created within `[from, to)`. Five wire-stable bins:
  `< 1h`, `1h - 1d`, `1d - 1w`, `1w - 1mo`, `1mo+`. Window applies to
  `Group.createdAt` per VISION's exact phrasing ("for groups created
  in the date range"); a today-old group with a year-old departure
  counts (cohort answer), but a year-old group with a today departure
  does not.
- 12.2b (this iteration): dashboard group churn chart consuming the
  12.2a endpoint. Wires Tremor's color tokens into Tailwind via
  `globals.css` CSS variables (mirroring shadcn's pattern: `--tremor-*`
  in `:root` for light, redefined in `.dark` for dark mode) plus the
  matching `tailwind.config.ts` color extensions and a Tremor-specific
  safelist (the chart's `colors={["blue"]}` prop computes Tailwind
  classnames at render time so `bg-blue-500`, `fill-blue-500` etc.
  must escape Tailwind's purge). New `<GroupChurnChart>` Client
  Component (`components/analytics/group-churn-chart.tsx`) renders a
  Tremor `<BarChart>` with five bars (one per bin) plus a three-tile
  summary header (window / groups in window / total departures). Empty
  states: a group has no matching cohort -> "no groups were created
  in this window"; cohort exists but no departures -> "no kicked or
  left members yet"; populated -> chart renders. New `lib/admin.ts`
  helpers (`fetchAdminGameGroupChurn`, `AdminGroupChurn`,
  `AdminGroupChurnBin`, `FetchAdminGroupChurnParams`) mirror the
  server's `WireAdminGroupChurn` shape byte-for-byte. The analytics
  page rewrites `<AnalyticsBody>` to fetch the game + churn in
  parallel via `Promise.all`, render the chart unconditionally, and
  fall back to the page-level `<AnalyticsEmptyState>` (with the
  tutorial deep-link) only when the operator has set
  `JUNJO_DOCS_BASE_URL` AND both `totalGroupsInWindow` and
  `totalDeparturesInWindow` are zero (early-onboarding case).
- 12.3a: cross-game admin group-growth analytics endpoint
  `GET /v1/admin/games/:gameId/analytics/group-growth?from=&to=&topN=`
  returns time-bucketed cumulative active member counts across the window
  for the top-N groups (default 5; bounded 1-10) plus an "All others"
  aggregated series when the game has more groups than `topN`. The
  bucket size is auto-picked from the window length (`<=1d` -> hourly,
  `<=7d` -> 6-hourly, `<=30d` -> daily, `<=90d` -> 3-day, longer ->
  weekly).
- 12.3b (this iteration): dashboard group growth chart consuming the
  12.3a endpoint. New `<GroupGrowthChart>` Client Component
  (`components/analytics/group-growth-chart.tsx`) renders a Tremor
  `<LineChart>` with one line per top-N group plus an "All others" line
  when the game has more groups than `topN`. The component pivots the
  server's per-series `data` arrays into per-bucket records the chart
  consumes, pre-formats bucket labels via `Intl.DateTimeFormat` (date
  only for daily-or-coarser buckets, date + time for hourly), assigns
  colors from an 11-entry palette in series order (Tremor pins line
  colors to category position), and uses `startEndOnly` for windows
  with more than 12 buckets so the x-axis stays readable. Three-tile
  summary header (window / cadence / series count). Empty states
  surface when the game has no groups (most common early-onboarding
  case) or the window produced no buckets. New `lib/admin.ts` helpers
  (`fetchAdminGameGroupGrowth`, `AdminGroupGrowth`,
  `AdminGroupGrowthSeries`, `FetchAdminGroupGrowthParams`) mirror the
  server's `WireAdminGroupGrowth` shape byte-for-byte. The analytics
  page extends `<AnalyticsBody>` to fetch growth alongside game + churn
  in a single `Promise.all`, render `<GroupGrowthChart>` directly below
  `<GroupChurnChart>`, and fold growth's `series.length === 0` into the
  three-way condition that gates the page-level
  `<AnalyticsEmptyState>` (so a brand-new game truly with no data still
  sees the tutorial deep-link).
- 12.4a: cross-game admin member-activity analytics endpoint
  `GET /v1/admin/games/:gameId/analytics/member-activity?from=&to=`
  returns a 7x24 grid of audit-entry counts pivoted by UTC day-of-week
  (0=Sunday) and hour-of-day (0-23). Aggregation runs at the Postgres
  layer via `$queryRaw` with `EXTRACT(DOW)` + `EXTRACT(HOUR)`; the
  response is bounded at 168 cells regardless of source data volume.
  Soft-deleted-group entries are included so prior activity stays
  visible after a group is removed.
- 12.4b (this iteration, closes Phase 12.4): dashboard member activity
  heatmap consuming the 12.4a endpoint. New `<MemberActivityHeatmap>`
  Client Component (`components/analytics/member-activity-heatmap.tsx`)
  renders a hand-rolled HTML `<table>` of 7 rows (days, Sun-first) x 24
  columns (hours, UTC) with each cell's background opacity scaling on
  the count / max ratio (sqrt-mapped to a [0.08, 1.0] range so
  low-count cells stay distinguishable from empty cells). Hard-coded
  blue-500 HSL keeps the heatmap visually paired with the other Tremor
  charts on the analytics surface. Three-tile summary header (window /
  total events / peak hour). Hover and screen-reader labels surface the
  exact day + hour + count via `title` and `aria-label`. A "less - more"
  legend with the cell-intensity ramp anchors the maximum value.
  Tremor doesn't ship a heatmap primitive (per VISION's "use Tremor
  only when a chart is needed" stance) so the component is built with
  Tailwind utility classes and inline `style.backgroundColor`. New
  `lib/admin.ts` helpers (`fetchAdminGameMemberActivity`,
  `AdminMemberActivity`, `FetchAdminMemberActivityParams`) mirror the
  server's `WireAdminMemberActivity` shape byte-for-byte. The analytics
  page extends `<AnalyticsBody>` to fetch member-activity alongside
  game + churn + growth in a single `Promise.all`, render
  `<MemberActivityHeatmap>` directly below `<GroupGrowthChart>`, and
  fold `memberActivity.totalEvents === 0` into the four-way condition
  that gates the page-level `<AnalyticsEmptyState>`.
- 12.5a: cross-game admin role-distribution + permission-usage analytics
  endpoints (server-side; no dashboard surface yet). Snapshot endpoints
  with no `from` / `to` query parameters; the dashboard's page-level
  date-range picker is irrelevant to the 12.5b charts.
- 12.5b: dashboard role distribution donut + permission usage horizontal
  bar chart consuming the 12.5a endpoints. Side-by-side layout per
  VISION's "Two charts side by side" framing. Closes Phase 12.
