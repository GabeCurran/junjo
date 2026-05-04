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

## V.12 group detail - audit tab

**Before:** Mobile (375px) audit feed overflowed horizontally because each
row's actor/target line concatenated long monospace CUIDs (~25 chars each)
with no break opportunity. The `<p className="mt-0.5 text-xs ...">` had
default `overflow-wrap: normal`, so the unbreakable mono tokens pushed the
row past the card width and ultimately past the page width. Captured PNG
came in at 1296px wide on a 375px viewport target.

**Fix:** Added `break-all` to the actor/target paragraph in
`apps/dashboard/components/dashboard/audit-feed.tsx`. Long mono CUIDs now
wrap mid-token within the row's content column instead of overflowing.
Desktop is byte-identical (the prose words "actor" / "target" / "system"
plus the raised dot separator never approach the line width at 1440px, so
break-all is functionally inert there).

**Acceptable as-is:**

- Captured mobile PNG is still 1296px wide because the
  `GroupDetailTabs` strip (`flex items-center gap-1`, no wrap or
  horizontal-scroll affordance) renders six tabs at ~95px each and forces
  the page wider than 375px. Same root cause behind every group-detail
  surface's mobile capture coming in at >= 1296px (V.9-V.11 each filed
  this under `## Structural issues to revisit later`). Newly added as the
  separate `V.14b` follow-up below since the fix touches a single shared
  component and benefits V.9-V.14 together.
- Audit-row wrapping breaks IDs at arbitrary positions (e.g., a CUID may
  break mid-token after ~14 chars on mobile). Acceptable: copy-paste of
  the visible string still yields the full ID (browsers reassemble the
  text-node content), and the alternative (`break-words`) does not break
  CUIDs because they have no internal break opportunity.
- "Filter by action" + "Rows / page-size" controls stack vertically on
  mobile via the existing `flex flex-col sm:flex-row` toolbar; no edits
  needed. Pagination footer (`Showing the newest page` + Previous/Next)
  also stacks correctly.
- Every audit row's payload `<details>` is collapsed by default, so the
  `<pre>` block's potential horizontal overflow never triggers in the
  default screenshot. If an operator expands a payload on mobile, the
  inner `<pre>` already carries `overflow-x-auto` so it scrolls inside
  the row rather than pushing the page wider.
- Six action types are visible across the demo dataset (group.parent.set,
  group.relationship.set, role.assigned, member.joined, member.invited,
  permission.granted, role.created, group.created). Hierarchy reads
  cleanly with the icon-circle + mono action label + relative timestamp
  pattern consistent with `recent-activity-feed`.

## V.13 group detail - relationships tab

**Before:** Mobile (375px) `RelationshipsTable` card header used
`flex flex-row items-start justify-between gap-4`, which forced the
"Relationships" title + descriptive paragraph into a narrow left column
beside the "Add relationship" button. The description was crushed to a
~12-character-wide column with most lines holding one or two words, and
the action button hung off the right edge of the visible card area.

**Fix:** Mirrored the V.7 / V.10 mobile-stack pattern - changed the
`CardHeader` to
`flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:space-y-1.5`
in `apps/dashboard/components/dashboard/relationships-table.tsx`. The
title + description now span the full card width on mobile and the
"Add relationship" button drops onto its own line beneath them.
Desktop is byte-identical because every modifier above `sm:` is the
prior layout.

**Acceptable as-is:**

- Captured mobile PNG is still wider than 375px because
  `GroupDetailTabs` strip overflows (the V.14b shared follow-up
  filed under "Structural issues to revisit later"). Out of V.13's
  scope.
- The relationships table itself sits inside `overflow-x-auto`, so on
  mobile the TYPE column header is truncated to "TYP" and the edit /
  delete icon buttons are clipped off the right edge of the card. Same
  V.9-style table-on-mobile clipping noted in V.9-V.12; the wrapper
  scrolls on touch but offers no visual scroll affordance, and the
  action buttons stay clipped on capture. Filed under the existing
  V.9 follow-up in "Structural issues to revisit later" rather than
  re-described here, because the per-relationship row is much smaller
  than the members row and lifting it into a tap-to-expand mobile card
  would be a bigger redesign than V.9's own.
- The single "rival" relationship row reads cleanly on desktop with a
  monospace `groupBId`, mono `rival` badge in the muted variant, the
  "May 3, 2026" `since` value in muted-foreground text, and the
  Edit / Delete icon buttons right-aligned. Empty-state is a dashed
  card with the `Link2` icon + helper copy, never visible in the demo
  fixture but inspected in source.
- Description copy mentions that "mutual" pairs render as one row each
  from both sides; this is the V1 limitation called out in source
  comments at the top of `relationships-table.tsx`. Not a polish
  issue, just a content note for morning-Gabe.

## V.14 group-sub-groups

**Before:** On 1440px desktop the surface rendered cleanly: two stacked
cards ("Parent group" with the parent breadcrumb + Edit / clear actions,
"Direct children" with the empty-state "No children yet" panel and the
"Add child" button). Active members card, active tab underline, and
breadcrumb header all matched the established group-detail shell. Mobile
(375px capture) had the same V.7 / V.10 / V.13 `CardHeader` crush
problem applied to BOTH cards: each header used
`flex flex-row items-start justify-between gap-4`, which forced the
title + description column into ~12 characters of width while the
action buttons (`Edit parent` + trash on the parent card; `Add child` on
the children card) hung off the right edge of the card. Description copy
broke into one or two words per line.

**Fix:** Same fix as V.7 / V.10 / V.13 applied to both `CardHeader`s in
`apps/dashboard/components/dashboard/sub-groups-table.tsx` (`ParentCard`
and `ChildrenCard`): swap to
`flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:space-y-1.5`.
On mobile, the title + description span the full card width and the
action row (or single action button) drops below them onto its own line.
Desktop unchanged - every modifier above `sm:` reproduces the prior
layout.

**Acceptable as-is:**

- The captured mobile PNG is still wider than 375px because the
  `GroupDetailTabs` strip overflows (V.14b shared follow-up under
  "Structural issues to revisit later"). Out of V.14's scope.
- The parent breadcrumb inner row (`<Layers>` icon + PARENT label +
  25-char mono CUID + "Open parent" link) was a separate mobile-clip
  follow-up filed as V.14c and resolved in a sibling iteration; see
  the V.14c entry below.
- Empty-state for "Direct children" - dashed-border card with `GitBranch`
  icon, "No children yet" headline, and helper copy with inline
  `<code>parentGroupId</code>` token - reads cleanly on desktop and
  mobile post-fix. Acceptable as-is.

## V.14c group-sub-groups parent breadcrumb inner row

