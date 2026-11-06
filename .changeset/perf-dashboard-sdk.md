---
"@junjo.io/sdk": minor
"@junjo.io/react": minor
---

Fewer duplicate requests and steadier streams in the SDK and the React hooks.

- **Concurrent permission checks share one request.** While the permission cache is on, `check` and `can` calls for the same check that overlap share one request instead of each sending their own. A call's own `signal` or `timeoutMs` ends only that call's wait; the request keeps running for the other callers and is aborted once every caller has stopped waiting. `clearPermissionCache()` also detaches checks in flight, so their answers no longer fill the cache.
- **`checkBatch` sends a repeated check once.** A check repeated within one call is sent once, and its answer fills every position that asked for it.
- **Game event reconnect backoff no longer resets on a bare connect.** The `attempt` count starts over once a reconnected stream delivers a frame or stays open for 10 seconds. A stream that drops right after opening now keeps backing off instead of reconnecting at the initial delay forever.
- **Group streams outlive a quick remount.** The provider's subscription hub closes a group stream one second after its last hook unmounts. A hook that attaches within that second, such as a remount, a move between views of the same group, or StrictMode's double-invoked effects, reuses the open stream.
- **`useGroup` and `useMembers` subscribe before they fetch.** The stream opens alongside the fetch instead of after it. Events and stream errors that arrive while a fetch is in flight are held and applied on top of the fetch result, so none is lost or overwritten by the snapshot.
- **Stable values across renders.** `useCan` no longer resubscribes to the permission cache on every render, and the list hooks over user-scoped reads return one shared empty list while they have no data.
