# Junjo V1 API review

This is the pre-launch consistency audit of the public `/v1/*` REST surface, completed under Phase 14.14. It documents what's locked-in good, what's fixed in this same phase, and what's deferred (with reasons).

The companion documents are:

- `docs/05-decisions.md` - the design decision log; this audit drops one entry there.
- `docs/06-security.md` - the V1 security posture (Phase 14.13).
- `apps/docs/pages/api-reference/errors.mdx` - the canonical `JunjoError.code` inventory (Phase 14.6).
- `docs/03-architecture.md` - the system-level architecture.

## Scope

Every route mounted under `/v1/*` in `packages/server/src/app.ts`. The audit excluded:

- `/admin/*` - dashboard-internal, not a public commitment.
- `/healthz` - operator-facing liveness probe (Phase 14.3).
- `/` (root) - liveness ping.

The framing question for each route was: "if a customer codes against this today and we change it tomorrow, is that a breaking change worth avoiding now?"

## Methodology

1. Read every route file under `packages/server/src/routes/`, every Zod schema co-located with it, and the test file (which encodes the contract).
2. Cross-reference against `apps/docs/pages/api-reference/*.mdx` to flag drift between docs and code.
3. Cross-reference thrown error codes against the canonical inventory in `apps/docs/pages/api-reference/errors.mdx`.
4. Categorize findings by severity:
   - **Severe** - breaking-change risk after launch; fix now.
   - **Moderate** - low-cost normalization, removes future friction.
   - **Minor** - document or accept.

## What is consistent (preserve these)

These are uniform across the V1 surface and worth defending in code review going forward.

| Pattern | Status |
|--|--|
| Error envelope `{ code, status, message }` | Uniform via `errorHandler` middleware. |
| Error codes are `snake_case` | No deviations. |
| Validation status is always 400 (`bad_request`) - no 422 | Pick-one principle in effect. |
| 401 vs 403 split | `invalid_api_key` is 401 (auth missing/wrong); `permission_denied` is 403 (auth ok, action refused). |
| 404 for "not found" or "cross-tenant collapse" | Used consistently; existence-leak avoidance is documented in code where intentional. |
| 409 for conflicts | `already_member`, `role_has_members`, `role_name_taken` all 409. |
| 410 for "gone but not 404" | `invitation_expired`, `invitation_used`, `restore_window_expired` - thoughtful split. |
| Idempotency on action POST/DELETE | Re-call returns current state with 200/204, not 409. Documented contract. |
| Field naming is camelCase across the wire | No `snake_case` leak. |
| Timestamps are ISO-8601 strings | Across every serializer; no numeric ms anywhere. |
| Pagination defaults | All paginated lists use `limit` default 50, max 100, optional opaque `cursor`. |
| Filter validation | Repeated-key style for arrays (`?actions=a&actions=b`); booleans are strict `"true"`/`"false"` strings (with one exception, see below). |

## Findings

### Severe (fixed in this phase)

**14.14-S1. `POST /v1/webhooks` returned 200 instead of 201.**

Every other create endpoint on `/v1/*` returns 201 (`POST /v1/groups`, `POST /v1/groups/:id/invitations`, `POST /v1/groups/:id/roles`, `POST /v1/invitations/:code/accept`). Webhook creation was the lone exception. The risk is that a downstream consumer that branches on exact status (rather than `2xx`) breaks the moment we normalize.

**Fix shipped.** `packages/server/src/routes/webhooks.ts` POST handler now returns 201. Tests updated. SDK is `res.ok`-based, so no SDK code change needed. API reference doc clarifies the status.

**14.14-S2. `GET /v1/webhooks` envelope omitted `nextCursor`.**

Every other list endpoint conforms to `Page<T> = { items, nextCursor }` from `packages/shared/src/types.ts`. Webhook list returned bare `{ items }`. The endpoint deliberately does not paginate today (the SDK comment notes "typical games have a handful of endpoints; adding pagination later is additive"), but adding `nextCursor: null` now makes that promise true: pagination becomes purely additive.

**Fix shipped.** `GET /v1/webhooks` now returns `{ items, nextCursor: null }`. SDK list type widened to read the new field (still ignored for now). Tests updated. API reference doc updated.

### Severe (deferred with rationale)

**14.14-S3. Soft `DELETE /v1/groups/:id` returns 200 with body; hard returns 204.**

Mixing 200 and 204 on the same DELETE based on a query flag is unusual. This was a deliberate choice (the soft-delete returns the now-soft-deleted resource so the caller can see the `softDeletedAt` stamp without a re-fetch); the hard-delete has nothing to return. The split is documented in the API reference and codified in tests.