**Before:** Inside the `ParentCard` content, the parent breadcrumb panel
used `flex items-center justify-between rounded-md border border-border
bg-card/50 p-3` with two children: a left group (h-9 w-9 Layers icon +
"PARENT" label + 25-char mono CUID) and a right "Open parent" link
(`ExternalLink` icon + label, ~110px wide). At 375px mobile viewport the
combined row width (icon ~36px + gap-3 + 25-char mono CUID at ~14px each
+ link ~110px + horizontal padding ~24px) exceeded the card's content
width. The "Open parent" link was clipped off the right edge in the
mobile capture, and because of the table's posture the whole panel
contributed to the page-width overflow that V.14b fixed at the tab strip
level. After V.14b, the tab strip stopped forcing the page wider, but
this inner row still pushed past the 375px content column and rendered
the link partially behind the card border.

**Fix:** Two-axis fix in
`apps/dashboard/components/dashboard/sub-groups-table.tsx`. (1) Outer
panel switches from `flex items-center justify-between` to
`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between` so
the icon-and-id block stacks above the "Open parent" link on mobile and
returns to the prior side-by-side posture from `sm:` up. (2) The mono
CUID gets `break-all` and its parent column gets `min-w-0` so the
25-char id wraps onto a second line inside the column instead of forcing
the row wider; the icon's wrapper gets `shrink-0` so it doesn't squash
when the column wraps. (3) The "Open parent" link gets `self-start` on
mobile (and `sm:self-auto` on desktop) so after stacking it left-aligns
naturally rather than stretching to full card width via the parent's
default `align-items: stretch`. Desktop posture is byte-equivalent to
prior because every change is gated on `sm:` or scoped to a no-op width
constraint.

**Acceptable as-is:**

- The CUID wraps to two lines on mobile (`cmoq1qmuc02lxjaadumx` /
  `lyjrz`) because the inner column is narrower than the full id. This
  matches how the V.7 game-detail API key column already handles long
  monospace tokens at mobile width; consistent posture across
  group-detail surfaces. A future iteration could shorten the displayed
  id (first 8 + ellipsis + last 4) and copy the full id on click, but
  that is a UX change not a polish edit.
