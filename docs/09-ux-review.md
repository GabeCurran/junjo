# Junjo V1 UX review

This is the pre-launch UX review of Junjo V1, completed under Phase 14.16. It audits the SDK ergonomics, the admin dashboard's interaction model, and the documentation site for friction points that would surface as bad first impressions or repeat-question support load.

The companion documents are:

- `docs/05-decisions.md` - the design decision log; this audit drops one entry there.
- `docs/06-security.md` - the V1 security posture (Phase 14.13).
- `docs/07-api-review.md` - the V1 API consistency audit (Phase 14.14).
- `docs/08-code-quality.md` - the V1 code-quality audit (Phase 14.15).

## Scope

Three axes, audited together because a developer's "does Junjo feel finished?" gestalt is built from all three:

- **SDK ergonomics**: every public method exported from `@junjo/sdk` and `@junjo/sdk/adapters`. The framing question for each method was "if a developer reads this signature in their IDE's hover, does the shape and naming match what they would have guessed?".
- **Dashboard usability**: every page under `apps/dashboard/app/**` plus the shared interaction components (dialogs, tables, empty states). The framing question was "can a developer poking the dashboard for the first time understand what state they are looking at, and confirm or undo every mutation?".
- **Documentation clarity**: every page under `apps/docs/pages/**`, with extra weight on the entry pages (`getting-started`, `tutorial`, the SDK overview) that gate the developer's first 30 minutes. The framing question was "if a developer reads this page top-to-bottom without prior Junjo context, can they make their next move?".

Out of scope: copy polish (one-off typo fixes are normal PR review territory, not audit territory), color and typography (visual design is its own pass), and cloud-only / billing UI (deferred per `docs/02-scope.md`).

## Methodology

1. Walked every public method on `Junjo`, `GroupsApi`, `MembersApi`, `RolesApi`, `InvitationsApi`, `AuditApi`, `WebhooksApi`, plus the three auth adapters; tabulated their signatures (positional vs options-object, throw vs return-null on absence, return shape).
2. Walked every page under `apps/dashboard/app/**` for empty-state, loading-state, error-state, and confirmation-dialog coverage.
3. Walked every `.mdx` under `apps/docs/pages/**`, cross-referencing the page set against `_meta.ts` for orphans, and spot-checking the SDK reference pages for code-sample density and accuracy.
4. Categorized findings by severity:
   - **Severe** - inconsistency or rough edge that would surface as a wrong-on-first-try moment for a developer; fix now.
   - **Moderate** - low-cost normalization, removes future friction without breaking anyone.
   - **Minor** - document or accept.

## What is consistent (preserve these)

These conventions are uniform across the V1 surface and worth defending in code review going forward.

| Convention | Status |
|--|--|
| Every list method paginates with `Page<T> = { items, nextCursor }` | Uniform after Phase 14.14. |
| Every "fetch one" method returns `T \| null` on 404, throws on other errors | `groups.get`, `members.get`, `members.getById`, `roles.get`, `invitations.get`, `groups.getRelationship` all match. |
| Every mutation method that talks to the server throws `JunjoError` for any non-2xx response | The error envelope is uniform; callers branch on `error.code`. |
| Adapter contract: return `null` on every legitimate verification failure; throw `JunjoError("invalid_config")` only on setup-time misconfig | All three built-in adapters (`jwtAdapter`, `clerkAdapter`, `supabaseAdapter`) follow this. Documented in `apps/docs/pages/auth/index.mdx`. |
| Branded id types at API boundaries | Callers receive `GroupId` / `UserId` / `RoleId` etc. from the SDK, not raw strings. |
| Dashboard mutations confirm via dialog | `<KickMemberDialog>`, `<RevokeApiKeyDialog>`, `<DeleteGroupDialog>` etc. all use shadcn's `<Dialog>` with explicit "Cancel" + descriptive action button. No accidental destructive clicks. |
| Dashboard pages use `<Suspense>` skeletons during async fetch | Group detail tabs, members table, audit feed all render skeletons before the Server Component data arrives. |
| Dashboard error states use `<ErrorCard>` (not the Next.js error boundary) | Inline error rendering keeps the chrome (sidebar, breadcrumb, page title) intact so the user can navigate away. |
| Docs SDK reference pages include code examples plus input + error tables | Every method on `apps/docs/pages/sdk/groups.mdx` follows the pattern: header, description, code block, input table, error table. Same for members / roles / invitations / audit / webhooks. |

## Findings

### Severe (fixed in this phase)

**14.16-S1. `Junjo#whoami(token)` was a half-finished stub that threw `not_implemented`.**

The SDK exposed `whoami(token)` as a public method that threw `JunjoError({ code: "not_implemented", message: "not implemented" })`. The auth adapter pathway (Phase 6) shipped its server-side half (`verifyToken` populating `c.var.junjoUserId`), but the SDK's client-side bridge from "token in hand" to "userId" was never wired up. `apps/docs/pages/sdk/index.mdx` documented the method as "Stubbed; lands with the auth-adapter pathway in Phase 6", and `apps/docs/pages/auth/index.mdx` named `whoami(token)` as one of the two reasons to configure an `authAdapter`, so the contract was advertised but unbuilt.

