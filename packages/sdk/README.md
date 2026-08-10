# @junjo.io/sdk

Junjo's TypeScript client. Works in Node and the browser. Uses built-in `fetch`. One runtime dependency: `@junjo.io/shared`, the contract types shared with the server. The `@junjo.io/sdk/adapters` entry bundles `jose` for local JWT verification, so nothing extra is installed at runtime.

```ts
import { Junjo } from "@junjo.io/sdk";
import { clerkAdapter } from "@junjo.io/sdk/adapters";

const junjo = new Junjo({
  apiKey: process.env.JUNJO_API_KEY!,
  authAdapter: clerkAdapter(clerkInstance),
});

const allowed = await junjo.can(userId, groupId, "invite_member");
```

See `src/index.ts` for the full surface.

## Errors and retries

Every failure throws `JunjoError`. The SDK never retries automatically;
branch on `err.code` and decide yourself:

- Server rejections carry the server's envelope code (`not_found`,
  `permission_denied`, `banned`, `rate_limit_exceeded`, ...).
- On `rate_limit_exceeded`, honor `err.retryAfterSeconds` in your own
  backoff before retrying.
- Transport failures use SDK-side codes: `network_error` (fetch itself
  rejected; the request may or may not have reached the server),
  `timeout` (the configured or per-request `timeoutMs` elapsed), and
  `cancelled` (your `AbortSignal` aborted the request).

Keep a default branch when switching on `err.code`: newer servers can
send codes an older SDK does not know.

## Bundle size

```bash
npm run build -w @junjo.io/sdk
npm run size  -w @junjo.io/sdk
```

The limits live in `package.json#size-limit`. They check `dist/index.js` and
`dist/adapters/index.js` against their current brotli size, so an accidental
dependency shows up as a failed build. If you need to raise a limit, say what
the extra bytes bought in the commit message.