- After the stack, the "Open parent" link sits below and slightly
  indented from the icon-and-label block (matches the column's left
  edge, not the card's left padding edge). Visually clear that it is
  part of the parent panel and not a separate action; acceptable.
- Pre-existing tab-strip horizontal scroll (V.14b) and per-row mobile
  table reshape (V.9 follow-up) remain unrelated problem classes; this
  entry only concerns the parent breadcrumb inner row.

## V.14b group-detail tab strip mobile overflow

**Before:** `apps/dashboard/components/dashboard/group-detail-tabs.tsx`
rendered the six-tab strip (Members / Roles / Permissions / Audit /
Relationships / Sub-groups) with
`flex items-center gap-1 border-b border-border` and no wrap or
horizontal-scroll handling. At a 375px mobile viewport the row was
~590px wide, which (a) forced the page itself wider than 375px - the
reason every V.9-V.14 mobile capture came in around 1296px - and (b)
let "Sub-groups" wrap to a second line so the label rendered as
"Sub-" / "groups" stacked at the right edge of the strip.

**Fix:** Added `overflow-x-auto whitespace-nowrap` to the tablist
container className. Mobile renders Members / Roles / Permissions
inline on one line at the natural width and lets the user scroll
horizontally to reach Audit / Relationships / Sub-groups; the page
itself collapses back to the 375px viewport. Desktop unchanged
because all six tabs fit in the wider viewport so the
`overflow-x-auto` never triggers a scrollbar. One className edit on
the shared `GroupDetailTabs` server component; benefits V.9-V.14
simultaneously.

**Acceptable as-is:**

- The hidden tabs (Audit / Relationships / Sub-groups) are not
  visually hinted - no fade gradient at the right edge to suggest
  "scroll for more". Touch users will discover the scroll naturally
  and desktop never triggers it; adding a fade overlay is polish-of-
  polish and would require a second container element. Acceptable for
  V1; can revisit if user testing surfaces discoverability issues.
- The fix does not change the underlying structural posture
  (six-tab strip designed for desktop; mobile relies on horizontal
  scroll). A wholesale mobile redesign (e.g., tab dropdown, swipe
  carousel) is out of polish-pass scope.

## V.15 game-wide audit log

**Before:** The page errored out entirely. The card body rendered
"Could not load audit log" with the runtime error "Attempted to call
resolveBefore() from the server but resolveBefore is on the client.
It's not possible to invoke a client function from the server, it can
only be rendered as a Component or passed to props of a Client
Component." Cause: `apps/dashboard/components/dashboard/game-audit-feed.tsx`
is a `"use client"` module, and the page-level Server Component
imported `resolveBefore` / `resolveSince` from it to derive the wire
`before` / `since` values from the URL state. Next.js refuses to
invoke a client export from server code at runtime; the page caught
the resulting error in its `AdminBody` try/catch and rendered the
generic error card. No actual audit data was visible.

**Fix:** Extracted `resolveBefore`, `resolveSince`, and the
underlying `datetimeLocalToIso` helper into a sibling non-client
module `apps/dashboard/components/dashboard/game-audit-feed-helpers.ts`.
The page imports them from there; the client component drops the
`"use client"`-bound copies. No behavior delta - the helpers are
pure, the conflict-resolution rule (cursor wins over endDate while
paging) still lives in one place. Same problem class as the V.8b
admin-shared split: shared non-component utilities have to live
outside `"use client"` boundaries so server code can call them.

**Acceptable as-is:**

- The audit feed is dense at mobile width (per-row stacks the action
  badge, actor / target IDs, and timestamp into a tall card; ~50
  seeded entries make the page very long). Same problem class as
  V.9's per-row mobile reshape follow-up - filed under "Members
  table mobile clipping" already covers the broader shape concern.
  Each row is individually legible; only the page total length is
  long, which is inherent to a paginated audit log on a narrow
  viewport.
- The desktop page is also long (1440x6260 capture) because the
  default page size is 50 and the seed feed is full. That is the
  intended density for a power-operator audit table; truncating
  client-side would obscure the pagination affordance. Acceptable.
- Both desktop and mobile show the filter row (action / actor /
  target / since / end / page-size) inline at the top of the card.
  Layout is the existing flex-wrap grid from V.12-style polish; no
  visible cropping or overlap in the captures.

## V.16 permission check tester

**Before:** Rendered cleanly out of the box. Form card with title
"Resolve a (user, group, permission) triple", two-line description,
three-column form (External user id / Group id / Permission key),
right-aligned "Run check" button. No result panel because the
fixture lands on the page in its empty state (the result panel only
renders after the form action returns).

**Fix:** None. Surface accepted as-is on the first render -> read
cycle.

**Acceptable as-is:**

- Desktop has a large empty area below the form card. Inherent to a
  single-form admin tool with no above-the-fold result panel until
  the user submits; truncating the page or padding it with chrome
  would not improve the affordance.
- Mobile card title wraps as "Resolve a (user, group," / "permission)
  triple" - the parenthetical list breaks mid-list at the 375px
  viewport. The title is a long phrase; without shrinking the font
  or rewording the title the wrap point is what it is, and mid-list
  break is still readable. Acceptable.
- Form labels stack above inputs on mobile, side-by-side on desktop
  via `md:grid-cols-3`. Standard pattern, matches the rest of the
  dashboard.
- Run check button is right-aligned via `flex justify-end`; on mobile
  this puts the button on its own line at the right edge of the
  card, which reads as the primary action without crowding the input
  group above it.
- Result panel layout was not exercised by this capture (fixture
  lands on the empty form). The component shape (badges + dl grid)
  matches the same patterns used on the analytics summary cards
  already polished under V.5; no separate polish iteration is
  needed for it on the basis of code review alone.

## V.17 game-analytics page

**Before:** Five analytics cards stack on the page (Group churn
distribution, Group growth over time, Member activity heatmap,
then a 2-col bottom row of Role distribution + Most-used permission
keys). Rendered desktop (1440x900) + mobile (375x812). The page-level
shell is sound: page header with back-to-game-detail link, date-range
preset tabs (Last 24 hours / 7 days / 30 days / 90 days / Custom),
the small `Game <name> - <id>` caption, then the five cards in a
single 4-spacing-unit `space-y-4` column.

**Fix:** None this iteration. The page-level layout is acceptable on
both viewports.

**Acceptable as-is:**

- Desktop bottom row: `grid-cols-1 gap-4 lg:grid-cols-2` puts Role
  distribution (donut) and Most-used permission keys (horizontal bar
  chart) side by side at lg+. At 1440 viewport with the dashboard
  sidebar (~240px) the two cards each clear ~530px and the bar chart
  has plenty of room behind its `yAxisWidth={140}` reservation. The
  paired layout is documented in code as "the two 12.5 charts sit
  side-by-side per VISION's 'Two charts side by side' framing."
- Empty / partial states: Group churn distribution renders a "No
  kicked or left members yet" message when the window has zero
  departures - intentional, the card still shows the two metric
  callouts (Window, Total departures) above the message so the empty
  state has structural context.
- Member activity heatmap shows pagination dots `* * * * *` bottom
  right when the data spans more buckets than fit in one screen of
  bars. The dots are small but visible and serve as the only
  affordance to swipe; that is consistent with the rest of the
  dashboard's Tremor charts.
- Mobile (375px): every card stacks vertically. Card titles, stat
  callouts, descriptions, and embedded charts all fit within the card
  border with no horizontal scrollbars or off-screen content. The
  mobile heatmap card preserves the same pagination dot affordance
  used on desktop.
- Date range picker tabs reuse the standard `tabs` styling that the
  rest of the dashboard uses; the active "Last 7 days" tab is
  highlighted, the rest are muted.
- Page header back-to-game-detail link is a small, right-aligned
  `border + bg-background` button with an arrow-left glyph - matches
  the chrome on every other game-scoped page (V.7, V.15, V.16).

**Follow-up filed in PROGRESS:**

- V.31 permission-usage-chart legend placement. The "Most-used
  permission keys" card has `showLegend` enabled on its Tremor
  `BarChart`, which floats the "Role grants / Member overrides"
  legend at the chart's top-right corner. Same problem class as the
  V.30 follow-up filed for the group-growth-chart legend; not fixing
  in V.17 because the user listed V.30 as a separate item, and V.17
  is a page-level surface check rather than a chart-component
  rework. The chart still renders correctly with its legend in place;
  the polish is a layout preference, not a broken state.

## V.18 game-level analytics page

**Before:** The top-level `/analytics` route is a stub-redirect
landing page: when the operator hits Analytics from a non-game-scoped
context, the page renders a centered dashed-border card titled
"Analytics surfaces are game-scoped" with a `Games list` link and a
short paragraph explaining that charts populate per-game. Rendered
desktop (1440x900) + mobile (375x812).

**Fix:** None this iteration. The empty-state landing surface is
acceptable on both viewports.

**Acceptable as-is:**

- Desktop: dashed-border card sits centered in a `mx-auto
  max-w-screen-xl` container, `p-10 text-center`. The card title acts
  as the de-facto page identity since the dashboard's design pattern
  is "content cards carry identity on desktop, no separate H1 strip"
  (consistent with the dashboard home page polished under V.5 and
  the games list under V.6 - neither has an inline desktop H1
  either; the topbar is `md:hidden` by deliberate design from commit
  49e9cb2).
- Mobile: the topbar header ("Analytics" + description "Group churn,
  growth, member activity, and permission distributions.") provides
  page identity above the dashed-border card. The card itself stays
  inside the 375px viewport with no horizontal scroll, and the inline
  `Games list` link (`font-medium text-foreground underline`) breaks
  cleanly across lines without orphaning.
- Vertical void below the card on desktop: this is inherent to a
  stub-redirect empty-state landing page; the card is the only
  content because the route's whole job is to redirect the operator
  to a game-scoped analytics surface. Mobile gets the same void below
  the card but reads as natural at narrow viewport. Not flagged as a
  layout failure - the surface communicates "you are on the
  Analytics page; pick a game to see real charts" cleanly.
- The card's `Analytics` mono-font span and `Games list` link both
  render at consistent contrast against the `bg-card/50` background;
  no contrast or readability issue on either viewport.

## V.19 game-level audit page

**Before:** The top-level `/audit` route is the same stub-redirect
shape as `/analytics` (V.18): a centered dashed-border card titled
"Audit logs are game-scoped" with a paragraph explaining that every
mutation writes to its game's audit table and a `Games list` link to
pick a game. Rendered desktop (1440x900) + mobile (375x812).

**Fix:** None this iteration. The empty-state landing surface is
acceptable on both viewports.

**Acceptable as-is:**

- Desktop: dashed-border card centered in `mx-auto max-w-screen-xl`
  with `p-10 text-center`. Title `Audit logs are game-scoped` and the
  one-line paragraph fit comfortably on a single line each (paragraph
  wraps to a second line at the 1440 viewport, which reads cleanly).
  No inline desktop H1 - same pattern as V.5 / V.6 / V.18; the
  topbar is `md:hidden` by design from commit 49e9cb2.
- Mobile: topbar provides page identity ("Audit" + description
  "Audit logs are scoped per game.") above the card. Card title wraps
  to two lines as "Audit logs are game-/scoped" with a clean break
  after the hyphen on `game-scoped`; the paragraph wraps with the
  `Games list` link landing inline mid-line, no orphans, no clipping.
  No horizontal scrollbar.
- Vertical void below the card on desktop: same as V.18 - inherent to
  a stub-redirect empty-state landing page; the card is the only
  content. Not flagged as a layout failure.
- Contrast and link styling identical to V.18: `Games list` link
  `font-medium text-foreground underline` reads cleanly against
  `bg-card/50` in dark mode.

## V.20 game-level permissions page

**Before:** The top-level `/permissions` route is the third
stub-redirect landing page in the trio with `/analytics` (V.18) and
`/audit` (V.19): a centered dashed-border card titled "Permission
checks are game-scoped" with a paragraph explaining permissions are
defined per-game and a `Games list` link plus a mono `Permission
check` span pointing at the per-game tester action. Rendered desktop
(1440x900) + mobile (375x812).

**Fix:** None this iteration. The empty-state landing surface is
acceptable on both viewports.

**Acceptable as-is:**

- Desktop: dashed-border card centered in `mx-auto max-w-screen-xl`
  with `p-10 text-center`. Title `Permission checks are game-scoped`
  fits on a single line at 1440 width and the paragraph wraps to two
  lines (`Permissions are defined and resolved per game. Open a game
  from the Games list and use its Permission check / action to test
  a (user, group, permission) triple against the same resolver your
  runtime uses.`) with the inline `Games list` link and the mono
  `Permission check` span landing on line 1, no orphans. No inline
  desktop H1 - consistent with V.5 / V.6 / V.18 / V.19; the topbar
  is `md:hidden` by design from commit 49e9cb2.
- Mobile: topbar provides page identity ("Permissions" + description
  "Resolve a (user, group, permission) triple to debug
  authorization.") above the card. Card title wraps to two lines as
  "Permission checks are / game-scoped" with a clean break after
  `are`. Paragraph wraps across roughly seven lines; the `Games
  list` link and the mono `Permission check` span both fit within
  the 375px card without breaking awkwardly. No horizontal
  scrollbar.
- Vertical void below the card on desktop: same as V.18 / V.19 -
  inherent to a stub-redirect empty-state landing page; the card is
  the only content. Not flagged as a layout failure.
- Contrast and link styling identical to V.18 / V.19: `Games list`
  link `font-medium text-foreground underline` reads cleanly against
  `bg-card/50` in dark mode; the mono `Permission check` span uses
  the default `font-mono` size and does not undersize against the
  paragraph body.

## V.21 docs site home

**Before:** First docs-site landing page in the V.21-V.25 sub-set
(VISION.visual-review.md). Standard Nextra v3 docs theme with the
`apps/docs/theme.config.tsx` defaults: top nav (Junjo wordmark + search
+ GitHub link), left sidebar (Introduction / Getting started / Tutorial
/ Self-hosting / SDK + per-namespace children / React + hooks / Roblox /
API / Auth), MDX body from `apps/docs/pages/index.mdx`, right TOC
right-rail. Body sections in order: H1 Junjo, lead paragraph, "What it
is, in one sentence", "How it fits together" (mermaid system-architecture
embed), "What it gives you" (eight bullet items), "What it is not" (four
bullet items + scope link), "Get going" (three bullets), "Reference"
(four bullets). Rendered desktop (1440x900) + mobile (375x812).

**Fix:** None this iteration. The page renders cleanly on both
viewports.

**Acceptable as-is:**

- Desktop (1440x900): three-column Nextra layout (sidebar / prose / TOC
  rail) renders without overflow. H1 "Junjo" sits flush at the top of
  the prose column with the lead paragraph reading at a comfortable
  measure (~70 chars per line). Section H2s have generous top margin
  and a clear visual separator from the preceding paragraph. Bulleted
  lists in "What it gives you" / "What it is not" / "Get going" /
  "Reference" wrap cleanly with bold lead-ins (`**Groups**`,
  `**Members**`) reading first. Inline code spans
  (`"guild"` / `"party"` / `junjo.can(...)` / package names) render with
  the Nextra default mono + tinted background. Footer pagination
  ("Getting started >") sits at the bottom-right of the prose column.
  The right-rail TOC mirrors the section headings cleanly.
- Mobile (375x812): topbar collapses to wordmark + GitHub icon;
  sidebar moves under the hamburger. H1 + lead paragraph wrap to two
  / four lines respectively with no orphan words. Section H2s break
  cleanly ("What it is, in one / sentence" wraps after `in one`,
  acceptable). Bulleted lists wrap with bold lead-ins on their own
  visual line followed by the description prose, no list-marker
  alignment problems. No horizontal scrollbar.
- Mermaid "How it fits together" embed at desktop renders the LR
  flowchart at the prose-column width. Boxes and labels are small
  but legible because the prose column is ~700px wide; the layout
  matches the V.1 canonical render of the same diagram. On mobile
  the same diagram compresses heavily (LR with subgraphs at ~340px
  is tight) but does not overflow horizontally and remains a useful
  visual cue for "the page is about an architecture". Same
  structural constraint already accepted for V.1 (filed in the
  V.1 polish-log entry as a dagre-LR side effect).
- Junjo brand wordmark and the inline `**Junjo**` first-paragraph use
  reads cleanly against both light and dark backgrounds (Nextra
  default tokens; no custom CSS overlay).
- The page's "Last updated on May ..., 2026" footer line sits flush
  with the pagination row and uses the muted-foreground token
  consistent with the rest of the docs site.

**Notes:** V.26 / V.27 (TOC slim + sidebar-collapse-at-top) are
already filed as separate Nextra-theme overrides in PROGRESS; not
re-filed here. The home page is the same prose-column shape as every
other docs page, so the polish call here doubles as a baseline read for
the docs-site theme as a whole.

## V.22 docs site sdk index

**Before:** Second docs-site landing page in the V.21-V.25 sub-set.
Source: `apps/docs/pages/sdk/index.mdx`. Body sections in order: H1
"SDK overview", lead paragraph (`@junjo/sdk` description), "Construct
a client" (code fence + 4-row option table: `apiKey` / `baseUrl` /
`authAdapter` / `fetch`), "Errors" (try/catch code fence + branch-on-
code prose), "Sub-namespaces" (6-row table linking to per-namespace
pages: groups / roles / members / invitations / audit / webhooks),
"Top-level methods" (3-row table: `junjo.can` / `junjo.check` /
`junjo.whoami`). Rendered desktop (1440x900) + mobile (375x812).

**Fix:** None this iteration. The page renders cleanly on both
viewports.

**Acceptable as-is:**

- Desktop (1440x900): standard three-column Nextra layout. Left
  sidebar shows SDK section expanded (Overview highlighted active
  + groups / roles / invitations / members / audit / permissions /
  webhooks children). Center prose column carries the H1 + lead +
  three tables and two code fences without horizontal overflow. Code
  fences (Construct a client + Errors) use the Nextra dark code theme
  on both light and dark mode, sit flush left in the prose column,
  and wrap their long string literals (`process.env.JUNJO_API_KEY!`,
  `JunjoError({ code: "invalid_config" })`) without horizontal scroll
  at the desktop measure. Right TOC right-rail enumerates the four
  H2s (Construct a client / Errors / Sub-namespaces / Top-level
  methods) with the active section highlighted on scroll.
- Mobile (375x812): topbar shows H1 + hamburger + search + GitHub.
  Tables compress to the prose-column width: each row's first cell
  (the `Option` / `Namespace` / `Method` mono identifier) wraps to
  multiple lines for the longer entries (e.g.
  `junjo.can(userId, groupId, permission)` breaks across three
  visual lines inside a single cell), and the second cell carries
  the description text wrapping below. No horizontal scroll on the
  page itself; the tables stay inside the viewport. The two code
  fences scroll horizontally inside their own container (Nextra
  default for `pre` overflow) which is the conventional behaviour
  for code on mobile and matches the V.21 home-page rendering of
  the same prose component.
- Sub-namespaces table cell formatting on mobile: the Methods column
  carries multi-method enumerations (e.g. groups: "CRUD, invites,
  membership lifecycle, group relationships, sub-group `setParent`
  / `listChildren`, `subscribe` (SSE).") which wrap to 5-6 visual
  lines per row. Tight but legible at the 375px measure; comma-list
  format means the wrap points are natural and no word is broken
  across lines.
- Light + dark mode parity: prose tokens (foreground / muted-
  foreground), code-fence theme, table border + zebra stripes, and
  inline `code` background all use the Nextra default tokens which
  already render well on both modes (validated previously on V.21
  with the same prose component). No custom CSS overlay needed for
  the SDK index.
- The "Last updated on May ..., 2026" footer + pagination row
  ("Self-hosting <" / "groups >") sits at the bottom of the prose
  column flush with the page bottom, same shape as V.21.

**Notes:** No new follow-ups discovered on this surface. V.26 /
V.27 (TOC slim + sidebar-collapse-at-top) already cover the
docs-site-wide theme overrides that would touch this page too;
not re-filed here.

## V.23 docs site self-host page

**Before:** Third docs-site landing page in the V.21-V.25 sub-set.
Source: `apps/docs/pages/self-host.mdx`. Comprehensive ops
reference (~370 lines of MDX). Body sections in order: H1
"Self-hosting Junjo", lead paragraph, "What you get on self-host",
"Required pieces", "Docker", "Docker Compose", "Local from source",
"Environment variables" (8-row table with a wide Notes column),
"Database lifecycle" (First migration / Upgrading / Schema reset /
Backups), "Issuing and rotating API keys" (First key / Additional
keys / Revoking a key), "Health checks" (`GET /` liveness +
`GET /healthz` readiness), "Background workers" (sweeper + webhook
worker prose + embedded webhook-delivery sequenceDiagram fence +
Horizontal scaling), "Reverse proxy", "Observability", "Upgrades
and breaking changes", "Where to next". Multiple sh / yaml / sql
code fences and one Mermaid sequence-diagram embed inside prose.
Rendered desktop (1440x900) + mobile (375x812).

**Fix:** None this iteration. The page renders cleanly on both
viewports.

**Acceptable as-is:**

- Desktop (1440x900): standard three-column Nextra layout matches
  V.21 / V.22. Left sidebar shows the top-level page list with the
  Self-hosting entry highlighted active. Center prose column carries
  the H1 + lead + 14+ H2 sections + nested H3s without horizontal
  overflow. Code fences (sh / yaml / sql) sit flush left in the
  prose column and wrap their long literals (the `docker run -e
  DATABASE_URL=...` invocation, the `docker-compose.yml` block, the
  `UPDATE "ApiKey" SET ...` SQL) without horizontal scroll at the
  desktop measure. Right TOC right-rail enumerates every H2 / H3
  with the active section highlighted on scroll. Embedded
  webhook-delivery sequenceDiagram inside the Background workers
  section renders at full prose-column width with all autonumbered
  steps and the explanatory note legible.
- Mobile (375x812): the page is genuinely long (this is the
  comprehensive operator reference) but composes cleanly with the
  same Nextra prose component already accepted on V.21 / V.22. No
  horizontal page scroll. Environment variables 4-column table
  (Name / Required / Default / Notes) compresses to multi-line
  cells; the Notes column wraps to 6-10 visual lines per row for
  the longer entries (`JUNJO_ADMIN_TOKEN`, `LOG_LEVEL`) but the
  table stays inside the viewport. Code fences scroll horizontally
  inside their own container per the Nextra default for `pre`
  overflow. Embedded webhook-delivery mermaid compresses on mobile
  the same way the V.1 system-architecture diagram does (LR
  sequence with many participants in a narrow viewport); the
  diagram does not horizontally overflow the page itself.
- Light + dark mode parity: prose tokens, code-fence theme, table
  border + zebra stripes, blockquote callout (the `> The
  ghcr.io/junjo/server:latest image is the V1 release target...`
  note), and inline `code` background all use the Nextra default
  tokens, which already render well on both modes (validated on
  V.21 / V.22 with the same prose component). No custom CSS
  overlay needed for the self-host page.
- The "Last updated on ..., 2026" footer + pagination row sits at
  the bottom of the prose column flush with the page bottom, same
  shape as V.21 / V.22.
- Mobile fullPage screenshot artifact: at 375px width the resulting
  PNG is ~38k pixels tall and Puppeteer's fullPage capture
  re-includes the Nextra sticky mobile nav at multiple scroll
  positions, which makes the captured PNG appear to "repeat" the
  page header several times. This is a Puppeteer rendering
  characteristic for sticky-positioned elements during fullPage
  capture, not a real layout regression - in a live mobile
  browser the sticky nav stays at the top of the viewport as you
  scroll and the page below it renders once. Not actionable.

**Notes:** No new follow-ups discovered on this surface. V.26 /
V.27 (TOC slim + sidebar-collapse-at-top) cover the docs-site-wide
theme overrides that would touch this page too; not re-filed here.

## V.24 docs site api-reference index page

**Before:** Fourth docs-site landing page in the V.21-V.25 sub-set.
Source: `apps/docs/pages/api-reference/index.mdx` (~75 lines of
MDX). Body sections in order: H1 "HTTP API overview", lead
paragraph (REST + SSE + webhook dispatcher; cloud and self-host run
the same binary), "Versioning" (single-paragraph note that all
resource routes mount under `/v1`), "Authentication" (Bearer
header code fence + prefix.secret prose + invalid_api_key error
example fence + public-routes bullet list + admin-token call-out),
"Error envelope" (JSON code fence + 7-row code/status/meaning
table), "Rate limiting" (two prose paragraphs + a third on which
routes are exempt), "Server bootstrap" (one paragraph + cross-link
to the self-host page). Rendered desktop (1440x900) + mobile
(375x812).

**Fix:** None this iteration. The page renders cleanly on both
viewports.

**Acceptable as-is:**

- Desktop (1440x900): standard three-column Nextra layout matches
  V.21 / V.22 / V.23. Left sidebar carries the full top-level page
  list with the API reference group expanded and "HTTP API
  overview" highlighted active. Center prose column carries the
  H1 + 6 H2 sections without horizontal overflow. Code fences
  (`Authorization` header line, the `invalid_api_key` JSON, the
  full error-envelope JSON) sit flush left in the prose column and
  fit without scroll at the desktop measure. The 7-row error-codes
  table fills the prose column width; the `meaning` column wraps
  the longer entries (`rate_limit_exceeded` paragraph) across
  several lines but the table is contained. Right TOC right-rail
  enumerates every H2 with the active section highlighted on
  scroll.
- Mobile (375x812): single prose column, no horizontal page
  scroll. The error-codes table compresses to a 3-column layout
  with the `meaning` cell wrapping to multi-line per row; the
  longest cell (`rate_limit_exceeded`) takes ~10 visual lines but
  the row stays inside the viewport. Code fences scroll
  horizontally inside their own container per the Nextra default
  for `pre` overflow. The `Authorization: Bearer <prefix>.<secret>`
  one-line fence does not wrap and scrolls on touch. No layout
  break.
- Light + dark mode parity: prose tokens, code-fence theme, table
  borders, and active sidebar highlight all match the existing
  Nextra defaults already accepted on V.21 / V.22 / V.23. No
  contrast regressions.
- Sticky nav: same Puppeteer fullPage rendering characteristic
  noted on V.23 - on a long page the captured PNG re-includes the
  Nextra sticky nav at multiple scroll positions. Not actionable.

**Notes:** No new follow-ups discovered on this surface. V.26 /
V.27 (TOC slim + sidebar-collapse-at-top) remain the docs-site-wide
theme overrides that would touch this page too; not re-filed here.

## V.25 docs site auth index page

**Before:** Fifth and final docs-site landing page in the V.21-V.25
sub-set. Source: `apps/docs/pages/auth/index.mdx`. Body sections in
order: H1 "Auth adapters", lead paragraph (Junjo verifies session
tokens via pluggable auth adapter; Clerk / Supabase / generic JWT
ship in `@junjo/sdk` with build-your-own escape hatch), "The
interface" (TS code fence showing `AuthAdapter.verifyToken` shape),
"When to use which" (4-row adapter table: Clerk / Supabase / JWT /
custom), "Where it plugs in" (server config code fence with
`createServer({ authAdapter })`), "End-to-end flow" (prose summary
of the request -> verifyToken -> permission-check path), "The user
id contract" (bullet list on what `userId` MUST be), "Failure-mode
parity" (single-paragraph note on the 401 envelope all adapters
return), "See also" (link list to per-adapter pages). Rendered
desktop (1440x900) + mobile (375x812).

**Fix:** None this iteration. The page renders cleanly on both
viewports.

**Acceptable as-is:**

- Desktop (1440x900): standard three-column Nextra layout matches
  V.21 / V.22 / V.23 / V.24. Left sidebar carries the full top-level
  page list with the Auth group expanded and "Overview" highlighted
  active. Center prose column carries the H1 + 7 H2 sections without
  horizontal overflow. Two code fences (the `AuthAdapter` TS
  interface + `createServer({ authAdapter })` config) sit flush left
  in the prose column and fit without scroll at the desktop measure.
  The 4-row adapter table fills the prose column width; the "Use
  case" column wraps the longer entries (e.g. the JWT row's
  description) across two or three lines but the table is contained.
  Right TOC right-rail enumerates every H2 with the active section
  highlighted on scroll.