This was the lone existing user of the `not_implemented` error code. Every other reserved-but-unimplemented surface has been removed during the V1 build; `whoami` was the holdout.

**Fix shipped.** `Junjo#whoami(token)` now stores `config.authAdapter` on the instance and delegates to `this.authAdapter.verifyToken(token)`. The implementation is intentionally thin: `whoami` is a convenience for developers who hold the `Junjo` client but not a separate reference to the adapter. If `whoami` is called without a configured `authAdapter`, the method throws `JunjoError({ code: "invalid_config", message: "whoami requires an authAdapter; pass one to \`new Junjo({ authAdapter })\`" })`. This matches the existing adapter-setup-failure code (the same code the three built-in adapter constructors throw on missing config).

**Side effects of the fix:**

- The `not_implemented` code is no longer raised anywhere in the SDK. The row was removed from `apps/docs/pages/api-reference/errors.mdx`. The neighbouring sentence about "SDK-only codes" was updated to drop the reference.
- The boilerplate sentence "Calling a stubbed method throws `JunjoError` with `code: 'not_implemented'`" was removed from `apps/docs/pages/sdk/groups.mdx` and `apps/docs/pages/sdk/invitations.mdx`. Both pages had no actual stubbed methods (every method on each page was already marked `- shipped`); the boilerplate was doc-rot left over from earlier phases.
- `apps/docs/pages/sdk/index.mdx`'s top-level method table now marks `whoami(token)` as `shipped (Phase 14.16)` with the inline behavior summary.

The unused `NOT_IMPLEMENTED` constant was deleted from `packages/sdk/src/index.ts`. Tests covering all four behaviors of `whoami` (delegate-success, delegate-null, missing-adapter, adapter-throw) live in the new `packages/sdk/src/index.test.ts`.

### Severe (deferred with rationale)

**14.16-S2. SDK signature inconsistency: where does the `userId` go?**

The invitation-acceptance flow has the most awkward shape in the V1 SDK. `acceptInvitation(code, userId)` makes `userId` a required positional argument; `declineInvitation(code, opts?: { userId? })` makes it optional and tucked inside an options object. Discovered while reading the SDK in IDE hover: a developer who has just typed `junjo.groups.acceptInvitation(` and `junjo.groups.declineInvitation(` sees two different shapes for what they would expect to be the same parameter.

The asymmetry is justified by the underlying server contract (`accept` requires the user id to create the new `GroupMember`, `decline` does not) but the SDK does not need to mirror server requiredness. A uniform `(code, opts: { userId })` for both would be more discoverable.

**Why deferred.** Renaming `acceptInvitation`'s second positional argument into an options object is a hard-breaking SDK change. Every existing caller of the form `await junjo.groups.acceptInvitation(code, userId)` would need to migrate to `await junjo.groups.acceptInvitation(code, { userId })`. The benefit (one less surprise in IDE hover) is real but does not justify breaking every existing integration. The right move is to do this in V2 alongside any other SDK-shape breaking changes, batched into one release-note migration entry.

**Action.** Audit closed; no code change. Documented in `docs/05-decisions.md` so V2 has a starting list.

**14.16-S3. `members.setMetadata(groupId, userId, metadata)` and `members.setNotes(groupId, userId, input)` use different third-arg shapes.**

`setMetadata` takes a flat `Record<string, unknown>` as the third argument; `setNotes` takes a structured `SetMemberNotesInput` (`{ notesPublic?, notesPrivate? }`). Both update the same Prisma row via the same `PATCH /v1/groups/:id/members/:userId` route. The flat metadata third-arg is older (Phase 2.7); the structured `setNotes` is from the same phase but landed with the typed input shape (the field names are different so structural typing alone would not have worked).

**Why deferred.** Structurally, the metadata case is genuinely different: it accepts arbitrary key-value pairs (caller-defined), so a `{ metadata: Record }` wrapper would be redundant noise. The notes case has two specific named fields. The shapes diverge because the underlying domain shapes diverge. The asymmetry feels rough but is not a fix worth a hard-breaking SDK change.

**Action.** Audit closed; no code change. Documented in `docs/05-decisions.md`.

### Moderate (deferred)

**14.16-M1. SDK methods have no JSDoc; only inline `//` comments at the file level.**

Hovering any SDK method in VS Code shows the type signature and nothing else. The shipped behavior contracts (e.g., "idempotent on already-kicked members", "returns post-state Member") live as `//` comments adjacent to the method or as prose in the docs site, but not in the IDE hover. A developer working from autocomplete alone is missing the contract details.

