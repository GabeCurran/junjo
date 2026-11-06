---
"@junjo.io/shared": minor
"@junjo.io/sdk": minor
"@junjo.io/react": minor
---

Sanctions, group kind limits, display names and game export.

- **Sanctions.** Game-wide restrictions on a person, with a type your game defines (`^[a-z0-9][a-z0-9_.-]{0,31}$`; `ban` is reserved). `POST /v1/sanctions` creates (`201`) or replaces (`200`) the person's sanction of a type; an identical repeat changes nothing. `DELETE /v1/sanctions/:userId/:type` lifts it, answering `404` with `details.reason: "not_active"` when nothing is active. `GET /v1/sanctions`, `GET /v1/users/:userId/sanctions` and `GET /v1/users/:userId/sanctions/history`. Sanctions share the moderation version with bans, accept `If-Match`, expire lazily, and appear as `sanctions` on `GET /v1/users/:userId/moderation`. New events `game.user.sanctioned` and `game.user.unsanctioned` (the sanction type is `sanctionType`), and audit actions of the same names.
- **Group kind limits.** Game config `groups.kinds` sets, per group kind, `maxMembers`, `maxPerUser`, `deleteWhenEmpty` and `idleDeleteHours`. Over a cap, join, add, invitation accept and import answer the new `409 group_full` or `409 group_limit_reached` (import rows carry those codes in `details.rows`). Empty or idle groups of such kinds are soft-deleted with `group.deleted`. Kinds that are not listed behave as before.
- **Display names.** `PUT /v1/users/:userId/display-name` sets a name on one id and emits the new `identity.updated` event. Members, member access and friends list entries gain a person-level `displayName`; identity list items carry each id's own name. `GET /v1/identities/by-name` finds ids by name, ignoring case.
- **Game export.** `GET /v1/export` streams the whole game as NDJSON (header, records by kind, end line with counts) for keys with the new `canExport` flag, set on the admin API key routes and in the dashboard. Credentials are never exported.
