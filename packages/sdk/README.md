# @junjo.io/sdk

Junjo's TypeScript client. Works in Node and the browser. Uses built-in `fetch`; zero runtime dependencies.

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

## Bundle size

```bash
npm run build -w @junjo.io/sdk
npm run size  -w @junjo.io/sdk
```

The limits live in `package.json#size-limit`. They check `dist/index.js` and
`dist/adapters/index.js` against their current brotli size, so an accidental
dependency shows up as a failed build. If you need to raise a limit, say what
the extra bytes bought in the commit message.
