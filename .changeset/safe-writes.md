---
"@junjo.io/shared": minor
"@junjo.io/sdk": minor
"@junjo.io/react": minor
---

Safe writes and import: retry-safe mutations, conditional writes, bulk membership import.

- **`Idempotency-Key`.** Every `POST` / `PUT` / `PATCH` / `DELETE` made with a per-game API key accepts it (1 to 255 printable ASCII characters), scoped to the key. A repeat with the same method, path, query and body returns the stored answer with `Idempotent-Replayed: true`; a different request with the same key answers `422 idempotency_key_reused`; a repeat while the first is still running answers `409 idempotency_key_in_progress` with `Retry-After: 1`. 5xx answers are not stored. Records last 24 hours; an in-progress record older than 5 minutes is treated as abandoned.
- **Member versions.** `Member.version` (starts at 1, rises by one with every write that changes the member, never on a no-op), also on member access and as `ETag` on member reads and member-scoped writes. `PATCH` member, role assign / unassign, override set / clear, kick and group ban / unban accept `If-Match` (`"7"` or `7`); a stale version answers `412 precondition_failed` and writes nothing.
- **Moderation versions.** A per-person counter that rises with every game ban create, change or lift. New `GET /v1/users/:userId/moderation` returns `{ userId, version, ban }`; game ban objects gain `version`; `POST /v1/bans` and `DELETE /v1/bans/:userId` accept `If-Match`.
- **Versions on events.** `member.joined`, `member.left`, `member.updated`, `member.banned`, `member.unbanned` and `role.changed` gain `memberVersion`; `game.user.banned` and `game.user.unbanned` gain `moderationVersion`.
- **`POST /v1/groups/:id/members/import`.** Up to 500 rows of `{ userId, roleIds?, overrides?, metadata? }` in one all-or-nothing transaction; present fields replace and absent fields are left alone (the group's default role is never assigned, as on the add route). Every failing row is listed in the error's new `details.rows`; `allowBanned` imports banned people without touching their bans. Re-running an identical import changes nothing.
- **Ban import fields.** `POST /v1/bans` accepts `bannedAt` (up to 60 seconds ahead) and a free-text `issuer`, returned on bans and ban history.
- **Lifts with nothing to lift.** `DELETE /v1/bans/:userId` and `DELETE /v1/groups/:id/members/:userId/ban` still answer `404 not_found`, now with `details: { reason: "not_active" }`, so a replayed lift can treat it as success.
- Override set accepts `{ value }` as an alias of `{ grant }`.
- `"nodes"` permission mode rejects keys with an empty segment (`a..b`, `.a`, `a.`), and refuses a switch to `"nodes"` while one is stored.
- The error envelope gains optional `details`. New error codes: `idempotency_key_reused` (422), `idempotency_key_in_progress` (409), `precondition_failed` (412).
