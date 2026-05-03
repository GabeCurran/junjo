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

## Structural issues to revisit later

(none yet)