**Why deferred.** Adding JSDoc to every public method is a 200-line cross-package edit that touches every SDK file. The mechanical work is straightforward, but it is gold-plating in the strict Phase-14 sense: the existing docs site already covers every contract. A developer who needs the detail can `cmd-click` to the method definition and read the inline `//` comments, or read the docs page. The IDE-hover delta is a quality-of-life improvement that does not change correctness or break compatibility.

**Action.** Audit closed; tracked as a V2 candidate. Documented in `docs/05-decisions.md`.

**14.16-M2. Dashboard `members-table.tsx` does not render an explicit empty state.**

Most dashboard tables (`<RolesTable>`, `<GamesList>`, the audit feed) render explicit empty-state cards with an icon, a title ("No groups yet"), and copy explaining the next action. The members table renders the bare TanStack `<Table>` with no rows when no members match, and no auxiliary copy. A developer who has just landed on a freshly-created group sees a header, search bar, and a blank table with no orientation.

**Why deferred.** This is dashboard-only and the dashboard is proprietary. Per Phase 14 hard rule (operator benefit must be articulable in one sentence): "shows orientation copy when the members table is empty" is a real benefit, but the dashboard polish loop is its own workstream. Documented here so future-Gabe has the punch list.

**Action.** Documented; no code change in this audit.

**14.16-M3. The docs site has no nested `_meta.ts` files for `/sdk/`, `/api-reference/`, `/auth/`, `/react/`.**

Top-level navigation (`apps/docs/pages/_meta.ts`) is curated. The nested directories rely on file-system ordering for the sidebar, which means adding a new page can silently re-order the sidebar based on alphabetical order. Today the sidebar happens to make sense (`audit` -> `errors` -> `events` -> `groups` -> ...) but the next added page could break it.

**Why deferred.** Wire-level: zero customer impact. The dev who hits the docs sees the same navigation regardless. Adding nested `_meta.ts` files is purely a maintenance hardening; tracked for V2 doc-tidying.

**Action.** Documented; no code change.

### Minor (documented)

- The dashboard sidebar's "Permissions" link points to `/games/[gameId]/permissions/check`, the permission-check tester. The label is accurate but might suggest a CRUD page; renaming the sidebar entry to "Permission tester" would be slightly more honest. Single-word UI copy adjustment, not worth its own commit.
- `apps/docs/pages/getting-started.mdx` and `apps/docs/pages/tutorial.mdx` both exist and are non-trivial. The two pages overlap in their first 100 lines (both walk through the same `Junjo` constructor + first API call). Consolidating would save a developer one read; the current split is defensible (getting-started is install-focused, tutorial is build-focused) and not worth a content rewrite for V1.
- The webhook formatter pages (`apps/docs/pages/api-reference/webhooks-discord.mdx`, `webhooks-slack.mdx`) live under `/api-reference/` rather than under `/webhooks/` (which is what `apps/docs/pages/_meta.ts` calls the section). The path is internally consistent (everything under `/api-reference/` is reference material) but a developer hunting Discord-specific docs from the sidebar might glance over them. Documented; no rename.

## Inventory: SDK return-shape uniformity

The full surface is uniform on the read side after this audit. The action side is uniform too, modulo the documented S2 / S3 asymmetries.

| Read method | Returns | Notes |
|--|--|--|
| `groups.get(id)` | `Group \| null` | 404 -> null; other errors throw. |
| `groups.list(opts?)` | `Page<Group>` | Cursor pagination. |
| `groups.getRelationship(a, b)` | `GroupRelationship \| null` | Same convention. |
| `groups.listRelationships(id)` | `GroupRelationship[]` | Bare array; bounded set. |
| `groups.listChildren(id)` | `Group[]` | Bare array; bounded set. |
| `members.get(groupId, userId)` | `Member \| null` | 404 -> null. |
| `members.getById(id)` | `Member \| null` | 404 -> null. |
| `members.list(groupId, opts?)` | `Page<Member>` | Cursor pagination. |
| `members.listForUser(userId, opts?)` | `Member[]` | Bare array; hard-cap 1000 server-side. |
| `members.listPermissionOverrides(groupId, userId)` | `MemberPermissionOverride[]` | Bare array; bounded set per member. |
| `roles.get(id)` | `Role \| null` | 404 -> null. |
| `roles.list(groupId)` | `Role[]` | Bare array; bounded per group. |
| `invitations.get(code)` | `Invitation \| null` | 404 -> null. |
| `invitations.list(groupId, opts?)` | `Page<Invitation>` | Cursor pagination. |
| `audit.list(groupId, opts?)` | `Page<AuditEntry>` | `?before=` cursor (documented quirk in Phase 14.14). |
| `webhooks.endpoints.list()` | `Page<WebhookEndpoint>` | Pagination shape locked in by Phase 14.14. |

## Closing the audit

This phase shipped one concrete fix: implementing `Junjo#whoami` against the configured auth adapter, removing the lone `not_implemented` SDK surface. The remaining S- and M-tier findings are all signature-shape or doc-organization items whose only fix-cost is breaking an existing SDK caller; those are V2-batchable.

The V1 SDK + dashboard + docs surface is launchable as documented today.
