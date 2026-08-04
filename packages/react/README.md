# @junjo.io/react

React hooks built on `@junjo.io/sdk`. Optimistic updates and automatic SSE subscription lifecycle.

```tsx
import { JunjoProvider, useGroup, useCan } from "@junjo.io/react";

function GuildPanel({ groupId }: { groupId: string }) {
  const { group, members } = useGroup(groupId);
  const canInvite = useCan(groupId, "invite_member");
  return null;
}
```

## Security

React trees usually run in a browser, and the per-game `jk_` API key is a full-control secret: never construct the client with it in a client bundle, and never expose it via `NEXT_PUBLIC_` / `VITE_` env vars (those are inlined into the bundle every visitor downloads). Browser apps use proxy mode:

```ts
import { Junjo } from "@junjo.io/sdk";

// The browser holds no credential. Your backend forwards /api/junjo/*
// to https://api.junjo.io, injects `authorization: Bearer <jk_ key>`,
// and enforces per-user authorization as it forwards.
const junjo = new Junjo({ proxy: true, baseUrl: "/api/junjo" });
```

Server-rendered trees can construct with `apiKey: process.env.JUNJO_API_KEY` (a server-only variable) instead. Full setup, including a copy-paste Next.js proxy handler, lives in the docs: https://docs.junjo.io/react/provider
