---
"@junjo.io/sdk": minor
---

Create-only member adds.

- **Server.** `POST /v1/groups/:id/members` honours `If-None-Match: *`. When the person already has a membership row in the group in any status (active, left, kicked, invited or banned, under any of their linked ids), the add writes nothing and answers `412 precondition_failed`; the message names the row's status, `details.memberStatus` carries it, and `ETag` carries the existing member's version. Without a row the add runs exactly as before. Any other `If-None-Match` value answers `400 bad_request`. The check runs inside the add's transaction, so two concurrent create-only adds of one person produce one `201` and one `412`. Bans and group or role errors are still answered first; kind limits are not evaluated on a `412`.
- **TypeScript SDK.** `members.add(groupId, userId, { ifNoneMatch: "*" })` sends the header. New exported type `CreateOnlyWriteOptions`.
- **Java SDK.** `WriteOptions.withIfNoneMatchAny()` (new record component `ifNoneMatch`, constant `WriteOptions.ANY`), `QueuedWrite.addMemberIfAbsent(...)` and `QueuedWrite.ifNoneMatchAny()`. A queued create-only add that finds an existing membership is reported through `onConflict` and not retried.
