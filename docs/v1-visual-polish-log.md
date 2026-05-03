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

## Structural issues to revisit later

(none yet)
