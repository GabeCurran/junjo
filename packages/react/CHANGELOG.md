# @junjo.io/react

## 0.2.0

### Minor Changes

- faee06d: New hooks, shared live subscriptions, and server-side filtering.

  - New hooks: `useRoles`, `useBans`, and `useGroups` round out the surface alongside the existing group, members, invitations, and friends hooks.
  - Live event subscriptions are now shared: hooks watching the same group reuse one SSE stream through a refcounted subscription hub instead of opening one connection per hook. A stream the server ends cleanly surfaces as `JunjoStreamClosedError` (check with `isStreamClosedError`) so consumers can resubscribe deliberately.
  - Member and invitation lists filter server-side instead of client-side, and member lists page: `membersHasMore` and `fetchMoreMembers` expose cursor pagination.
  - Ban events are applied to member state as they arrive, and in-flight responses from a previous query can no longer clobber the state of a newer one.

### Patch Changes

- 1902ebe: Resolve the workspace copy of `@junjo.io/sdk` instead of a stale registry version, and use explicit brand casts for the branded id types.
- Updated dependencies [1902ebe]
- Updated dependencies [1902ebe]
  - @junjo.io/sdk@0.2.0
  - @junjo.io/shared@0.2.0
