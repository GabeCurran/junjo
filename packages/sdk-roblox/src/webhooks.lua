--!nonstrict
-- Nonstrict, not strict: cross-module `require(script.Parent.X)` types
-- and the metatable-OOP idiom below need the Roblox definition files to
-- pass strict analysis, which CI cannot run yet. Public signatures
-- carry annotations regardless.
--
-- Webhooks namespace. Mirrors the TypeScript SDK's
-- `junjo.webhooks.endpoints` sub-namespace only. The TS SDK additionally
-- exposes `verify` and `middleware` for receiver-side delivery
-- validation, which are intentionally NOT mirrored on Roblox: a Roblox
-- game server cannot expose an HTTP endpoint, so it is never a webhook
-- receiver.

local JunjoError = require(script.Parent.JunjoError)

local Webhooks = {}
Webhooks.__index = Webhooks

local Endpoints = {}
Endpoints.__index = Endpoints

function Endpoints.new(http)
	local self = setmetatable({}, Endpoints)
	self._http = http
	return self
end

-- Creates an endpoint and returns it including the signing secret. The
-- secret is returned exactly once; persist it server-side immediately.
-- Subsequent list / update calls do not return it.
function Endpoints:create(input: { url: string, events: { string }?, secret: string?, format: string? })
	if input == nil then
		JunjoError.raise(
			"webhooks.endpoints:create(input) requires an input table",
			"invalid_config",
			nil
		)
	end
	local body = { url = input.url }
	if input.events ~= nil then body.events = input.events end
	if input.secret ~= nil then body.secret = input.secret end
	if input.format ~= nil then body.format = input.format end
	return self._http:post("/v1/webhooks", body)
end

-- Returns every endpoint configured for the calling game, newest first.
-- Server response shape is `{ items: [...], nextCursor: null }` (the
-- standard Page<T> envelope; pagination is not used today). The SDK
-- flattens to a plain array for ergonomics.
function Endpoints:list()
	local res = self._http:get("/v1/webhooks")
	if type(res) == "table" and res.items ~= nil then
		return res.items
	end
	return {}
end

-- Partial update. At least one field is required by the server (empty
-- bodies return 400). `disabled = true` mutes the endpoint; `disabled =
-- false` un-mutes. Returns the post-state endpoint without the secret.
function Endpoints:update(id: string, input: { url: string?, events: { string }?, disabled: boolean?, format: string? })
	if input == nil then
		JunjoError.raise(
			"webhooks.endpoints:update(id, input) requires an input table",
			"invalid_config",
			nil
		)
	end
	local body = {}
	if input.url ~= nil then body.url = input.url end
	if input.events ~= nil then body.events = input.events end
	if input.disabled ~= nil then body.disabled = input.disabled end
	if input.format ~= nil then body.format = input.format end
	return self._http:patch("/v1/webhooks/" .. self._http:encode(id), body)
end

-- Hard-deletes the endpoint. Pending deliveries are cascaded by the
-- database. A missing id raises a JunjoError with code = "not_found".
function Endpoints:delete(id: string)
	self._http:delete("/v1/webhooks/" .. self._http:encode(id))
end

function Webhooks.new(http)
	local self = setmetatable({}, Webhooks)
	self.endpoints = Endpoints.new(http)
	return self
end

return Webhooks
