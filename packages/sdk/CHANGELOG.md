# @junjo.io/sdk

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
