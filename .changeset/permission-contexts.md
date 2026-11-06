---
"@junjo.io/shared": minor
"@junjo.io/sdk": minor
"@junjo.io/react": minor
---

Contexts on permission entries: role entries and member overrides that apply only in a given context, such as one world.

- **Entries and overrides take `context`.** `PermissionEntry` and `MemberPermissionOverride` gain an optional `context` (key to value, for example `{ "world": "creative" }`). Keys match `^[a-z][a-z0-9_]{0,31}$`, at most 2 per entry; values are 1 to 64 characters with no control characters, folded to ASCII lowercase on write and on check in both permission modes. `{}` or no context means global. An entry is identified by its key and its context, so one role can hold a key globally and per context.
- **Writes.** `PUT /v1/roles/:id/entries` accepts `context` on each entry and requires each `(permission, context)` pair to be unique. `POST /v1/roles/:id/permissions` and `POST /v1/groups/:id/members/:userId/permissions/:permission` accept `context`; their `DELETE` routes select a contextual entry or override with `context.<key>=<value>` query parameters and target the global one without them. Import rows' `overrides` accept `context`. The admin mirrors accept the same. Contextual entries count toward the 5,000-entry cap.
- **Checks.** `GET /v1/permissions/check` (and the admin check) takes `context.<key>=<value>` query parameters, and `POST /v1/permissions/check-batch` an optional `context` per entry. `PermissionCheckResult` gains an optional `context`: the deciding entry's folded context, omitted when a global entry decided. Checks without a context see only global entries and get the same answers as before.
- **Precedence.** Layer first, as before (the member's overrides, then held roles, then parents). Inside the deciding layer: the most matched context keys, then the nearest inherited context, then key specificity, then deny.
- **Context inheritance.** The game config gains `permissions.contexts`: context key to `{ inherit: { value: [parentValue, ...] } }`, replaced as a whole on `PATCH`. Inheritance is transitive and ranked by distance; a cycle, a chain deeper than 16, more than 256 values per key or more than 8 parents per value is refused with `400 bad_request`.
- **Reads.** Role reads, the role graph, member access, override lists and the export carry `context` on contextual entries and overrides. `Role.permissions` lists global grants only.
- **Events.** `permission.granted` and `permission.revoked` keep describing global entries only; any contextual entry change emits `role.updated` with `changed: ["entries"]`. Override changes emit `member.updated` with `overrides`, as before.
- The conformance vectors gain context cases, `contextConfigs` and `entryContexts`; the format is documented in `packages/shared/conformance/README.md`.
