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

## Structural issues to revisit later

(none yet)