- Mobile (375x812): single prose column, no horizontal page scroll.
  The adapter table compresses to fit the prose-column width; cells
  wrap to multiple lines per row but the rows stay inside the
  viewport. Code fences scroll horizontally inside their own
  container per the Nextra default for `pre` overflow. The "See
  also" link list stacks vertically with each entry on its own row,
  matching the prose-list rendering on V.21 / V.22.
- Light + dark mode parity: prose tokens, code-fence theme, table
  borders, inline `code` background, and active sidebar highlight
  all match the existing Nextra defaults already accepted on V.21 /
  V.22 / V.23 / V.24. No contrast regressions.

**Notes:** Closes the V.21-V.25 docs-site sub-set. All five docs
landing pages (home, sdk, self-host, api-reference, auth) accepted
with no code change - the Nextra theme is doing the right thing on
its own at both desktop and mobile measures. V.26 / V.27 (TOC slim
+ sidebar-collapse-at-top) remain the docs-site-wide theme
overrides that would touch this page too; not re-filed here.

## V.26 docs TOC right-rail polish

**Before:** Two complaints surfaced on user inspection of the docs
TOC right-rail:

1. The webkit scrollbar inside the TOC overflow container
   (`.nextra-toc .nextra-scrollbar`) defaulted to 0.75rem (12px)
   wide, which read as a heavy bar next to the prose column on
   pages whose TOC exceeds the viewport (e.g. `/sdk/groups` lists
   six methods x four sub-items = 24+ entries). Slim it down.
