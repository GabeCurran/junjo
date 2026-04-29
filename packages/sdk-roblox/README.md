# junjo-roblox

Luau client for Junjo. Distributed via the Roblox marketplace and as a `.rbxm` model on each GitHub release. Not on npm. Wraps `HttpService` and (post-V1) `MessagingService`.

## What ships today (Phase 8.1)

The `Junjo.new(config)` factory and the HTTP wrapper. The wrapper auto-encodes JSON request bodies, parses JSON responses, throws `JunjoError`-shaped Lua errors on non-2xx (`{ name, message, code, status }`), and threads `HttpService:GetSecret` results through the `Authorization` header without exposing the secret to Lua.

```lua
local Junjo = require(ReplicatedStorage.Junjo)

local junjo = Junjo.new({
  apiKey = game:GetService("HttpService"):GetSecret("JUNJO_API_KEY"),
  -- baseUrl = "https://api.junjo.io", -- default
})

local group = junjo.http:post("/v1/groups", {
  kind = "guild",
  name = "Crimson Wolves",
  defaultRoleId = "member",
})

local allowed = (junjo.http:get(
  "/v1/permissions/check?userId=" .. player.UserId
    .. "&groupId=" .. group.id
    .. "&permission=invite_member"
)).allowed
```

The HTTP wrapper is intentionally thin so the eventual namespace methods (Phase 8.2) layer on top of `junjo.http` rather than replacing it.

## What lands in Phase 8.2

Per-namespace methods that mirror the TypeScript SDK:

```lua
local group = junjo.groups:create({
  name = "Crimson Wolves",
  kind = "clan",
  defaultRoleId = "member",
})

local allowed = junjo:can(player.UserId, group.id, "invite_member")
```

## What lands in Phase 8.3

`Junjo.RobloxUserIdAdapter()` for the in-Roblox half of an auth-adapter integration. The Node-side counterpart (a Roblox-game-server-to-Junjo-backend recipe) is documented in [`apps/docs/pages/auth/byo.mdx`](../../apps/docs/pages/auth/byo.mdx#recipe-3-roblox-localplayeruserid-phase-83-in-the-roadmap).

## What is NOT planned for V1

`HttpService` does not stream, so `groups.subscribe` (the SSE wrapper from the TypeScript SDK) is not mirrored on Roblox V1. The replacement on Roblox is `MessagingService`-backed cross-server delivery, deferred post-V1.

Dogfood target: the `mobarena-roblox` project. Source lives in `src/Junjo.lua`. Full reference at [`apps/docs/pages/roblox/index.mdx`](../../apps/docs/pages/roblox/index.mdx).
