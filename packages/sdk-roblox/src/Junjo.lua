-- Junjo Luau client. Mirrors the TypeScript SDK's `JunjoConfig` shape and
-- wraps Roblox's HttpService for outbound REST calls. Phase 8.1 ships
-- the HTTP wrapper and Junjo.new factory; the per-namespace methods
-- (groups, roles, members, invitations, audit, permissions, webhooks)
-- land in Phase 8.2 and read through `junjo.http`.

local HttpService = game:GetService("HttpService")

local DEFAULT_BASE_URL = "https://api.junjo.io"

-- Sentinel for explicit JSON null inside request bodies. Lua's `nil`
-- means "key absent" in tables, so a caller that needs to send
-- `{ "defaultRoleId": null }` (e.g. to clear a field on PATCH) writes
-- `{ defaultRoleId = Junjo.Null }` and the encoder substitutes a real
-- JSON `null` at serialize time.
local Null = newproxy(false)

-- ============================================================
-- JunjoError
-- ============================================================

local JunjoError = {}
JunjoError.__index = JunjoError

function JunjoError.new(message, code, status)
	local self = setmetatable({}, JunjoError)
	self.name = "JunjoError"
	self.message = tostring(message or "request failed")
	self.code = tostring(code or "internal")
	self.status = status
	return self
end

function JunjoError.is(value)
	return type(value) == "table" and getmetatable(value) == JunjoError
end

function JunjoError:__tostring()
	if self.status ~= nil then
		return string.format("JunjoError(%s, %d): %s", self.code, self.status, self.message)
	end
	return string.format("JunjoError(%s): %s", self.code, self.message)
end

local function raise(message, code, status)
	-- Level 0 suppresses Lua's automatic file:line prefix so the error
	-- value is the raw JunjoError table; consumer pcall returns it as-is.
	error(JunjoError.new(message, code, status), 0)
end

-- ============================================================
-- Body encoding (Junjo.Null sentinel handling)
-- ============================================================

-- Random-looking placeholder string. Inserted in place of every
-- Junjo.Null sentinel before JSONEncode runs, then string-substituted
-- back to a literal `null` after encode. The token is unique enough
-- that an accidental collision with caller content is vanishingly
-- unlikely (and would only matter if a string field actually contained
-- this exact value).
local NULL_TOKEN = "__JUNJO_NULL_3f6c9a01__"
local NULL_TOKEN_QUOTED = '"' .. NULL_TOKEN .. '"'

local function substituteNulls(value)
	if value == Null then
		return NULL_TOKEN
	end
	if type(value) ~= "table" then
		return value
	end
	local copy = {}
	for k, v in pairs(value) do
		copy[k] = substituteNulls(v)
	end
	return copy
end

local function encodeBody(httpService, body)
	if body == nil then
		return nil
	end
	local prepared = substituteNulls(body)
	local json = httpService:JSONEncode(prepared)
	-- string.gsub returns (string, count); discard count via parens.
	return (string.gsub(json, NULL_TOKEN_QUOTED, "null"))
end

-- ============================================================
-- HTTP wrapper
-- ============================================================

local Http = {}
Http.__index = Http

function Http.new(opts)
	local self = setmetatable({}, Http)
	-- apiKey may be a plain string OR a Roblox Secret userdata (returned
	-- by HttpService:GetSecret). Concatenation works for both: string +
	-- string -> string, Secret + string -> Secret. Roblox interpolates
	-- the actual secret at request time without exposing it to Lua.
	self._apiKey = opts.apiKey
	self._baseUrl = (string.gsub(opts.baseUrl, "/+$", ""))
	self._http = opts.httpService
	return self
end

local function parseErrorBody(httpService, body)
	if body == nil or body == "" then
		return nil
	end
	local ok, decoded = pcall(httpService.JSONDecode, httpService, body)
	if not ok or type(decoded) ~= "table" then
		return nil
	end
	return decoded
end