2. H2 method names (e.g. `create(input)`, `update(id, input)`)
   share the same `text-gray-500` color as their H3 sub-items
   (Input / Errors / See also). Nextra's only differentiation is
   `_font-semibold` on the H2 anchor + `_ms-4` indent on the H3
   anchor, which is too subtle - the eye reads the whole TOC as
   a flat list rather than a method-grouped index.

**Fix:** Introduced `apps/docs/styles/globals.css` (new file,
~40 LOC) and added a single CSS import to `apps/docs/pages/_app.tsx`.
Three deltas:

- Trim the TOC webkit scrollbar from 0.75rem to 4px, keep the
  same translucent thumb color (`rgba(115,115,115,0.25)`,
  `0.55` on hover). Page-level browser scrollbar is unaffected
  because the rule is scoped to `.nextra-toc .nextra-scrollbar`.
- Bump `.nextra-toc nav a:not([class*="_ms-4"])` (Nextra's H2
  anchor selector by exclusion of the H3 indent class) to
  `gray-900` in light mode and `gray-100` in dark mode. The H3
  sub-items keep the theme default `gray-500`, which now reads
  as a distinct lower tier.
- Add `margin-top: 0.75rem` between consecutive H2 entries (and
  between the last H3 of a method and the next H2) via
  `.nextra-toc nav li:has(> a:not([class*="_ms-4"])) + li:has(>
  a:not([class*="_ms-4"]))` and the H3->H2 transition variant.
  This gives each method block visible breathing room without
  inserting separator lines.

