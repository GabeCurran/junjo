# Junjo.io SDK for Roblox

Luau client for the [Junjo.io](https://junjo.io) API: groups, members, roles, invitations, audit, webhooks, bans, and friends for Roblox games. It runs in game servers (server `Script`s), wraps `HttpService` for outbound REST calls, and mirrors the TypeScript SDK's config shape and namespace surface. It is distributed as a `Junjo.rbxm` model attached to GitHub releases, not on npm.

## Installation

From source with Rojo (the available path today; no `roblox-v*` release has shipped yet): the module root is `src/init.lua` and `default.project.json` builds the source tree as a single `ModuleScript` named `Junjo`. Point your own Rojo project at `packages/sdk-roblox/src` (or build the model yourself; see Building below) and mount it under a server-only container such as `ServerStorage`.

From a GitHub release, available starting with the first release tagged `roblox-vX.Y.Z`:

1. Download `Junjo.rbxm` from the release.
2. Insert it into `ServerStorage` (or `ServerScriptService`) in Roblox Studio.

Either way, enable **Allow HTTP Requests** in Game Settings > Security.

> **Warning:** Never place the module or your API key in `ReplicatedStorage` or any other container that replicates to clients. The per-game `jk_` key grants full control of your game's Junjo data; a client that can read it can act as your server. Keep the module in `ServerStorage` or `ServerScriptService` and require it from server scripts only.

## Setup

Store the API key in the Roblox secrets store (Creator Dashboard > your experience > Secrets) and read it with `HttpService:GetSecret`. The returned `Secret` userdata is passed straight through and composed into the `Authorization` header via `Secret:AddPrefix("Bearer ")`, the documented Secret API; Roblox interpolates the value at request time without exposing it to Lua.

```lua
local ServerStorage = game:GetService("ServerStorage")
local Junjo = require(ServerStorage.Junjo)

local junjo = Junjo.new({
	apiKey = game:GetService("HttpService"):GetSecret("JUNJO_API_KEY"),
	-- baseUrl = "https://api.junjo.io", -- default
})
```

Alternatively pass `apiKeySecret = "JUNJO_API_KEY"` and the SDK performs the `GetSecret` lookup itself, falling back to a literal `apiKey` string only when the lookup fails (useful in Studio, where secrets may not be registered). The SDK warns once when that fallback is used, naming the secret; if you configure a fallback, make it a separate low-privilege key minted for a dev game, never your production key. Keys are per-game `jk_<prefix>.<secret>` strings; the constructor rejects admin tokens (`jadm_*`) and warns once on any other non-conforming shape.

## Quick example

In a `Script` under `ServerScriptService`:

```lua
local ServerStorage = game:GetService("ServerStorage")
local Players = game:GetService("Players")

local Junjo = require(ServerStorage.Junjo)

local junjo = Junjo.new({
	apiKey = game:GetService("HttpService"):GetSecret("JUNJO_API_KEY"),
})
local userIds = Junjo.RobloxUserIdAdapter()

local group = junjo.groups:create({
	kind = "guild",
	name = "Crimson Wolves",
	visibility = "public",
	defaultRoleId = "member",
})

Players.PlayerAdded:Connect(function(player)
	task.spawn(function()
		local userId = userIds:resolve(player)
		junjo.groups:join(group.id, userId)
		if junjo:can(userId, group.id, "invite_member") then
			print(player.Name .. " can invite members")
		end
	end)
end)
```

`Junjo.RobloxUserIdAdapter` resolves a `Player` (or numeric `UserId`) to the opaque-string user id Junjo persists, keeping the `tostring(player.UserId)` conversion in one place.

> **Warning:** In `RemoteEvent` handlers, derive the actor from the `player` argument Roblox passes to the handler and ownership-validate any client-supplied id before it reaches Junjo; never pass a client-supplied target user id into bans or friends mutations without a server-side rule. See [Calling Junjo from player actions](https://docs.junjo.io/roblox#calling-junjo-from-player-actions) for the worked pattern.

## Surface overview

| Namespace | Methods |
|-----------|---------|
| `junjo.groups` | CRUD (`create` / `get` / `list` / `listAll` / `update` / `delete` / `restore`), membership lifecycle (`inviteByUserId` / `inviteByCode` / `inviteByLink` / `bulkInvite` / `acceptInvitation` / `declineInvitation` / `join` / `leave` / `kick`), per-group bans (`ban` / `unban` / `banHistory` / `banHistoryAll`), relationships (`setRelationship` / `clearRelationship` / `getRelationship` / `listRelationships`), sub-groups (`setParent` / `listChildren`) |
| `junjo.members` | `get` / `getById` / `list` (with a `status` filter) / `listAll` / `listForUser` / `setMetadata` / `setNotes` / `assignRole` / `removeRole` / `overridePermission` / `clearPermissionOverride` / `listPermissionOverrides` |
| `junjo.roles` | `create` / `get` / `list` / `update` / `delete` / `grantPermission` / `revokePermission` |
| `junjo.invitations` | `list` / `get` / `revoke` |
| `junjo.audit` | `list` (cursor-paginated audit feed) |
| `junjo.webhooks.endpoints` | `create` / `list` (cursor-paginated, returns `{ items, nextCursor }`) / `listAll` / `update` / `delete` |
| `junjo.bans` | Game-wide bans: `add` / `remove` / `get` / `list` / `listAll` / `history` / `historyAll` |
| `junjo.friends` | `list` / `listAll` / `remove` / `getRelationship` / `suggestions`, plus the `requests`, `blocks`, `tags`, and `visibility` sub-namespaces * |
| Top level | `junjo:can` / `junjo:check` (permission checks), `junjo:keyInfo` (which game the key belongs to), `Junjo.pageAll` (pagination iterator), `Junjo.Null` (explicit JSON null), `junjo.http` (raw HTTP escape hatch) |

\* `friends.blocks:list` returns at most the server's default page size (100 rows) and accepts no cursor; there is currently no way to read past that (a server-side gap).

Paginated lists return `{ items, nextCursor }` pages; the `listAll` / `banHistoryAll` / `historyAll` variants wrap `Junjo.pageAll` into a generic-for iterator that fetches pages lazily. Errors surface as `JunjoError` tables (`{ name, message, code, status, requestId, retryAfterSeconds }`); catch with `pcall` and branch on `code`. `requestId` mirrors the server's `x-request-id` (worth quoting in bug reports) and `retryAfterSeconds` carries the integer `Retry-After` seconds on rate-limited responses (honor it in your own backoff); both are `nil` when the response omits the header.

## Retries

Retries are opt-in and off by default. Roblox grants each game server a hard `HttpService` budget of 500 requests per minute, shared by everything the server does over HTTP, so blind retry loops burn budget the rest of the game needs.

```lua
local junjo = Junjo.new({
	apiKey = game:GetService("HttpService"):GetSecret("JUNJO_API_KEY"),
	retries = { maxAttempts = 3, backoffSeconds = 1 },
})
```

`maxAttempts` is the total attempt cap including the first request (default 1, meaning no retry). Backoff is exponential with jitter from `backoffSeconds`. The policy is deliberately conservative: 429 responses retry for any method and honor the `Retry-After` header; 5xx responses and transport failures retry for GET only (a failed write may already have applied server-side); every other status never retries.

## Intentional limitations

- **No SSE / realtime.** Roblox `HttpService` cannot hold streaming connections, so the TypeScript SDK's `groups.subscribe` is not mirrored. For live updates, register webhooks that deliver to your own backend and relay into the game from there.
- **No webhook receiver helpers.** A Roblox game server cannot accept inbound HTTP, so it is never a webhook receiver; `webhooks:verify` / `webhooks:middleware` are not mirrored. Endpoint CRUD (`junjo.webhooks.endpoints`) is fully supported.
- **Fixed request timeout.** `HttpService:RequestAsync` has a fixed timeout of roughly 30 seconds and no timeout option. A hung request yields the calling thread until Roblox gives up, so call the SDK from a dedicated thread (`task.spawn`) when latency would stall game logic.

## Testing

The Luau test suite runs under [lune](https://github.com/lune-org/lune) against a fake `HttpService` injected through the documented `config.httpService` seam:

```sh
cd packages/sdk-roblox
lune run tests/run.luau
```

## Building

Build the distributable model with [rojo](https://rojo.space/):

```sh
cd packages/sdk-roblox
rojo build default.project.json --output Junjo.rbxm
```

## Documentation

Full reference, including error codes, `Junjo.Null` semantics, and the adapter contract: [docs.junjo.io/roblox](https://docs.junjo.io/roblox).

## Releases

Releases are tagged `roblox-vX.Y.Z`. Each release has the built `Junjo.rbxm` attached as an asset, and CI verifies that `Junjo.VERSION` in `src/init.lua` matches the tag before building.
