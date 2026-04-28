# junjo-roblox

Luau client for Junjo. Distributed via the Roblox marketplace and as a `.rbxm` model on each GitHub release. Not on npm. Wraps `HttpService` and `MessagingService`.

```lua
local Junjo = require(ReplicatedStorage.Junjo)

local junjo = Junjo.new({
  apiKey = game:GetService("HttpService"):GetSecret("JUNJO_API_KEY"),
  authAdapter = Junjo.RobloxUserIdAdapter(),
})

local group = junjo.groups:create({
  name = "Crimson Wolves",
  kind = "clan",
  defaultRoleId = "member",
})

local allowed = junjo:can(player.UserId, group.id, "invite_member")
```

Dogfood target: the `mobarena-roblox` project. Source lives in `src/Junjo.lua` (placeholder for now).