**Acceptable as-is:**

- Re-rendered `/sdk/groups` desktop (1440x24283, fullPage), then
  cropped a 340x900 strip of the TOC right-rail for inspection.
  The TOC reads as: bold white code-pill method names
  (`create(input)`, `get(id)`, `list(opts?)`, `update(id, input)`,
  `delete(id, opts?)`, `restore(id)`) with muted gray sub-items
  (Input / Errors / Returns / Options / See also) under each. The
  active method (`create(input)` at top scroll position)
  highlights cyan via Nextra's existing active-state rule. Each
  method group separates from the next by ~12px of vertical
  space, much easier to scan than the previous flat run-on list.
- Slim scrollbar verified by inspecting the cropped TOC strip:
  no visible scrollbar at the top scroll position because the
  TOC content fits within its container at the desktop measure;
  the rule will engage on smaller viewports / longer TOCs.
- Re-rendered `/` (home) desktop and confirmed the H2-only TOC
  ("What it is, in one sentence" / "How it fits together" /
  "What it gives you" / etc.) renders the H2 entries in the new
  brighter color without any spurious top margin between them
  (the +-li :has() selector requires both prev AND next to be
  H2, so the active section highlight + uniform spacing both
  apply correctly).
- Mobile parity: the TOC is `max-xl:_hidden` in Nextra's default
  layout, so the mobile screenshot for `/sdk/groups` shows no
  TOC at all (correct). The CSS overrides have no effect on
  mobile.