function Http:request(method, path, body)
	local url = self._baseUrl .. path
	local headers = {
		Authorization = "Bearer " .. self._apiKey,
	}
	local opts = {
		Url = url,
		Method = method,
		Headers = headers,
	}
	if body ~= nil then
		headers["Content-Type"] = "application/json"
		opts.Body = encodeBody(self._http, body)
	end

	local ok, res = pcall(function()
		return self._http:RequestAsync(opts)
	end)
	if not ok then
		-- Network-level failure (HttpService disabled, DNS, TLS, etc.).
		-- The underlying error is already a string with Roblox context.
		raise(tostring(res), "network", nil)
	end

	if type(res) ~= "table" or type(res.StatusCode) ~= "number" then
		raise("HttpService returned an unexpected response shape", "internal", nil)
	end

	if res.StatusCode < 200 or res.StatusCode >= 300 then
		local parsed = parseErrorBody(self._http, res.Body)
		local code = (parsed and parsed.code) or "internal"
		local message = (parsed and parsed.message) or res.StatusMessage or "request failed"
		local status = (parsed and parsed.status) or res.StatusCode
		raise(message, code, status)
	end

	if res.StatusCode == 204 or res.Body == nil or res.Body == "" then
		return nil
	end

	local parseOk, decoded = pcall(self._http.JSONDecode, self._http, res.Body)
	if not parseOk then
		raise("response body was not valid JSON", "internal", res.StatusCode)
	end
	return decoded
end

function Http:get(path)
	return self:request("GET", path, nil)
end

function Http:post(path, body)
	return self:request("POST", path, body)
end

function Http:patch(path, body)
	return self:request("PATCH", path, body)
end

function Http:put(path, body)
	return self:request("PUT", path, body)
end

function Http:delete(path)
	return self:request("DELETE", path, nil)
end

-- ============================================================
-- Junjo factory
-- ============================================================

local Junjo = {}
Junjo.__index = Junjo

Junjo.Null = Null
Junjo.JunjoError = JunjoError
Junjo.DEFAULT_BASE_URL = DEFAULT_BASE_URL

local function trimTrailingSlashes(s)
	return (string.gsub(s, "/+$", ""))
end

local function resolveApiKey(config, httpService)
	-- If a secret name is configured, try GetSecret first. On failure
	-- (HttpService:GetSecret unavailable, secret not registered, etc.)
	-- fall back to config.apiKey when present; otherwise raise.
	if type(config.apiKeySecret) == "string" and config.apiKeySecret ~= "" then
		local ok, secret = pcall(function()
			return httpService:GetSecret(config.apiKeySecret)
		end)
		if ok and secret ~= nil then
			return secret
		end
		if config.apiKey == nil then
			raise(
				"HttpService:GetSecret('"
					.. config.apiKeySecret
					.. "') failed and no apiKey fallback was provided",
				"invalid_config",
				nil
			)
		end
	end
	if config.apiKey == nil then
		raise("config.apiKey or config.apiKeySecret is required", "invalid_config", nil)
	end
	-- Either a literal string or an already-resolved Secret userdata.
	return config.apiKey
end

function Junjo.new(config)
	if config == nil then
		raise("Junjo.new(config) requires a config table", "invalid_config", nil)
	end
	if type(config) ~= "table" then
		raise("Junjo.new(config) requires a table argument", "invalid_config", nil)
	end

	local httpService = config.httpService or HttpService

	local baseUrl = config.baseUrl or DEFAULT_BASE_URL
	if type(baseUrl) ~= "string" or baseUrl == "" then
		raise("config.baseUrl must be a non-empty string", "invalid_config", nil)
	end
	local trimmedBaseUrl = trimTrailingSlashes(baseUrl)

	local inviteBaseUrl = config.inviteBaseUrl or trimmedBaseUrl
	if type(inviteBaseUrl) ~= "string" or inviteBaseUrl == "" then
		raise("config.inviteBaseUrl must be a non-empty string", "invalid_config", nil)
	end
	local trimmedInviteBaseUrl = trimTrailingSlashes(inviteBaseUrl)

	local apiKey = resolveApiKey(config, httpService)

	local http = Http.new({
		apiKey = apiKey,
		baseUrl = trimmedBaseUrl,
		httpService = httpService,
	})

	local self = setmetatable({}, Junjo)
	self.config = {
		baseUrl = trimmedBaseUrl,
		inviteBaseUrl = trimmedInviteBaseUrl,
	}
	self.http = http
	-- Phase 8.2 will attach groups / roles / members / invitations /
	-- audit / permissions / webhooks namespace tables here, each
	-- holding a reference to `self.http` for outbound calls.
	return self
end

return Junjo