**Why deferred.** Normalizing to 204 for both would force every caller that currently reads `softDeletedAt` from the soft-delete response to add a follow-up `GET`. Normalizing to 200+body for both would mean DELETE-then-fetch on hard delete (wasteful and racy). Both directions break callers; the current asymmetry, while irregular, is the least-bad answer.

**Action.** Document explicitly in `apps/docs/pages/api-reference/groups.mdx` that the DELETE response shape depends on `?hard=`. Audit closed; no code change.

**14.14-S4. `POST /v1/invitations/:code/decline` returns 204 while peer action endpoints return the affected resource.**

`accept` returns 201 + the new `Member`; the role-grant / role-assign / kick / leave action endpoints all return 200 + the affected resource. `decline` is the outlier (204).

**Why deferred.** `decline` doesn't create or modify a domain entity that the caller cares about - the invitation is now `used`, but the SDK has explicitly chosen not to surface used invitations as a return value (see `decline()` signature returning `void`). Returning the now-`used` invitation would be additive but has no caller use case. Inconsistency for inconsistency's sake is not worth the churn.

**Action.** Audit closed; no code change. The asymmetry is documented in `apps/docs/pages/api-reference/invitations.mdx` and reflected in the SDK return types.

### Moderate (deferred)

**14.14-M1. Path parameter naming: `:id` in the public surface, `:groupId` in admin.**

The public surface uses `:id` for the parent resource (`/v1/groups/:id/...`) while the admin surface uses `:groupId` (`/admin/games/:gameId/groups/:groupId/...`). The relationship endpoints additionally use `:a` / `:b` instead of `:groupAId` / `:groupBId`.

**Why deferred.** This is purely an internal Hono-handler-source rename. The wire URL paths a customer sees are unchanged regardless of what the server names them internally. There is no breaking-change risk; it is purely a code-readability win. Phase 14.7 (comment audit) deliberately stayed scope-bounded; this rename has the same gold-plating risk. Skipped per Phase 14 hard rule (must articulate user-facing benefit; "easier to read" alone is not enough).

**14.14-M2. `bulk-invite` does not validate `Content-Type`.**

`POST /v1/groups/:id/bulk-invite` reads `c.req.text()` regardless of content type. A JSON client that POSTs `{ users: [...] }` will silently get every line treated as a row name and emit `errors` for each. Documenting `Content-Type: text/csv` is in the docs; the server doesn't enforce it.

**Why deferred.** The current behavior degrades to 400 `bad_request` per malformed row anyway (the client will see the failure); the only difference is the error message clarity. Adding a content-type assertion is defensible but not breaking-change risk - the change can ship later without affecting any caller using the documented contract.

**14.14-M3. `GET /v1/groups/:id/audit` paginates with `?before=` rather than `?cursor=`.**

The audit endpoint uses an ISO timestamp cursor named `before`; every other paginated endpoint uses `cursor`. The cursor opacity is fine; the parameter name is the inconsistency.

**Why deferred.** Renaming `before` -> `cursor` is a wire-level change. The SDK at `packages/sdk/src/audit.ts` calls `?before=`, the server reads `?before=`, the docs say `before`, and the existing iteration tests are pinned to `before`. Renaming is a coordinated three-package change with no functional benefit (cursor opacity is preserved either way). Audit closed; documented as a known irregularity.

**14.14-M4. Boolean query coercion: strict in most places, lenient in one.**

`?mutual=true|false`, `?includeExpired=true|false`, `?includeUsed=true|false` all use Zod's `z.enum(["true", "false"])` and reject other values with 400. `?hard=true` on `DELETE /v1/groups/:id` uses an inline `=== "true"` check; any other value silently coerces to `false` (lenient).

**Why deferred.** The lenient `?hard=` coercion has shipped behavior that callers may rely on (e.g., a literal `?hard=1` would today be soft-delete; tightening would break that). The right move is to align all booleans on `z.enum(["true", "false"])` strict, but only as a deliberate breaking change in V2 with a release note.

### Minor (documented)

- `bulk-invite` returns an undocumented `{ invited, skipped, errors }` shape (not `Page<T>`, not the create-resource shape). Already documented in the dedicated doc page; kept as-is because the operation produces a *report*, not a single resource.
- `POST /v1/groups/:id/members/:userId/permissions/:permission` returns 404 with the message `"member not found"` even when the *group* is missing. This is intentional (no existence leak) and documented in the source as a comment.
- `GET /v1/users/:userId/members` returns a bare array (no `Page<T>` envelope) with a hard-cap of 1000 rows. This is intentional (a user is in a bounded number of groups; pagination buys nothing). Documented in `apps/docs/pages/api-reference/members.mdx`.

## Route inventory