- Light + dark mode parity: the bump-color rule is split into
  base (light: gray-900) and `.dark` (dark: gray-100). Both
  modes get the same hierarchy treatment.

**Notes:** Architectural change: this is the first dedicated CSS
file for `apps/docs`. Keep it small - any future delta should ask
"can this be done via `theme.config.tsx`?" first. The `_app.tsx`
import path is `../styles/globals.css` (Next.js pages-router
convention).

## V.27 docs sidebar footer moved to TOP

**Before:** The `nextra-sidebar-footer` div (theme switch + sidebar
collapse button) renders as the last child of the
`aside.nextra-sidebar-container` flex-col, with `_sticky _bottom-0`.
Both controls sit pinned at the bottom-left of the viewport. Two
problems:

1. The dark/light/system theme toggle is one of the most-clicked
   surfaces a docs reader hits, and putting it under a long nav
   (Introduction / Getting started / Tutorial / Self-hosting / SDK
   with 8 sub-items / React with 7 sub-items / etc.) means it
   competes with Vercel's dev-mode floating "N" badge for screen
   real-estate at the bottom-left corner and is easy to miss.
2. The sidebar-collapse rectangle button (`max-md:_hidden`) sits
   next to the theme toggle at the bottom; users who want to give
   the prose more horizontal room have to scroll-hunt for it.

**Fix:** Added a single CSS rule to `apps/docs/styles/globals.css`:

```css
.nextra-sidebar-container .nextra-sidebar-footer {
  order: -1;
  top: 0;
  bottom: auto;
}
```

`order: -1` makes the footer sort before the menu container in the
flex-col (the menu has implicit `order: 0`). `top: 0; bottom: auto`
re-anchors the sticky-positioned footer so it pins to the top of
the aside instead of the bottom. The aside itself does not scroll
(the inner menu container does), so sticky here mostly affects the
in-flow visual position rather than scroll-pinning behavior.

**Acceptable as-is:**

- Re-rendered `/sdk` desktop and cropped a 320x900 sidebar strip:
  "System" theme switch with moon icon now sits immediately under
  the "Junjo" logo at the top of the aside, with the rectangle
  sidebar-collapse button to its right. Below that, the nav list
  starts with "Introduction / Getting started / Tutorial /
  Self-hosting / SDK (expanded with Overview / groups / invitations
  / members / roles / permissions / audit / webhooks)" exactly as
  before. No other layout shift.
- Mobile parity: the sidebar is `max-md:[transform:translate3d(0,-100%,0)]`
  hidden by default and only opens via the navbar hamburger as a
  popover. The footer's collapse button has `max-md:_hidden`
  (collapsing makes no sense on mobile where the sidebar is full-
  screen), but the theme switch still renders inside the open
  mobile sidebar; with the new rule it would also appear at top of
  the open mobile menu, which is consistent with the desktop
  treatment.
- Light + dark mode parity: pure layout rule, no color values to
  drift.

**Notes:** No new selectors against unstable Nextra internals - the
selector is `.nextra-sidebar-container .nextra-sidebar-footer`,
both classes are part of Nextra's documented theme structure
(see `nextra-theme-docs/dist/index.js` lines 1789-1835). Same
defensive scoping as the V.26 TOC rules.

## V.28 dashboard groups-table - drop "Open ->" column, make name clickable

**Before:** Every row in the All groups table had a trailing
"Open ->" link in its own (unlabeled) rightmost column. The group
name in the first cell rendered as plain `text-sm font-medium`
white-on-dark text - the row itself was clickable (cursor-pointer
+ keyboard handler) but nothing in the rendered cell hinted that
it was. Operators got two competing affordances for the same
action: a low-contrast Open link far to the right, and an
invisible row click in the middle.

**Fix:** Removed the entire trailing column (the placeholder
`<th aria-label="Open group" />` in the header row and the
`<td>` containing the `<Link>Open <ArrowRight/></Link>` in each
body row). Wrapped the group name in a `<Link>` styled
`text-primary hover:underline` so the name itself is the obvious
clickable target. Kept the row-level `onClick` and `onKeyDown`
so clicking anywhere on the row still navigates (with
`stopPropagation()` on the name link to avoid double-firing).
Dropped the now-unused `ArrowRight` import. Added `gameId` to
the `columns` `useMemo` dependency array since the cell now
references it.

**Acceptable as-is:**

- Clicking the row (anywhere except the name link) and clicking
  the name both go to the same destination, but the row click is
  retained as a usability fallback - the entire row is still a
  hit target, the name is just the visually-discoverable one.
- `text-primary` resolves to coral on light and dark mode (the
  V1 brand accent already applied to the dashboard logo and
  other primary CTAs); contrast against `bg-card` checks out at
  both themes.
- Mobile viewport renders the names in coral inside the
  horizontally-scrolling `overflow-x-auto` table. The card is
  the same width as before (the dropped column trimmed ~80px
  from the natural table width), so on mobile the table simply
  scrolls one fewer column to the right.
