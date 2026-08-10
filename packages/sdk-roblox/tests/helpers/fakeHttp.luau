-- Fake of the HttpService surface the SDK touches: RequestAsync,
-- JSONEncode / JSONDecode, UrlEncode, and GetSecret. JSON goes through
-- lune's serde (which, like Roblox's JSONEncode, raises on values JSON
-- cannot carry). UrlEncode mirrors Roblox's behavior of percent-encoding
-- every byte except ASCII alphanumerics, "-" and "_".

local serde = require("@lune/serde")

local FakeHttp = {}
FakeHttp.__index = FakeHttp

-- opts (all optional):
--   handler: function(requestOptions, callIndex) -> RequestAsync-shaped
--            response table (or raise, to model network failures).
--            Defaults to 200 OK with body `{"ok":true}`.
--   secrets: map of secret name -> value for GetSecret.
local function new(opts)
	opts = opts or {}
	local self = setmetatable({}, FakeHttp)
	self.requests = {}
	self._handler = opts.handler
	self._secrets = opts.secrets or {}
	return self
end

function FakeHttp:UrlEncode(value)
	return (string.gsub(tostring(value), "[^%w%-_]", function(c)
		return string.format("%%%02X", string.byte(c))
	end))
end

-- Roblox's JSONEncode serializes an empty table as "[]" (empty array);
-- lune's serde picks "{}" (empty object). Mirror Roblox via the same
-- token-substitution trick the SDK uses for Junjo.Null: swap empty
-- tables for a marker string pre-encode, then rewrite the quoted marker
-- to a literal [] post-encode.
local EMPTY_TABLE_TOKEN = "__FAKE_EMPTY_TABLE_9d24c7b3__"
local EMPTY_TABLE_TOKEN_QUOTED = '"' .. EMPTY_TABLE_TOKEN .. '"'

local function markEmptyTables(value)
	if type(value) ~= "table" then
		return value
	end
	if next(value) == nil then
		return EMPTY_TABLE_TOKEN
	end
	local copy = {}
	for k, v in pairs(value) do
		copy[k] = markEmptyTables(v)
	end
	return copy
end

function FakeHttp:JSONEncode(value)
	local json = serde.encode("json", markEmptyTables(value))
	return (string.gsub(json, EMPTY_TABLE_TOKEN_QUOTED, "[]"))
end

function FakeHttp:JSONDecode(value)
	return serde.decode("json", value)
end

function FakeHttp:GetSecret(name)
	local secret = self._secrets[name]
	if secret == nil then
		error("GetSecret: secret " .. tostring(name) .. " is not registered")
	end
	return secret
end

-- Minimal stand-in for the Secret userdata HttpService:GetSecret
-- returns in Roblox: opaque to Lua except the documented AddPrefix /
-- AddSuffix methods, each of which returns a new Secret. Tests assert
-- on the `__secretValue` marker to prove a header was built through
-- AddPrefix rather than string concatenation (which this stub, like a
-- real Secret under documented behavior, does not support).
local function newSecretStub(value)
	local secret = { __isSecretStub = true, __secretValue = value }
	function secret:AddPrefix(prefix)
		return newSecretStub(prefix .. self.__secretValue)
	end
	function secret:AddSuffix(suffix)
		return newSecretStub(self.__secretValue .. suffix)
	end
	return secret
end

function FakeHttp:RequestAsync(requestOptions)
	table.insert(self.requests, requestOptions)
	if self._handler ~= nil then
		return self._handler(requestOptions, #self.requests)
	end
	return { StatusCode = 200, StatusMessage = "OK", Body = '{"ok":true}' }
end

return {
	new = new,
	newSecretStub = newSecretStub,
}
