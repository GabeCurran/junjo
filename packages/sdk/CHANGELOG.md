# @junjo.io/sdk

## 0.3.0

### Minor Changes

- 4a7075b: Hierarchical permission checks, batched checks, and direct member provisioning.

  Addresses integrator feedback where two separate codebases hit the same gaps and wrote the same workarounds.

  - **`inherit` on permission checks.** `can` / `check` accept `{ inherit: true }` to resolve against a group's parents, nearest first, stopping at the first group that decides. The result carries `viaGroupId`, naming the group the decision came from. Replaces the client-side walker a hierarchy otherwise forces, which costs two round-trips per level and pays that cost in full on every denial. Off by default; existing checks are unchanged.
  - **`checkBatch(checks, opts?)`.** Resolves up to 100 checks per request, answered positionally. Cached entries are served locally and only the remainder is sent; longer inputs are split across sequential requests automatically. React gets `useCanMany`, which shares the cache `useCan` uses.
  - **`members.add(groupId, userId, opts?)`.** Adds a user to a group directly, ignoring the group's `visibility`. Provisioning no longer has to make internal authorization groups publicly joinable, or run the two-call invitation handshake, to populate them. Idempotent, assigns an optional `roleId` in the same transaction, and still refuses banned users.
  - **`groups.list({ kind })`.** Server-side exact-match filter on group kind. A group's `name` is unique per game but not per kind, so filtering client-side by name alone can silently pick the wrong group.
  - **`roles.list` now returns a page as well as an array.** The result is `Role[] & Page<Role>`: array methods keep working exactly as before, and `items` / `nextCursor` are now available so page-shaped helpers apply across every list call. Non-breaking; the wire default is unchanged and the SDK accepts either server shape.
  - **Server compatibility.** Every item above needs a server built from this release or later. Against an older server, `checkBatch` and `members.add` fail with `not_found` (the routes do not exist), and `{ inherit: true }` is silently ignored, returning the direct answer rather than erroring, because the server drops unknown query parameters. Junjo Cloud runs the current server; if you self-host, upgrade the server before or alongside the SDK. `roles.list` is the exception and works against any server version.
  - **Client-side permission cache, on by default.** A 5 second TTL over `can` / `check` / `checkBatch`, plus serving a recently-expired answer through a `429` instead of throwing. Realtime apps re-resolve the same permissions for every subscriber on reconnect, and that burst exhausts the rate limit in a way that reads as an authorization bug rather than a throttling one. Configure or disable via `permissionCache` on the client; clear it with `clearPermissionCache()`.

### Patch Changes

- Updated dependencies [4a7075b]
  - @junjo.io/shared@0.3.0

## 0.2.0

### Minor Changes

- 1902ebe: Typed transport errors and a hardened request surface.

  - Transport failures now throw `JunjoError` with dedicated codes: `network_error` when fetch itself rejects, `timeout` when the configured or per-request timeout elapses, and `cancelled` when the caller's `AbortSignal` aborts. The abort stays armed through body consumption, so a stalled response body surfaces as a timeout instead of hanging.
  - Every request-making method accepts `signal` and `timeoutMs` in its options; the client-level `timeoutMs` (default 30000, 0 disables) can be overridden per request. SSE subscriptions are exempt from timeouts by design.
  - 429 responses surface the `Retry-After` header as `err.retryAfterSeconds`. The SDK never retries automatically.
  - `JunjoError.code` is now the typed `JunjoErrorCode` union (server envelope codes plus SDK codes); `JUNJO_SDK_ERROR_CODES`, `JunjoErrorCode`, and `JunjoSdkErrorCode` are exported from the entrypoint.
  - New `verifyToken` (renames `whoami`, which remains as a deprecated alias) and `keyInfo` (GET /v1/whoami) methods.
  - `groups.subscribe` accepts `onClose`, fired when the server ends the stream cleanly so consumers can resubscribe instead of holding a silently dead subscription. A pre-aborted `signal` rejects with code `cancelled`; a mid-stream abort now runs full cleanup.
  - New async iterators: `webhooks.endpoints.listAll`, `friends.listAll`, and `audit.listAll` (pages via the audit `before` cursor).
  - `verifyWebhookWithMeta` (and `webhooks.verifyWithMeta`) accepts `onUnknownType: "raw"` to return a verified delivery of an event type this SDK version does not know as an `UnknownVerifiedWebhook` (`event: null`, `eventType`, verbatim `payload`) instead of throwing `unknown_event_type`. The default remains `"throw"`. Match-all endpoints should opt in so server-side event additions cannot turn a receiver into a retry loop.
  - Breaking: `webhooks.endpoints.list` is now cursor-paginated and returns `Page<WebhookEndpoint>` ({ items, nextCursor }) instead of a plain array.
  - Breaking: `groups.inviteByLink` throws `JunjoError` code `invalid_config` when `inviteBaseUrl` is not configured, instead of minting a dead URL against the API origin.
  - The `jose` dependency is now bundled into the `/adapters` entry so `require()` of the CJS build works on Node 20.0-20.18 (jose v6 is ESM-only). `jwtAdapter` warns once when constructed with an HS256 shared secret in a browser.
  - Expanded JSDoc across the surface and an explicit `engines` field (Node >= 20).

### Patch Changes

- Updated dependencies [1902ebe]
  - @junjo.io/shared@0.2.0