- The rightmost natural column is now Created (May 4, 2026 etc.)
  with no decorative trailing column. Header and body widths
  match without the placeholder `<th>`, so column alignment is
  preserved.

**Notes:** This pattern (drop dedicated "Open" column + make name
clickable) carries forward to V.29 (games-list) which has the
same shape. V.30 / V.31 are unrelated chart-legend follow-ups.

## V.29 dashboard games-list - drop "Open ->" column, make name clickable

**Before:** Every row in the All games table had a trailing
"Open ->" link in its own (unlabeled) rightmost column. The
game name in the first cell wrapped a `Link` whose only hover
affordance was `group-hover:underline` on a plain
`text-sm font-medium` span - the link existed but nothing in
the rendered cell suggested it was clickable until the operator
hovered. Same two-competing-affordances problem as V.28: a
low-contrast Open link on the right and a not-obviously-clickable
name on the left.

**Fix:** Removed the entire trailing column (the placeholder
`<th aria-label="Open game" />` in the header row and the
`<td>` containing the `<Link>Open <ArrowRight/></Link>` in each
body row). Recoloured the existing name link to
`text-primary hover:underline` so the name itself is the obvious
clickable target. Dropped the `group` / `group-hover:underline`
wrapper since the hover affordance is now on the name span
directly. Dropped the now-unused `ArrowRight` import. Moved the
`md:table-cell` Created header / cell padding from `pr-4` to
trim the rightmost-column whitespace once the Open column was
gone.

**Acceptable as-is:**

- Unlike V.28's groups-table this is a server component without
  a row-level `onClick`; the name link is the only click target.
  No double-fire concern, no `stopPropagation` plumbing.
- `text-primary` resolves to coral on light and dark mode (same
  brand accent as V.28 and the dashboard logo); contrast against
  `bg-card` checks out at both themes.
- Mobile viewport (`max-sm`) hides Groups / API keys / Created
  via `hidden ... sm:table-cell` and `hidden ... md:table-cell`,
  so on mobile the rendered columns are now just Name and
  Members. Names render in coral on the mobile capture as
  expected.
- Desktop capture shows Created (May 4, 2026) as the rightmost
  natural column with no decorative trailing column. Two-row
  fixture (Screenshot Demo / Sweep Game) renders cleanly with
  consistent column alignment.

**Notes:** Closes the V.28 / V.29 pair. V.30 (group-growth-chart
legend) and V.31 (permission-usage-chart legend) are unrelated
chart treatments and will be picked up next.

## V.30 group-growth-chart - move legend below chart

**Before:** Tremor's `<LineChart showLegend>` rendered the
series legend (Wolves of Ironvale / Storm Riders / Ironvale
Alliance) inside the upper-right corner of the chart frame.
The legend floated over the plot area, competing visually
with the rendered lines and chopping the usable y-axis range
at the right edge. The `role-distribution-chart.tsx` already
sits two cards down on the same `game-analytics` page using
`<Legend className="justify-center" />` below the donut, so
the page had two different legend treatments for charts that
sit in the same scroll viewport.

**Fix:** Set `showLegend={false}` on the `<LineChart>` and
appended Tremor's standalone `<Legend categories={...}
colors={...} className="justify-center" />` below the chart
inside a `flex flex-col gap-3` wrapper. Same component the
role-distribution-chart already uses; same color array the
chart receives, so legend swatches match line colors exactly.
Hoisted `columns.map((c) => c.column)` into a memoised
`categoryNames` so both `<LineChart>` and `<Legend>` read
from one source.

**Acceptable as-is:**

- Tremor's `<Legend>` flex-wraps when narrow, so the mobile
  viewport stacks the three series vertically below the chart
  instead of horizontally. Same behaviour role-distribution-
  chart exhibits at the same width; consistent across the
  page.
- Up to 11 series can render (top-N max 10 + "All others"
  aggregate). On wide series counts the legend will wrap to
  two or three rows below the chart; that is fine - the cost
  of avoiding overlap with the plot dominates the cost of an
  extra legend row.
- The chart's plot area now owns the full card width without
  the floating legend stealing the upper-right corner; the
  three lines render with full y-axis bleed at the right edge.

**Notes:** V.31 (permission-usage-chart) is the same pattern
applied to a horizontal-bar chart; the legend placement may
be above OR below depending on what looks better with the
horizontal-bar layout - that's a separate iteration.

## V.31 permission-usage-chart - move legend above bars

**Before:** Tremor's `<BarChart showLegend>` (with
`layout="vertical"`, i.e. horizontal bars) rendered the two
stacked-segment categories ("Role grants" / "Member
overrides") as a small floating legend in the upper-right
corner of the chart frame, cutting into the chart's plot
area where the longest bars extend. With V.30 already
having moved the `group-growth-chart` legend below the
chart, the page was halfway between two patterns: donut +
line chart legend below, bar chart legend floating
top-right.

**Fix:** Set `showLegend={false}` on the `<BarChart>` and
prepended Tremor's standalone `<Legend categories={...}
colors={...} className="justify-center" />` ABOVE the chart
inside a `flex flex-col gap-3` wrapper. Same component
role-distribution-chart and group-growth-chart already use;
same color array the bars receive, so legend swatches match
bar segment colors exactly. Extracted the previously inline
`[ROLE_GRANTS_KEY, MEMBER_OVERRIDES_KEY]` and
`["blue", "violet"]` arrays into module-level `CATEGORIES`
and `COLORS` constants so both `<BarChart>` and `<Legend>`
read from one source. Above-bars placement (rather than V.30's
below-chart) chosen because the chart can grow to ~32rem tall
when the cohort hits 15 permission keys; placing the legend
above keeps it visible without scrolling and matches the
intuition of "color key, then chart" for a horizontally-laid-
out bar chart where reading direction sweeps left-to-right
across each row.

**Acceptable as-is:**

- Tremor's `<Legend>` flex-wraps when narrow, so the mobile
  viewport may stack the two series vertically (in practice
  the two short labels fit on one line at 375px). Same
  behaviour the other two charts on the page exhibit.
- Two stacked segments per bar means the legend has only two
  entries, so above-bars placement is visually compact even
  at narrow widths.
- The chart's plot area now owns the full card width without
  the floating legend stealing the upper-right corner; the
  longest bars render with full x-axis bleed at the right
  edge.

**Notes:** Closes the V.30 / V.31 chart-legend pair. The
`game-analytics` page now has two consistent legend placements:
group-growth-chart and role-distribution-chart legends sit
BELOW their charts; permission-usage-chart sits ABOVE.
Different placements are intentional (the donut and line
chart are square-ish or wide-and-short, so legend below
balances; the horizontal-bar chart grows tall, so legend
above stays visible). All three use the same Tremor
`<Legend>` component with `justify-center`.

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
