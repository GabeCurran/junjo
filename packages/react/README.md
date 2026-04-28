# @junjo/react

React hooks built on `@junjo/sdk`. Optimistic updates and automatic SSE subscription lifecycle.

```tsx
import { JunjoProvider, useGroup, useCan } from "@junjo/react";

function GuildPanel({ groupId }: { groupId: string }) {
  const { group, members } = useGroup(groupId);
  const canInvite = useCan(groupId, "invite_member");
  return null;
}
```
