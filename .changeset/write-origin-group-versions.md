---
"@junjo.io/shared": minor
"@junjo.io/sdk": minor
---

Event origin, group versions, actors on group writes, export filters and group batches.

- **Event origin.** Every event carries `origin: { apiKeyId, tag }`: the per-game key whose request caused it (null for admin writes and server jobs) and the request's `Junjo-Write-Tag` header (1 to 128 printable ASCII characters, no spaces; a malformed tag is a `400` and nothing is written). A writer that keeps its own copy of the data uses it to skip the events its own writes caused.
- **Group versions.** A group's version is the stream position of the latest event about the group or anything in it (members, roles, permissions, invitations, and relationships where it is the A side), as a decimal string; "0" until its first event. Single-group responses (get, create, update, soft delete, restore) carry `version` and `ETag`. `PATCH` and `DELETE /v1/groups/:id` accept `If-Match`; a stale version answers `412 precondition_failed` with `details.version` and writes nothing. The check runs while the game's event counter is locked, so of several writers with one version exactly one wins. Export group records carry `version`.
- **Actors.** Optional `actorUserId` on kick (sets `kickedBy` on `member.left`), group update (body), group delete and relationship clear (query), and relationship set (body, also recorded as `setBy`). Audit rows name the actor; `group.updated`, `group.deleted` and `group.relationship.changed` gain `actorUserId`.
- **Export filters.** `GET /v1/export?records=...&groupKinds=...` limits the record kinds and the group kinds exported; the header echoes both.
- **Group batches.** `POST /v1/groups/:id/batch` applies up to 50 writes to one group in one transaction, all or none, optionally on `If-Match` with the group's version. Each op behaves as its single route (same audit, events and limits); a failing op fails the batch with its error and `details.opIndex`. The response carries the new version and each op's result.
- **TypeScript SDK.** `new Junjo({ writeTag })` and per-write `writeTag`; `event.origin` (type `EventOrigin`); `Group.version`; `ifMatch` on `groups.update` and `groups.delete`; `actorUserId` on `groups.update`, `groups.delete`, `groups.kick`, `groups.setRelationship` and `groups.clearRelationship`; `junjo.export({ records, groupKinds })`; `groups.batch(groupId, ops, { ifMatch })` with types `GroupBatchOp`, `GroupBatchResponse`, `GroupBatchResult`.
- **Java SDK.** Parity with the TypeScript groups API (update, delete, restore, relationships, invitations, join, leave, ban history, parent and children), `InvitationsApi`, write tags on `WriteOptions` and the client builder, `JunjoEvent.origin()`, actors on group events, `Group.version()`, and export filters.
