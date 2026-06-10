-- Fake of the HttpService surface the SDK touches: RequestAsync,
-- JSONEncode / JSONDecode, UrlEncode, and GetSecret. JSON goes through
-- lune's serde (which, like Roblox's JSONEncode, raises on values JSON
-- cannot carry). UrlEncode mirrors Roblox's behavior of percent-encoding
-- every byte except ASCII alphanumerics, "-" and "_".

local serde = require("@lune/serde")

local FakeHttp = {}
FakeHttp.__index = FakeHttp

-- opts (all optional):
--   handler - function(requestOptions, callIndex) -> RequestAsync-shaped
--             response table (or raise, to model network failures).
--             Defaults to 200 OK with body `{"ok":true}`.
--   secrets - map of secret name -> value for GetSecret.
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

function FakeHttp:JSONEncode(value)
	return serde.encode("json", value)
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

function FakeHttp:RequestAsync(requestOptions)
	table.insert(self.requests, requestOptions)
	if self._handler ~= nil then
		return self._handler(requestOptions, #self.requests)
	end
	return { StatusCode = 200, StatusMessage = "OK", Body = '{"ok":true}' }
end

return {
	new = new,
}
