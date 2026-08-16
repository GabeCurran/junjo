---
"@junjo.io/shared": minor
"@junjo.io/sdk": minor
"@junjo.io/react": minor
---

Hierarchical permission checks, batched checks, and direct member provisioning.

Addresses integrator feedback where two separate codebases hit the same gaps and wrote the same workarounds.

- **`inherit` on permission checks.** `can` / `check` accept `{ inherit: true }` to resolve against a group's parents, nearest first, stopping at the first group that decides. The result carries `viaGroupId`, naming the group the decision came from. Replaces the client-side walker a hierarchy otherwise forces, which costs two round-trips per level and pays that cost in full on every denial. Off by default; existing checks are unchanged.
- **`checkBatch(checks, opts?)`.** Resolves up to 100 checks per request, answered positionally. Cached entries are served locally and only the remainder is sent; longer inputs are split across sequential requests automatically. React gets `useCanMany`, which shares the cache `useCan` uses.
- **`members.add(groupId, userId, opts?)`.** Adds a user to a group directly, ignoring the group's `visibility`. Provisioning no longer has to make internal authorization groups publicly joinable, or run the two-call invitation handshake, to populate them. Idempotent, assigns an optional `roleId` in the same transaction, and still refuses banned users.
- **`groups.list({ kind })`.** Server-side exact-match filter on group kind. A group's `name` is unique per game but not per kind, so filtering client-side by name alone can silently pick the wrong group.
- **`roles.list` now returns a page as well as an array.** The result is `Role[] & Page<Role>`: array methods keep working exactly as before, and `items` / `nextCursor` are now available so page-shaped helpers apply across every list call. Non-breaking; the wire default is unchanged and the SDK accepts either server shape.
- **Client-side permission cache, on by default.** A 5 second TTL over `can` / `check` / `checkBatch`, plus serving a recently-expired answer through a `429` instead of throwing. Realtime apps re-resolve the same permissions for every subscriber on reconnect, and that burst exhausts the rate limit in a way that reads as an authorization bug rather than a throttling one. Configure or disable via `permissionCache` on the client; clear it with `clearPermissionCache()`.
