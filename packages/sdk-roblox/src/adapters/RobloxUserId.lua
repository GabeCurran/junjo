--!nonstrict
-- Nonstrict, not strict: cross-module `require(script.Parent.Parent.X)`
-- types, the `game` global, and the metatable-OOP idiom below need the
-- Roblox definition files to pass strict analysis, which CI cannot run
-- yet. Public signatures carry annotations regardless.
--
-- RobloxUserIdAdapter: built-in adapter that resolves a Roblox UserId
-- to the opaque-string user-id that Junjo persists per game. Roblox does
-- not give the dev's backend a session token (the TS-SDK auth-adapter
-- model); instead, the trust boundary is the Roblox game server itself.
-- Inside a server-side script the developer already trusts whatever
-- `Player.UserId` is on the player object that triggered the request,
-- and the adapter is a thin renderer that converts the numeric id to a
-- string (matching the cross-runtime user-id contract documented in
-- `apps/docs/pages/auth/index.mdx`: numerics serialized as strings).
--
-- The adapter is for SERVER-side use only, like the rest of the SDK:
-- the module lives in a non-replicated container, clients never require
-- it, and identity always comes from the `Player` argument Roblox
-- passes to server-side handlers (PlayerAdded, RemoteEvent callbacks).
--
-- Call shapes:
--   - `adapter:resolve(player)` (the production shape): pass the Player
--     reference you already have on hand. Returns `tostring(player.UserId)`.
--   - `adapter:resolve()`: reads `Players.LocalPlayer.UserId`,
--     which is nil on servers, so this raises `invalid_config` in
--     production server scripts; always pass the Player explicitly.
--   - `RobloxUserIdAdapter({ explicitUserId = "..." })` then
--     `adapter:resolve()` (tests / scripted contexts): returns the
--     hard-coded id without touching `Players`.
--
-- A bare `Player` userdata, a positive integer, or a non-empty string
-- is also accepted by `:resolve(value)` directly (bypassing the player
-- lookup) so consumers that already have a numeric id from elsewhere
-- can use the same adapter for normalization.

local Players = game:GetService("Players")

local JunjoError = require(script.Parent.Parent.JunjoError)

local RobloxUserIdAdapter = {}
RobloxUserIdAdapter.__index = RobloxUserIdAdapter

local function isPositiveInteger(value: any): boolean
	return type(value) == "number" and value > 0 and value % 1 == 0
end

local function readUserIdFromPlayer(player)
	if type(player) ~= "userdata" and type(player) ~= "table" then
		JunjoError.raise(
			"RobloxUserIdAdapter:resolve(player) expected a Player; got " .. type(player),
			"invalid_config",
			nil
		)
	end
	-- A real Roblox `Player` instance carries a numeric `UserId` field.
	-- Avoid calling `:IsA("Player")` so a stub table with the same shape
	-- can stand in for tests without pulling in the Instance API.
	local userId = player.UserId
	if not isPositiveInteger(userId) then
		JunjoError.raise(
			"RobloxUserIdAdapter: player.UserId must be a positive integer",
			"invalid_config",
			nil
		)
	end
	return tostring(userId)
end

local function readLocalPlayerUserId(playersService)
	local localPlayer = playersService.LocalPlayer
	if localPlayer == nil then
		JunjoError.raise(
			"RobloxUserIdAdapter:resolve() called without a Player and Players.LocalPlayer is nil "
				.. "(the script is running on the server). Pass the Player explicitly.",
			"invalid_config",
			nil
		)
	end
	return readUserIdFromPlayer(localPlayer)
end

-- Construct an adapter. All options are optional.
--
-- `explicitUserId`: hard-coded id returned by every `:resolve()` call
-- regardless of input. Bypasses the Players service entirely. Use only
-- in tests or scripted automation where the consumer wants a fixed id.
--
-- `players`: inject a fake `Players` service for testing. Defaults to
-- `game:GetService("Players")`.
local function new(opts: { explicitUserId: any?, players: any? }?)
	opts = opts or {}
	if type(opts) ~= "table" then
		JunjoError.raise(
			"RobloxUserIdAdapter(opts) expected a table or nil; got " .. type(opts),
			"invalid_config",
			nil
		)
	end

	local explicitUserId = opts.explicitUserId
	if explicitUserId ~= nil then
		if type(explicitUserId) == "number" then
			if not isPositiveInteger(explicitUserId) then
				JunjoError.raise(
					"RobloxUserIdAdapter: explicitUserId must be a positive integer or non-empty string",
					"invalid_config",
					nil
				)
			end
			explicitUserId = tostring(explicitUserId)
		elseif type(explicitUserId) == "string" then
			if explicitUserId == "" then
				JunjoError.raise(
					"RobloxUserIdAdapter: explicitUserId must not be the empty string",
					"invalid_config",
					nil
				)
			end
		else
			JunjoError.raise(
				"RobloxUserIdAdapter: explicitUserId must be a string or positive integer",
				"invalid_config",
				nil
			)
		end
	end

	local self = setmetatable({}, RobloxUserIdAdapter)
	self._explicitUserId = explicitUserId
	self._players = opts.players or Players
	return self
end

-- Resolve to the opaque-string user id Junjo expects. The argument is
-- optional and accepts:
--   - a `Player` instance (or a stub table with a numeric `UserId` field)
--   - a positive integer (rendered with `tostring`)
--   - a non-empty string (returned verbatim)
--   - nil, in which case the adapter reads `Players.LocalPlayer.UserId`
--
-- An adapter constructed with `explicitUserId` returns that id on every
-- call, ignoring the argument.
function RobloxUserIdAdapter:resolve(value: any): string
	if self._explicitUserId ~= nil then
		return self._explicitUserId
	end

	if value == nil then
		return readLocalPlayerUserId(self._players)
	end

	local kind = type(value)
	if kind == "number" then
		if not isPositiveInteger(value) then
			JunjoError.raise(
				"RobloxUserIdAdapter:resolve(number): expected a positive integer",
				"invalid_config",
				nil
			)
		end
		return tostring(value)
	end
	if kind == "string" then
		if value == "" then
			JunjoError.raise(
				"RobloxUserIdAdapter:resolve(string): expected a non-empty string",
				"invalid_config",
				nil
			)
		end
		return value
	end
	-- Treat userdata (real Player instance) and table (stub) the same way:
	-- read the `UserId` field. Roblox's `Player` is a userdata; tests pass
	-- a table with a `UserId` field.
	return readUserIdFromPlayer(value)
end

return new
