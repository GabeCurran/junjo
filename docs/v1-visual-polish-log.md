# V1 visual polish log

Per-surface findings from the visual polish pass (`VISION.visual-review.md`). Each
surface gets a short entry: what was wrong, what was fixed, what is acceptable
as-is. Structural problems that need a meaningful rework are filed at the bottom
under "Structural issues to revisit later" and skipped for V1.

## V.1 system-architecture.mmd

**Before:** Three identical `verifyToken` labels stacked vertically at Hono's
right edge (one per auth-provider arrow). The labels overlapped and made the
entry into the auth subgraph hard to read.

**Fix:** Labelled only the first arrow (`hono -- verifyToken --> clerk`); the
other two (`hono --> supabase`, `hono --> jwt`) inherit the meaning from the
adjacent labelled arrow. One label, no stacking, semantics unchanged.

**Acceptable as-is:**

- Auth providers and outbound consumers subgraphs render at the top of the
  canvas (above the main left-to-right flow). This is a dagre layout side
  effect for side-branch subgraphs in an LR flowchart. The arrows are still
  legible and there are few crossings; reorganising would require restructuring
  the diagram, which is out of scope for visual polish.
- The three auth-provider boxes (Clerk, Supabase, JWT issuer) appear vertically
  stacked with the verifyToken arrows routing through them. Looks like a chain
  but is actually three separate edges from Hono. Acceptable because the
  context (subgraph titled "Auth providers (verify session tokens)") makes the
  parallel nature clear.

## V.2 permission-resolution.mmd

**Before:** The first message label read `GET /v1/permissions/check + Bearer
jk_...<br/>?userId, groupId, permission`. Two issues: the `+ Bearer jk_...`
notation concatenates a path and an auth header with a literal plus, which is
not how HTTP is written, and the line break put the query params on the second
line while the auth header sat awkwardly on the first.

**Fix:** Rewrote the label as `GET /v1/permissions/check?userId, groupId,
permission` on line 1 (HTTP-standard path + query string) and `Authorization:
Bearer jk_...` on line 2 (auth header with its proper header name). Same
information, conventional format. Both the `.mmd` source and the embedded
fence in `apps/docs/pages/api-reference/permissions.mdx` were updated to keep
them byte-identical for the sync gate.

**Acceptable as-is:**

- The diagram is dense vertically (30 numbered steps in deeply nested alt
  blocks). This is inherent to the protocol being sequence-diagrammed
  (auth -> group lookup -> cache check -> identity resolve -> membership ->
  override -> role -> default), not a layout problem. Each step is legible and
  the alt frames make the branching explicit, which is the point.
- The `Note over` block at the bottom renders dark gray with white text
  (mermaid neutral theme default for notes). Contrast is fine and the wrapped
  three-line content reads cleanly. Restyling would mean overriding the theme
  globally, which is out of scope for a single-surface polish.
- Step numbers (autonumber) sit on top of the arrow lines at the destination
  side. Standard mermaid behaviour and helpful for cross-referencing the steps
  from prose.

## V.3 webhook-delivery.mmd

**Before:** Two of the four DB-message labels were inconsistent with the
others. Step 3 read `WebhookEndpoint WHERE gameId AND disabledAt IS NULL /
AND (events IS EMPTY OR events contains type)` - no SELECT verb, so the
reader had to infer that this was a query (step 8 right next to it reads
`SELECT id FROM WebhookDelivery WHERE...`, parallel structure broken). Step
11 read `SELECT WebhookDelivery + WebhookEndpoint` - the `+` for join is
non-SQL shorthand that requires inference.

**Fix:** Added `SELECT` prefix to step 3
(`SELECT WebhookEndpoint WHERE...`) so it parallels step 8. Replaced `+`
with `JOIN` in step 11 (`SELECT WebhookDelivery JOIN WebhookEndpoint`). All
three byte-identical fences (`tools/diagrams/source/webhook-delivery.mmd`,
`apps/docs/pages/api-reference/webhooks.mdx`,
`apps/docs/pages/self-host.mdx`) updated together to keep the sync gate
satisfied.

**Acceptable as-is:**

