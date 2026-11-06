---
"@junjo.io/shared": minor
"@junjo.io/sdk": minor
---

A game's permission settings are readable with its own API key, and changes reach followers live.

- **Role graph carries `contexts`.** `GET /v1/groups/:id/role-graph` and `roles.getGraph` gain a top-level `contexts`: the game's context value inheritance (`permissions.contexts`, values folded), `{}` when none. `RoleGraph` gains the field; the SDK reads an absent field from an older server as `{}`.
- **`GET /v1/permissions/config`.** Returns `{ mode, contexts }` for the calling game, with the `Junjo-Stream-Position` header. Also served on the admin as-game mount. New `PermissionConfig` type and `junjo.permissions.config()`.
- **`permissions.config.updated` event.** `PATCH /v1/admin/games/:gameId/config` emits it, with the new `mode` and `contexts`, only when the resolved mode or context inheritance changes. It is staged in the config write's transaction, so it takes a game stream position and reaches webhooks; it has no `groupId`, so group streams do not carry it. `PermissionsConfigUpdatedEvent` joins the `JunjoEvent` union and webhook endpoints can subscribe to it.
