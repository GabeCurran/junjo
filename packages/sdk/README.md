# @junjo/sdk

Junjo's TypeScript client. Works in Node and the browser. Uses built-in `fetch`; zero runtime dependencies.

```ts
import { Junjo } from "@junjo/sdk";
import { clerkAdapter } from "@junjo/sdk/adapters";

const junjo = new Junjo({
  apiKey: process.env.JUNJO_API_KEY!,
  authAdapter: clerkAdapter(clerkInstance),
});

const allowed = await junjo.can(userId, groupId, "invite_member");
```

See `src/index.ts` for the full surface.

## Bundle size

```bash
npm run build -w @junjo/sdk
npm run size  -w @junjo/sdk
```

Limits are committed in `package.json#size-limit` and gate the `dist/index.js`
and `dist/adapters/index.js` entries against their measured brotli baseline.
Bumping a limit is a deliberate decision (see the Phase 14.9 entry in
`docs/05-decisions.md`).