- Step 7 (`Route-->>Route: respond to caller (HTTP 2xx)`) renders as a
  small self-loop that sticks slightly out of the Mutation route lane on
  the left. This is mermaid's default rendering for self-messages in
  sequenceDiagram; it is legible and the alternative (a separate "Caller"
  participant) would add a lane just to host one arrow. Out of scope for a
  visual polish iteration.
- Step 13's HMAC label wraps the five header names across two lines
  (`x-junjo-event, x-junjo-event-id,` then `x-junjo-delivery-id,
  x-junjo-timestamp, x-junjo-signature`). The break splits the three
  id-related headers across the wrap. Acceptable: any wrap point is
  somewhat arbitrary, and the current two-line layout fits within the
  format-is-junjo alt frame without overflowing.
- Step 16's `INSERT WebhookDelivery per endpoint` keeps the natural-language
  qualifier "per endpoint" rather than the more SQL-conventional
  `INSERT INTO ... (one row per endpoint)`. The terser form fits on one
  line within the BEGIN/COMMIT block and the multi-row semantics are clear
  from context (the alt frame is gated on "one or more endpoints
  matched").
- The two phases (Enqueue, Drain) render as labelled background bars at
  different vertical bands. Visually distinct, conveys the request-then-
  worker handoff cleanly.

## V.4 auth-flow.mmd

**Before:** Three DB SELECT labels were bare predicates without the
`SELECT` verb, while the same diagram's INSERT and UPDATE labels (steps
17, 22) carry their verb. Step 10 read `ApiKey by prefix` (natural-
language `by`, no verb). Step 14 read `ExternalIdentity (gameId,
externalUserId)` (bare table + key tuple). Step 20 read `ExternalIdentity
(gameId, externalUserId) re-select` (bare with an awkward natural-
language `re-select` qualifier). Same internal inconsistency that V.3
fixed in webhook-delivery.

**Fix:** Added `SELECT ... WHERE ...` form to all three. Step 10 is now
`SELECT ApiKey WHERE prefix`. Steps 14 and 20 both become `SELECT
ExternalIdentity WHERE gameId, externalUserId`; the duplicate label is
fine because the surrounding alt frames (`mapping exists` / `first
appearance` for step 14; `unique-constraint conflict P2002 (concurrent
winner committed)` plus the preceding `rollback inner tx` in step 19 for
step 20) make the second query's "re-query after conflict" semantics
obvious without an inline qualifier. Both fences (the `.mmd` source and
the embedded fence in `apps/docs/pages/auth/index.mdx`) updated together
to keep the sync gate satisfied.

**Acceptable as-is:**

- INSERT statements (steps 17, 22) use the truncated `INSERT <Table>`
  form rather than full SQL `INSERT INTO <Table> (...) VALUES (...)`.
  Same convention V.3 settled on for webhook-delivery; matches the
  brevity of sequence-diagram message labels.
- The two-row `BEGIN / INSERT / INSERT / COMMIT` block at step 17
  renders four lines stacked on a single message arrow. Mermaid handles
  the multi-line label cleanly; it is dense but legible and the
  transactional grouping is the point.