The full route catalogue (used as the working base for this audit) lives in `apps/docs/pages/api-reference/`. The following table is a one-glance summary of every public route, its verb, and the error codes it can throw. If a code appears in the canonical inventory but no row references it, the inventory is incorrect and should be reconciled.

| Method | Path | Distinct error codes |
|--|--|--|
| GET | `/v1/whoami` | `invalid_api_key` |
| POST | `/v1/groups` | `bad_request` |
| GET | `/v1/groups` | `bad_request` |
| GET | `/v1/groups/:id` | `not_found` |
| PATCH | `/v1/groups/:id` | `bad_request`, `not_found` |
| DELETE | `/v1/groups/:id` | `not_found` |
| POST | `/v1/groups/:id/restore` | `not_found`, `restore_window_expired` |
| POST | `/v1/groups/:id/invitations` | `bad_request`, `not_found` |
| GET | `/v1/groups/:id/invitations` | `bad_request`, `not_found` |
| GET | `/v1/groups/:id/members` | `bad_request`, `not_found` |
| GET | `/v1/groups/:id/members/:userId` | `not_found` |
| POST | `/v1/groups/:id/leave` | `bad_request`, `not_found` |
| POST | `/v1/groups/:id/members/:userId/kick` | `bad_request`, `not_found` |
| PATCH | `/v1/groups/:id/members/:userId` | `bad_request`, `not_found` |
| POST | `/v1/groups/:id/bulk-invite` | `bad_request`, `not_found` |
| POST | `/v1/groups/:id/members/:userId/roles/:roleId` | `not_found`, `role_group_mismatch` |
| DELETE | `/v1/groups/:id/members/:userId/roles/:roleId` | `not_found` |
| POST | `/v1/groups/:id/members/:userId/permissions/:permission` | `bad_request`, `not_found` |
| DELETE | `/v1/groups/:id/members/:userId/permissions/:permission` | `bad_request`, `not_found` |
| GET | `/v1/groups/:id/members/:userId/permissions` | `not_found` |
| POST | `/v1/groups/:id/roles` | `bad_request`, `not_found`, `role_name_taken` |
| GET | `/v1/groups/:id/roles` | `not_found` |
| PUT | `/v1/groups/:a/relationships/:b` | `bad_request`, `not_found` |
| DELETE | `/v1/groups/:a/relationships/:b` | `bad_request`, `not_found` |
| GET | `/v1/groups/:a/relationships/:b` | `not_found` |
| GET | `/v1/groups/:a/relationships` | `not_found` |
| PUT | `/v1/groups/:id/parent` | `bad_request`, `not_found`, `parent_cycle` |
| GET | `/v1/groups/:id/children` | `not_found` |
| GET | `/v1/groups/:id/audit` | `bad_request`, `not_found` |
| GET | `/v1/invitations/:code` | `not_found` |
| DELETE | `/v1/invitations/:code` | `not_found` |
| POST | `/v1/invitations/:code/accept` | `bad_request`, `not_found`, `permission_denied`, `invitation_used`, `invitation_expired`, `already_member` |
| POST | `/v1/invitations/:code/decline` | `bad_request`, `not_found`, `permission_denied`, `invitation_used`, `invitation_expired` |
| GET | `/v1/members/:id` | `not_found` |
| GET | `/v1/users/:userId/members` | `bad_request` |
| GET | `/v1/roles/:id` | `not_found` |
| PATCH | `/v1/roles/:id` | `bad_request`, `not_found`, `role_name_taken` |
| DELETE | `/v1/roles/:id` | `not_found`, `role_has_members` |
| POST | `/v1/roles/:id/permissions` | `bad_request`, `not_found` |
| DELETE | `/v1/roles/:id/permissions/:permission` | `bad_request`, `not_found` |
| GET | `/v1/permissions/check` | `bad_request`, `not_found` |
| GET | `/v1/events/:groupId` | `not_found` |
| POST | `/v1/webhooks` | `bad_request` |
| GET | `/v1/webhooks` | (none beyond `invalid_api_key`) |
| PATCH | `/v1/webhooks/:id` | `bad_request`, `not_found` |
| DELETE | `/v1/webhooks/:id` | `not_found` |

Plus middleware-only error codes (`invalid_api_key`, `rate_limit_exceeded`, `invalid_admin_token`) reachable on every route. All codes match the canonical inventory at `apps/docs/pages/api-reference/errors.mdx`.

## Closing the audit

This phase shipped the two normalization wins where the cost was lowest and the breaking-change risk highest if deferred. The remaining findings are all either (a) wire-level renames whose only benefit is code-readability, or (b) intentional asymmetries that have shipped contracts and would force callers to migrate.

The V1 surface is launchable as documented today.
