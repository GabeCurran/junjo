# Junjo - V2+ ideas (parking lot)

**This file is intentionally NOT part of the V1 doc sequence (`01-product.md` through `05-decisions.md`).** The autonomous loop is scoped to those five docs plus VISION.md / PROGRESS.md and will not read this file. Items here are explicitly out of V1 scope. Move an item into VISION.md only when V1 has shipped and the item is greenlit for the next major version.

---

## Friends (per-game user-to-user social graph)

**Status:** parked, not in V1.

**One-line shape:** a per-`gameId` user-to-user social graph (request / accept / decline / unfriend / block) built additively on top of the existing identity model. Same shape as `groups` but operating on user pairs instead of group pairs.

**Why it's parked:**
- V1 needs to ship before scope creep slows it down. Validate the groups/ranks/permissions value prop with real users first.
- Friends compete with platform-native social graphs (Steam / Discord / PSN / Roblox friends). Devs are more likely to want "sync my Discord friends into Junjo" than "build a new friends list inside Junjo." Confirm the actual ask before building the feature.
- Operationally adjacent (we already model identity + relationships) but UX-distinct (bilateral consent, blocking semantics, online-presence push).

**Sketch (when it lands):**

- **Schema additions** (always present in Prisma; runtime-gated):
  - `Friendship { id, gameId, userAId, userBId, status (pending|accepted), createdAt, acceptedAt? }`. Canonical-order the pair (smaller id is `userAId`) so `(gameId, userAId, userBId)` is unique without two-row mirroring.
  - `FriendBlock { id, gameId, blockerId, blockedId, createdAt }` - separate table for cleaner permission checks (a block always wins over a pending request).
  - Per-`gameId` scoping matches the existing isolation model. A user can have different friends per game.

- **Open-core "addon" semantics:** schema is global (Prisma can't have optional schemas), but the feature is gated three ways:
  1. **Server runtime flag**: `JUNJO_FRIENDS_ENABLED=true` (default false). Routes return 501 `{ code: "feature_disabled" }` when off; tables exist but stay empty. Standard open-core "optional feature" pattern (see GitLab, Sentry).
  2. **SDK tree-shaking**: devs who never `import { friends }` from the SDK don't pay the bundle cost. Free with the existing namespace pattern.
  3. **Dashboard toggle**: hide the Friends UI when the flag is off. Admins can enable / disable per deployment.

- **SDK surface** (`packages/sdk/src/friends.ts`, sub-namespace pattern):
  - `friends.request(otherUserId)`
  - `friends.accept(requestId)`, `friends.decline(requestId)`, `friends.cancel(requestId)`
  - `friends.unfriend(otherUserId)`
  - `friends.list({ status?: "pending" | "accepted" | "incoming" | "outgoing" })`
  - `friends.block(userId)`, `friends.unblock(userId)`
  - `friends.areFriends(a, b)` -> boolean

- **Server routes** under `/v1/friends/*`, gated by the runtime flag. JunjoError shape preserved for failures.

- **Events** via the existing `eventHub`: `friend.requested`, `friend.accepted`, `friend.declined`, `friend.removed`, `friend.blocked`. Fire alongside webhooks like every other mutation.

- **React hooks** (`packages/react/src/`): `useFriends()`, `useFriendRequests()`, mutation hooks via the existing `useMutation` primitive (so optimistic updates work the same way).

- **Dashboard surface**: a Friends tab on the user-detail view. Hidden when `JUNJO_FRIENDS_ENABLED` is false.

- **Estimated scope:** 4-6 loop iterations (1 schema/migration + 1-2 server routes + 1 SDK + 1 React + 1 dashboard + 1 docs). Probably $25-50 in tokens at current iter cost.

**Done criteria (when promoted to a real phase):**

- All friend mutations emit JunjoEvents and webhooks consistent with other mutations.
- Block always wins: blocker cannot receive requests from blocked, blocked cannot send requests to blocker, existing friendship is severed on block.
- Per-game isolation enforced: a friendship in game A is invisible from game B, even with the same `userId`.
- Cloud and self-host docs cover both the enabled and disabled state.
- Tests: happy + at least one error case for every mutation, plus integration tests for the block-wins-over-pending-request semantics and per-game isolation.

---

## Other ideas

(Add new items here. Keep each one in the same shape: status, one-line shape, why parked, sketch, done criteria.)
