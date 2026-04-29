-- Internal HTTP wrapper used by every Junjo namespace. Wraps Roblox's
-- HttpService for outbound REST calls, JSON-encodes request bodies (with
-- Junjo.Null substitution for explicit JSON null), parses JSON responses,
-- and surfaces non-2xx responses as JunjoError-shaped Lua errors.
--
-- Exposed on the Junjo instance as `junjo.http` so consumers can call
-- arbitrary routes (or routes that pre-date a Phase 8.x release) via
-- `junjo.http:get(path)` / `:post(path, body)` / etc. without waiting
-- for a typed namespace method.

local JunjoError = require(script.Parent.JunjoError)
local Null = require(script.Parent.Null)

-- Random-looking placeholder string. Inserted in place of every
-- Junjo.Null sentinel before JSONEncode runs, then string-substituted
-- back to a literal `null` after encode. The token is unique enough
-- that an accidental collision with caller content is vanishingly
-- unlikely.
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

local function encodeJsonBody(httpService, body)
	if body == nil then
		return nil
	end
	local prepared = substituteNulls(body)
	local json = httpService:JSONEncode(prepared)
	-- string.gsub returns (string, count); discard count via parens.
	return (string.gsub(json, NULL_TOKEN_QUOTED, "null"))
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

-- URL-encode a single string, suitable for path segments and query
-- values. Wraps HttpService:UrlEncode so namespace modules don't need
-- to grab their own HttpService reference.
function Http:encode(value)
	return self._http:UrlEncode(tostring(value))
end

local function send(self, method, path, body, contentType)
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
		if contentType == nil or contentType == "application/json" then
			headers["Content-Type"] = "application/json"
			opts.Body = encodeJsonBody(self._http, body)
		else
			-- Caller supplied an explicit content-type: send the body
			-- verbatim (used by groups.bulkInvite for text/csv).
			headers["Content-Type"] = contentType
			opts.Body = body
		end
	end

	local ok, res = pcall(function()
		return self._http:RequestAsync(opts)
	end)
	if not ok then
		-- Network-level failure (HttpService disabled, DNS, TLS, etc.).
		-- The underlying error is already a string with Roblox context.
		JunjoError.raise(tostring(res), "network", nil)
	end

	if type(res) ~= "table" or type(res.StatusCode) ~= "number" then
		JunjoError.raise("HttpService returned an unexpected response shape", "internal", nil)
	end

	if res.StatusCode < 200 or res.StatusCode >= 300 then
		local parsed = parseErrorBody(self._http, res.Body)
		local code = (parsed and parsed.code) or "internal"
		local message = (parsed and parsed.message) or res.StatusMessage or "request failed"
		local status = (parsed and parsed.status) or res.StatusCode
		JunjoError.raise(message, code, status)
	end

	if res.StatusCode == 204 or res.Body == nil or res.Body == "" then
		return nil
	end

	local parseOk, decoded = pcall(self._http.JSONDecode, self._http, res.Body)
	if not parseOk then
		JunjoError.raise("response body was not valid JSON", "internal", res.StatusCode)
	end
	return decoded
end

function Http:request(method, path, body)
	return send(self, method, path, body, nil)
end

function Http:get(path)
	return send(self, "GET", path, nil, nil)
end

function Http:post(path, body)
	return send(self, "POST", path, body, nil)
end

-- POST with an explicit content-type and a body that is sent verbatim
-- (no JSON-encode, no Junjo.Null substitution). Used by groups.bulkInvite
-- to deliver a CSV body.
function Http:postRaw(path, body, contentType)
	return send(self, "POST", path, body, contentType)
end

function Http:patch(path, body)
	return send(self, "PATCH", path, body, nil)
end

function Http:put(path, body)
	return send(self, "PUT", path, body, nil)
end

function Http:delete(path)
	return send(self, "DELETE", path, nil, nil)
end

return Http
