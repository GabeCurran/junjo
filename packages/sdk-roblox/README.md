# junjo-roblox

Luau client for Junjo. Distributed via the Roblox marketplace and as a `.rbxm` model on each GitHub release. Not on npm. Wraps `HttpService` and (post-V1) `MessagingService`.

## What ships today (Phase 8.1 + 8.2 + 8.3)

The `Junjo.new(config)` factory, the HTTP wrapper, per-namespace methods that mirror the TypeScript SDK (`groups`, `members`, `roles`, `invitations`, `audit`, `webhooks.endpoints`), the top-level `junjo:can(...)` / `junjo:check(...)` permission helpers, and the built-in `Junjo.RobloxUserIdAdapter` for resolving a Roblox `Player` to the opaque-string user id Junjo persists.

```lua
local Junjo = require(ReplicatedStorage.Junjo)

local junjo = Junjo.new({
  apiKey = game:GetService("HttpService"):GetSecret("JUNJO_API_KEY"),
  -- baseUrl = "https://api.junjo.io", -- default
})
local userIds = Junjo.RobloxUserIdAdapter()

local group = junjo.groups:create({
  kind = "guild",
  name = "Crimson Wolves",
  defaultRoleId = "member",
})

local invitation = junjo.groups:inviteByUserId(group.id, userIds:resolve(player))

local allowed = junjo:can(userIds:resolve(player), group.id, "invite_member")
```

The HTTP wrapper stays exposed as `junjo.http` for routes that pre-date the namespace methods (or routes the SDK never wraps), so the namespace methods are a layer on top, not a replacement.

The Node-side counterpart to `RobloxUserIdAdapter` (a Roblox-game-server-to-Junjo-backend recipe) is documented in [`apps/docs/pages/auth/byo.mdx`](../../apps/docs/pages/auth/byo.mdx#recipe-3-roblox-localplayeruserid-phase-83-in-the-roadmap).

## What is NOT planned for V1

`HttpService` does not stream, so `groups.subscribe` (the SSE wrapper from the TypeScript SDK) is not mirrored on Roblox V1. The TS SDK's webhook receiver helpers (`junjo.webhooks:verify(...)` and `junjo.webhooks:middleware(...)`) are also not mirrored, since a Roblox game server cannot expose an HTTP endpoint and is therefore never a webhook receiver. The `MessagingService`-backed cross-server delivery replacement is deferred post-V1.

Dogfood target: the `mobarena-roblox` project. Source lives in `src/init.lua` plus per-namespace siblings (`groups.lua`, `members.lua`, etc.) plus the adapter under `src/adapters/RobloxUserId.lua`. Full reference at [`apps/docs/pages/roblox/index.mdx`](../../apps/docs/pages/roblox/index.mdx).