- Step 17's `[insert wins (no concurrent first-appearance)]` and step
  19's `[unique-constraint conflict P2002 (concurrent winner
  committed)]` alt-frame labels are long. They wrap once each within
  the inner alt frame and stay readable; a shorter form would lose the
  Prisma error code or the concurrency cause, both of which matter to
  the reader of an auth-flow diagram.
- The trailing `Note over App,DB` at the bottom (54 words explaining
  read-only-routes vs accept/decline lazy-create policy) wraps to four
  lines and crowds the bottom of the canvas. Acceptable: it captures a
  policy that is not visible in the swim-lanes themselves and is the
  single most important thing for a reader to take away from the
  diagram. Trimming would weaken the takeaway.
- Phase 1's alt-block on the SDK lane (steps 2-7) renders nested two
  levels deep (`alt no authAdapter configured` / `else authAdapter
  present` / `alt verifies` / `else missing, expired...`). Visual depth
  is real but each branch is short and the indentation makes the
  branching clear.

## V.5 dashboard home

**Before:** The Recent activity feed's game/group name span carried
the `truncate` Tailwind utility (`overflow: hidden; text-overflow:
ellipsis; white-space: nowrap`). On the 375px mobile viewport this
ellipsised entries to `Screenshot Demo / Storm R...` (Storm Riders
truncated by ~5 characters); the longer-name fixture row `Wolves of
Ironvale` truncated similarly when the parent flex-wrap container's
allocated width was tight. Desktop never tripped the truncate at
1440px because the activity card had ample horizontal room, so the
issue only surfaced once the mobile capture was inspected.

**Fix:** Dropped the `truncate` class from the span in
`apps/dashboard/components/dashboard/recent-activity-feed.tsx`. The
parent already uses `flex flex-wrap items-baseline gap-x-2`, so the
span now wraps to a new line on narrow widths instead of being
clipped. Full game and group names render in both viewports; desktop
layout is byte-identical (no truncate ever fired there).

**Acceptable as-is:**

- Every audit-feed timestamp reads the same relative time
  ("12 minutes ago" at first capture, "27 minutes ago" at re-capture).
  Fixture-induced: the seeder writes the rows rapid-fire so they all
  share a creation minute. Production deployments will have a
  staggered distribution. Not a polish issue.
- The activity row uses a single `ArrowRight` icon for every event
  type (`group.created`, `role.assigned`, `member.invited`,
  `member.joined`, `group.relationship.set`). A per-action icon set
  would improve scannability but is a structural change (icon map +
  fallback handling for unknown actions); filed below.
- Action verb and "in" connector are both `font-mono text-xs
  text-muted-foreground`. The font-mono makes the verb visually
  separable from the prose connector despite the shared muted color,
  and the `text-sm font-medium` game/group name draws the primary
  attention as intended. Hierarchy reads cleanly.
- `target <cuid>` second line of each row carries a 25-char CUID in
  `font-mono`. On mobile the line wraps after the centre dot so
  ` * 12 minutes ago` lands on its own line; the CUID itself stays
  intact (no `break-all`). Acceptable; copy-paste of the full target
  ID stays one selection.
- Stats cards stack four high on mobile (~120-140px each, ~520px
  total) before the activity feed even starts. Vertical density is
  typical for an overview page on a 375px viewport; the alternative
  (2x2 grid at sm breakpoint) would shrink the 4xl-font numbers
  awkwardly. Acceptable.
- Topbar `<h1>` is `text-sm font-semibold` rather than the more typical
  page-heading sizes. Intentional design (the topbar doubles as a
  breadcrumb on detail pages); leaving as-is for V.5 polish.
- The desktop capture has roughly 200-300px of empty space below the
  activity card. `<main className="flex-1 px-6 py-8">` fills viewport
  height; with content shorter than the viewport, the trailing dark
  area is the unfilled flex-1 region. Layout intent, not a bug.

## V.6 games list

**Before:** Mobile (375px) was visually broken in two ways. The
`Topbar` had a fixed `h-14` (56px) with `items-center justify-between`,
so when the page-level description ("Every game registered on this
Junjo deployment.") wrapped to two lines on a narrow viewport, the
title block overflowed the 56px header height while the right-aligned
`Create game` button stayed centred at the original height - the
button visually overlapped the wrapped subtitle text. Separately, the
games table is six columns (Name + CUID, Groups, Active members, API
keys, Created, Open). At 375px viewport the CUID column alone needs
~250px (25-char `font-mono text-xs` string with no wrap), pushing the
remaining columns past the right edge of `overflow-x-auto`. The
captured PNG showed only the Name column with the CUID truncated
mid-character and every other column off-screen.

**Fix:** Two scoped edits, one shared component and one page-local.

`apps/dashboard/components/dashboard/topbar.tsx` now uses
`flex min-h-14 flex-col gap-2 ... py-3 sm:flex-row sm:items-center
sm:justify-between sm:gap-4 sm:py-0`. The header is a column on
mobile (title block on top, actions row underneath) and the original
single-row layout from the `sm:` breakpoint up. `min-h-14` preserves
the 56px desktop height (no visual change) while letting mobile grow
to fit the title + description + actions stack. The title block also
gets `min-w-0` and the actions row gets `flex-shrink-0` so future
long titles wrap into the title block instead of pushing the button
off-screen.

`apps/dashboard/components/dashboard/games-list.tsx` was made
responsive on a per-column basis: the inline CUID span is now
`hidden sm:inline` (gone on mobile, present from sm: up); the Groups
column is `hidden sm:table-cell`; the API keys and Created columns
are `hidden md:table-cell`; the Active members header reads
`Members` on mobile (sm:hidden span) and `Active members` from sm: up
(hidden sm:inline span). Final mobile layout is a tight three-column
table - Name, Members, Open - with no horizontal scroll. Desktop
layout is byte-identical (all six columns with full headers).

**Acceptable as-is:**

- "Screenshot Demo" wraps to two lines (`Screenshot` / `Demo`) on
  mobile because the Name column allocates just under 168px. The
  wrap is on the word boundary and both lines remain at
  `text-sm font-medium`. Forcing nowrap or further shrinking the
  Members column would either truncate longer game names or make
  the numeric value look cramped against the Open arrow. Acceptable
  trade-off for two-word names; longer names (e.g., 4-word) would
  wrap to three lines, which is still readable.
- Active members header reads "Members" on mobile rather than the
  full "Active members". Verb-stripped form fits in one line at the
  narrow column width and is unambiguous in context (the next
  column is the count). Desktop retains the full descriptor.
- The `+ Create game` button on mobile sits under the description
  rather than to the right of it, which is the natural consequence
  of the `flex-col` topbar on mobile. Adds one row of vertical
  height to the topbar but the button is still tap-targetable
  without competing with the title text.
- Sidebar is collapsed on mobile (the global sidebar layout owns
  this); only the hamburger trigger and the Junjo wordmark remain
  in the top strip. Untouched by this iteration.
- Five rows of CUID/numeric data on a card with ~700-800px of empty
  vertical real estate below it is the same `flex-1 px-6 py-8`
  layout intent flagged in V.5. Not a polish bug.

## V.7 game detail

**Before:** Mobile (375px) had three layered overflow problems on the API
keys panel. (1) The card header used `flex-row items-start justify-between`
unconditionally, so the `Issue key` button stayed pinned to the right and
squeezed the description ("Server-side keys for SDK calls. The full secret
is shown exactly once on issuance.") into a six-line stack on the left. (2)
The keys table was five columns (Prefix, Created, Revoked, Status, Revoke
action); on a 375px viewport only Prefix and Created fit visually inside
the `overflow-x-auto` wrapper. (3) Even after hiding the low-priority
columns, the default `size="sm"` Revoke button (`h-9 px-3`) plus the card's
`p-6` (24px each side) and the page's `px-6` left ~290px for the row, which
was ~10px short of fitting `prefix + Active badge + Revoke text` on a
375px viewport. The iter-7/iter-8 attempts saw this and started
spiralling on padding/font-size tweaks; iter-9 ships a focused four-cycle
fix.

**Fix:** Three scoped edits, all in
`apps/dashboard/components/dashboard/`.

`api-keys-section.tsx`:
- `SectionShell` `CardHeader` is now
  `flex-col gap-3 space-y-0 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-0 sm:p-6`,
  matching the V.5/V.6 mobile-stack pattern (title block on top, action
  button below; from `sm:` up the original single-row layout). The
  description block carries `min-w-0` and the action wrapper carries
  `flex-shrink-0` so a long title would wrap rather than push the button
  off-screen.
- `CardContent` adds `p-4 pt-0 sm:p-6 sm:pt-0` so mobile cards reclaim
  ~16px of horizontal real estate that desktop keeps.
- `ApiKeyRow` hides the `Created` column on mobile
  (`hidden sm:table-cell`) and the `Revoked` column on mobile + sm
  (`hidden md:table-cell`); the matching `<th>` cells get the same
  visibility classes. The `Status` badge stays visible at every
  viewport because it carries the revoked/active distinction implicitly
  for screen-reader users and visibly for everyone else. Prefix font
  drops to `text-xs sm:text-sm` on mobile so 16-character prefixes fit.

`revoke-api-key-dialog.tsx`:
- `DialogTrigger` button gets
  `className="h-8 px-2 text-xs sm:h-9 sm:px-3 sm:text-sm"`, shrinking
  the trigger by ~16px horizontally on mobile while leaving desktop
  byte-identical.

After the four-cycle render-Read loop (broken stale-server state ->
column hide + header stack -> card padding shrink -> Revoke trigger
shrink), all of `Prefix | Active | Revoke` now fit cleanly inside the
375px card with no horizontal scroll.

**Acceptable as-is:**

- The Next.js dev-tool floating widget overlaps the description
  ("issuance" -> "suance") in mobile captures. This is a `next dev`
  artifact (the indicator is suppressed in production builds via
  `devIndicators: false` and is not present in the actual user-facing
  app); polish-log convention here matches V.5/V.6 which also caught
  the floating `N` widget with no remediation.
- The card description still wraps to three lines on mobile
  ("Server-side keys for SDK calls. The full / secret is shown exactly
  once on / issuance."). The break is on word boundaries and conveys
  the warning cleanly; trimming the prose would lose the "shown
  exactly once" hint that operators need to see before clicking
  Issue.
- The Revoke button on mobile uses `text-xs h-8 px-2` so the touch
  target is ~32px tall. This is below the 44px Apple/Google touch
  guideline. Acceptable trade-off because (a) the button is rarely
  used (revocation is a destructive infrequent action), (b) the
  alternative (icon-only with no text) loses scannability, and (c)
  desktop retains the full `sm` size. Could be revisited if a11y
  audit (separate pass) flags it.
- Stat tiles stack vertically on mobile (~110-130px each, ~360px
  total). Same vertical-density observation as V.5; appropriate for
  a 375px viewport.
- Game-name CUID (`cmoq5pkqx00o7sc4q997icskc`, 24 chars) renders on a
  single line in `font-mono text-xs` on mobile and fits within the
  available width. No `break-all` was added preemptively; if a longer
  CUID appears in production it would wrap but the current layout
  reserves the space.
- `Active` badge text wraps onto a second line of the row on mobile
  in some captures (the inline-flex badge container is ~58px tall
  total). Acceptable density at this viewport.
- The desktop `Created`-formatted dates render as `May 3, 2026`
  while the table header reads `CREATED`. Date-only granularity is
  the right call here (issuance dates rarely need minute precision
  in a list view); the audit log surface gets the timestamp form.
- Five rows of API key data on a card with ~700-800px of empty
  vertical real estate below it on desktop is the same `flex-1
  px-6 py-8` layout intent flagged in V.5. Not a polish bug.

## V.8b admin-shared client/server split

**Before:** Every group-detail surface (`group-members`, `group-roles`,
`group-permissions`, `group-audit`, `group-relationships`,
`group-sub-groups`) plus the game-wide audit, permission-check tester,
and analytics surfaces failed to compile with "you're importing a
component that needs server-only" because 22 `"use client"` components
imported wire-shape types and ADMIN_* constants from
`apps/dashboard/lib/admin.ts`, which begins with `import "server-only";`
and (via `./junjo`) drags the SDK + env loader into the client bundle.
The dashboard `next dev` build error rendered as a giant red overlay
on every affected route, blocking the visual polish PNG capture.

**Fix:** Carved every runtime-free declaration (interfaces, type
aliases, constants) out of `lib/admin.ts` into a new
`apps/dashboard/lib/admin-shared.ts` (no `import "server-only"`, no
imports from `./junjo`). `lib/admin.ts` re-exports the relocated
names via `export * from "./admin-shared"` so server-side callers
keep importing from `./admin` unchanged; the function definitions
(adminFetch / adminMutate / adminDelete plus every
fetchAdmin* / createAdmin* / etc. helper) and the
`AdminDisabledError` sentinel class stay where they are. The 22
`"use client"` components in `apps/dashboard/components/dashboard/`
and `apps/dashboard/components/analytics/` flipped their imports
from `"../../lib/admin"` to `"../../lib/admin-shared"`. Dashboard
typecheck + biome + verify all green; group-members renders cleanly
on desktop and mobile.

**Acceptable as-is:**

- The split lives under two filenames (`lib/admin.ts` +
  `lib/admin-shared.ts`) rather than collapsing the runtime
  helpers into a third name (e.g., `lib/admin-server.ts`). Keeping
  the existing import path stable for every server-side caller was
  the priority; renaming the runtime module would touch every page +
  Server Action + server-only component for no functional benefit.
- The polish of `group-members` itself (V.9) is a separate
  iteration. This one only restored the ability to render group
  detail surfaces; the per-surface visual review begins next iteration.
- Mobile capture of `group-members` already shows the "Sub-groups"
  tab label clipping at the right edge of the viewport. Filed as
  V.9 follow-up territory; not fixed here because V.8b is the
  structural unblock, not the V.9 polish.

## V.9 group detail - members tab

**Before:** Two desktop-side wraps in the Members table. The Joined
column rendered "May 3, 2026" across two lines because the cell text
inherited the default `white-space: normal` and the column was just
wide enough to break after the comma. The PUBLIC NOTE column header
also wrapped (intentionally; "Public note" doesn't fit otherwise). On
the action column, four buttons (Notes / Override / Overrides / Kick)
spilled onto two rows because the `flex flex-wrap` container had no
hint to keep them inline; this read as accidental rather than designed.

**Fix:** Added `whitespace-nowrap` to the Joined date cell so the
formatted date stays on one line at the column's natural width. Tried
flipping the actions container to `flex-nowrap whitespace-nowrap` to
match; the four buttons then overflowed past the right edge of the
viewport (clipping "Overrides" and "Kick"). Reverted that change -
the wrap is the lesser evil because all four actions remain visible
and aligned. Net change: one cell gets nowrap, action buttons stay
flex-wrap.

**Acceptable as-is:**

- Action buttons rendered on two rows (Notes / Override on top,
  Overrides / Kick beneath). With `flex-wrap`, the content stays
  inside the column. With `flex-nowrap`, the content overflows the
  card. Two rows beats clipping. A future fix would be icon-only
  buttons or a row-action dropdown; both are component reshapes,
  not CSS fixes, so they belong below.
- "PUBLIC NOTE" column header wrapping to two lines. The label is
  literally "Public note"; uppercasing it via the table style adds
  enough width that it has to break. Acceptable because the wrap is
  in the header (not the data) and the values for the demo dataset
  are all "-".

## V.10 group detail - roles tab

**Before:** On the 375px mobile viewport the Roles card header used
`flex flex-row items-start justify-between gap-4` unconditionally, so
the "+ Add role" button held the right side of the row and squeezed
the title block ("Roles" + the description "Roles defined for this
group, ordered by priority (highest first). Higher priority wins
tiebreaks when a member has multiple roles. 3 roles total.") into a
~50%-width column that wrapped the description across eight short
lines. Same shape as the V.7 API-keys header that was already fixed.

**Fix:** Swapped the `CardHeader` className to
`flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:space-y-1.5`,
mirroring the V.7 `api-keys-section.tsx` pattern (mobile stacks
title-block over button; from `sm:` up the original single-row layout
returns). One CSS edit, no behavior change. Description now spans the
full card width on mobile (5 wrapped lines instead of 8) and the
"+ Add role" button stretches full-width directly underneath. Desktop
rendering is byte-identical to before.

**Acceptable as-is:**

- The roles table on mobile only shows Name and a truncated
  "PRIORIT" header column; Color, Default, Permissions, and the
  Edit/Delete actions are clipped to the right inside the
  `overflow-x-auto` wrapper. Same shape as the V.9 follow-up filed
  for the members table - collapse-to-card on mobile is a structural
  reshape, not a CSS fix. Already covered by the V.9 follow-up entry
  below ("Members table mobile clipping" applies equally to V.10-V.14
  per its own note).
- The "Sub-groups" tab label wraps to two lines ("Sub-/groups") on
  mobile because the six tab labels share the row at 375px. Same
  observation as V.9 (filed under structural section already); the
  full row of tabs is the structural shape, not a single label fix.
- ~500px of empty vertical space below the roles card on mobile.
  Same `flex-1 px-6 py-8` layout intent flagged in V.5/V.6/V.7. Not a
  polish bug.
- Desktop description ("Higher priority wins tiebreaks when a member
  has multiple roles. 3 roles total.") wraps onto a second line at
  1440px because the action column reserves ~150px for the "+ Add
  role" button. Two lines is fine; the alternative would be a
  shorter description that loses the tiebreak rule.

## V.11 group detail - permissions tab

**Before:** Rendered desktop and mobile after the V.8b admin-shared
unblock. Desktop (1440px) shows the Permissions matrix card cleanly:
title + description, the "Register a new permission key" input plus
"+ Add column" button on a single inline row, and a 4-column table
(ROLE + 3 keys: group.bank.withdraw, group.invite, group.kick) with
3 role rows (officer / veteran / recruit) showing the brand-red
checked state on grants and empty-square on revokes. Hierarchy reads
clean, contrast is fine, no overlap, no cropping.

Mobile (375px) shows two of the responsive patterns the earlier
surfaces already established working correctly here without any
edit needed: the input + "+ Add column" stack vertically (the
button is full-width below the input) and the explanatory blurbs
wrap on word boundaries within the card width.

**Fix:** None applied. Per protocol 17a step 2 (surface acceptable
-> mark done, write short log, commit, exit) the visible state on
both viewports is acceptable for V1 polish; the only mobile-side
issue is the matrix-table horizontal clipping, which is already
covered by the existing "Members table mobile clipping" structural
follow-up (per its own note, the entry applies to V.10-V.14
sharing the same DataTable shell, and the permissions matrix is
the same shape). Adding nothing new to the structural list.

**Acceptable as-is:**

- Permissions-matrix table on mobile clips after the ROLE column
  and a partial first key column header ("grou..." for
  `group.bank.withdraw`); the other two key columns are off-screen
  inside `overflow-x-auto`. Same DataTable + overflow-x-auto shape
  as members and roles tables; covered by the V.9 structural
  follow-up which explicitly extends to V.10-V.14.
- "Sub-groups" tab label wraps to two lines on mobile because the
  six tabs share the row at 375px. Same observation as V.9 / V.10;
  the tabs row is the structural shape, not a single label fix.
- Description "...3 roles x 3 keys." uses a literal `x` rather
  than `x` (U+00D7) for the dimensions. ASCII keeps the
  no-em/en-dash lint happy and matches the rest of the dashboard's
  ASCII-only copy convention; the typographic multiplication sign
  is not worth a special-case here.
- The bottom of the matrix card sits ~600px above the bottom of
  the viewport on desktop. Same `flex-1 px-6 py-8` layout intent
  flagged in V.5 / V.6 / V.7 / V.10. Not a polish bug.
- Mobile capture's group header stacks "Wolves of Ironvale" +
  `guild` badge + `invite-only` badge across multiple rows. Word
  wrap is on token boundaries and stays readable; no fix needed.

## Structural issues to revisit later

- **Per-action icons in the recent-activity feed.** Today every row
  uses `ArrowRight` regardless of action. A small map (`group.*` ->
  `Users`, `role.*` -> `ShieldCheck`, `member.*` -> `UserPlus`,
  default -> `ArrowRight`) would let the eye scan event types at a
  glance. Out of scope for visual polish; the row is functional and
  legible without it.

- **Members table mobile clipping (V.9 follow-up).** At the 375px
  mobile viewport the table renders only the User and Status columns;
  Roles, Public note, Joined, and the action buttons are clipped to
  the right with no horizontal scroll affordance shown in the
  capture. The wrapper is `overflow-x-auto` and does scroll on a
  touch device, but visually nothing hints that there is more to
  see, and four row-action buttons are unusable inside a 375px
  card. Real fix: collapse the row into a tap-to-expand member card
  on mobile (per-row dropdown with the four actions, plus the
  per-member metadata stacked vertically). That is a component
  reshape, not a CSS tweak, and matches the structural posture
  already taken for the recent-activity feed icons. Filed here so
  the next pass picks it up alongside the same issue on the other
  group-detail tabs (V.10-V.14).
