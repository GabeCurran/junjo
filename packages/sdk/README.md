# @junjo-io/sdk

Junjo's TypeScript client. Works in Node and the browser. Uses built-in `fetch`; zero runtime dependencies.

```ts
import { Junjo } from "@junjo-io/sdk";
import { clerkAdapter } from "@junjo-io/sdk/adapters";

const junjo = new Junjo({
  apiKey: process.env.JUNJO_API_KEY!,
  authAdapter: clerkAdapter(clerkInstance),
});

const allowed = await junjo.can(userId, groupId, "invite_member");
```

See `src/index.ts` for the full surface.

## Bundle size

```bash
npm run build -w @junjo-io/sdk
npm run size  -w @junjo-io/sdk
```

Limits are committed in `package.json#size-limit` and gate the `dist/index.js`
and `dist/adapters/index.js` entries against their measured brotli baseline.
Bumping a limit is a deliberate decision; the commit that raises the limit
should also justify why the new bytes are worth it.
