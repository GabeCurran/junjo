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
