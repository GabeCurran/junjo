--!nonstrict
-- Nonstrict, not strict: cross-module `require(script.Parent.X)` types
-- and the metatable-OOP idiom below need the Roblox definition files to
-- pass strict analysis, which CI cannot run yet. Public signatures
-- carry annotations regardless.
--
-- Internal HTTP wrapper used by every Junjo namespace. Wraps Roblox's
-- HttpService for outbound REST calls, JSON-encodes request bodies (with
-- Junjo.Null substitution for explicit JSON null), parses JSON responses,
-- and surfaces non-2xx responses as JunjoError-shaped Lua errors.
--
-- Exposed on the Junjo instance as `junjo.http` so consumers can call
-- arbitrary routes (or routes that the typed namespaces haven't wrapped
-- yet) via `junjo.http:get(path)` / `:post(path, body)` / etc.
--
-- ============================================================
-- Retry policy (opt-in) and the HttpService budget
-- ============================================================
--
-- Roblox grants each game server a hard HttpService budget of 500
-- requests per minute, shared by everything the server does over HTTP.
-- When a burst crosses a Junjo.io rate limit the API answers 429, and
-- blindly re-firing burns the same budget the rest of the game needs.
-- Retries are therefore OPT-IN (`Junjo.new{ retries = { maxAttempts }
-- }`; the default of 1 means no retry) and deliberately conservative:
--
--   - 429 responses retry for ANY method: the server rejected the
--     request before doing any work, so replaying is always safe. The
--     Retry-After response header (integer seconds) is honored when it
--     is larger than the computed backoff.
--   - 5xx responses and transport failures (RequestAsync raising)
--     retry for GET requests ONLY. A write that failed mid-flight may
--     already have been applied server-side, so replaying a POST /
--     PATCH / PUT / DELETE could double-apply it; writes never retry
--     on 5xx or transport failures.
--   - Every other status (including non-429 4xx) never retries.
--
-- The Junjo.io TypeScript SDK never auto-retries at all; the Roblox
-- transport differs because of the request budget above and because
-- RequestAsync has a fixed ~30 second timeout, which together make
-- hand-rolled caller-side retry loops both costlier and easier to get
-- wrong here than on a conventional backend.
--
-- Backoff is exponential with jitter: backoffSeconds * 2^(retry - 1),
-- scaled by a random factor in [1.0, 1.5). Sleeping goes through the
-- injectable wait function (`config.retries.wait`, a test seam) and
-- defaults to task.wait. The final failed attempt raises exactly the
-- JunjoError the non-retry path raises.

local JunjoError = require(script.Parent.JunjoError)
local Null = require(script.Parent.Null)

-- Random-looking placeholder string. Inserted in place of every
-- Junjo.Null sentinel before JSONEncode runs, then string-substituted
-- back to a literal `null` after encode. The token is unique enough
-- that an accidental collision with caller content is vanishingly
-- unlikely.
local NULL_TOKEN = "__JUNJO_NULL_3f6c9a01__"
local NULL_TOKEN_QUOTED = '"' .. NULL_TOKEN .. '"'

-- Pre-encode walk over a request body. Returns true when a Junjo.Null
-- sentinel appears anywhere in the value (so the deep substitution
-- copy below can be skipped for the common sentinel-free body) and
-- raises invalid_config on self-referencing tables, which would
-- otherwise recurse forever. The visited mark is cleared on the way
-- out, so a shared (non-cyclic) subtable does not trip the guard; only
-- a true ancestor cycle does. The walk deliberately never
-- short-circuits on the first sentinel: the whole body is validated
-- for cycles up front so the substitution copy can never recurse into
-- one.
local function scanBody(value, visiting): boolean
	if value == Null then
		return true
	end
	if type(value) ~= "table" then
		return false
	end
	if visiting[value] then
		JunjoError.raise(
			"request body contains a reference cycle and cannot be JSON-encoded",
			"invalid_config",
			nil
		)
	end
	visiting[value] = true
	local found = false
	for _, v in pairs(value) do
		if scanBody(v, visiting) then
			found = true
		end
	end
	visiting[value] = nil
	return found
end

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

local function encodeJsonBody(httpService, body): string?
	if body == nil then
		return nil
	end
	-- Roblox's JSONEncode serializes an empty table as "[]" (empty
	-- array), but every Junjo route that takes an optional body expects
	-- a JSON OBJECT; the server's schema rejects a top-level array with
	-- 400. Emit a literal "{}" for a TOP-LEVEL empty table only: nested
	-- empty tables must stay "[]" because they are genuine empty arrays
	-- (e.g. `tagIds = {}` clears every tag on the assign route, and the
	-- server requires the field to be an array).
	if type(body) == "table" and next(body) == nil then
		return "{}"
	end
	-- Cheap pre-scan: most bodies carry no Junjo.Null sentinel, so the
	-- deep substitution copy runs only when one is actually present.
	-- The scan doubles as the cycle guard for the copy.
	local hasNull = scanBody(body, {})
	local prepared = body
	if hasNull then
		prepared = substituteNulls(body)
	end
	-- JSONEncode raises on values JSON cannot carry (functions, Instances,
	-- mixed-key tables, ...). Surface that as an invalid_config JunjoError
	-- before any network round-trip, mirroring the JSONDecode handling in
	-- `send` below.
	local ok, json = pcall(httpService.JSONEncode, httpService, prepared)
	if not ok then
		JunjoError.raise(
			"request body was not JSON-encodable: " .. tostring(json),
			"invalid_config",
			nil
		)
	end
	if not hasNull then
		return json
	end
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

local DEFAULT_MAX_ATTEMPTS = 1
local DEFAULT_BACKOFF_SECONDS = 1

local function defaultWait(seconds: number)
	task.wait(seconds)
end

-- Exponential backoff with jitter for the given retry ordinal (1 for
-- the first retry). The jitter factor is always >= 1 so a retry never
-- sleeps less than the deterministic base, keeping pressure off the
-- shared HttpService budget.
local function computeBackoffSeconds(base: number, retryIndex: number): number
	return base * 2 ^ (retryIndex - 1) * (1 + 0.5 * math.random())
end

-- Roblox lowercases response header names, but a test transport may not;
-- look a header up case-insensitively by its lowercase name and return
-- the raw string value (nil when absent).
local function findHeader(headers, targetLowerName: string): string?
	if type(headers) ~= "table" then
		return nil
	end
	for name, value in pairs(headers) do
		if type(name) == "string" and string.lower(name) == targetLowerName then
			return tostring(value)
		end
	end
	return nil
end

-- Retry-After parsing shared by the opt-in retry policy and by the
-- JunjoError built for a failed response. Only the integer-seconds form
-- is honored (the HTTP-date form is not worth parsing in Luau).
local function parseRetryAfterSeconds(rawValue: string?): number?
	if rawValue == nil then
		return nil
	end
	local seconds = string.match(rawValue, "^%s*(%d+)%s*$")
	if seconds ~= nil then
		return tonumber(seconds)
	end
	return nil
end

local function readRetryAfterSeconds(headers): number?
	return parseRetryAfterSeconds(findHeader(headers, "retry-after"))
end

local Http = {}
Http.__index = Http

export type RetryConfig = {
	-- Total attempt cap, including the first request. 1 (the default)
	-- means no retry; values > 1 opt in to the policy documented in the
	-- module header.
	maxAttempts: number?,
	-- Base for the exponential backoff, in seconds. Default 1.
	backoffSeconds: number?,
	-- Injection point for tests (fake clock); defaults to task.wait.
	wait: ((seconds: number) -> ())?,
}

export type HttpOptions = {
	apiKey: any, -- string or Secret userdata
	baseUrl: string,
	httpService: any,
	retries: RetryConfig?,
}

function Http.new(opts: HttpOptions)
	local self = setmetatable({}, Http)
	-- apiKey may be a plain string OR a Roblox Secret userdata (returned
	-- by HttpService:GetSecret). A Secret cannot be read from Lua, and
	-- Secret:AddPrefix / Secret:AddSuffix are the documented APIs for
	-- composing header values around one (string concatenation on a
	-- Secret is undocumented behavior), so the Authorization value is
	-- built via AddPrefix for Secrets and plain concatenation for
	-- strings. Roblox interpolates the actual secret value at request
	-- time without ever exposing it to Lua.
	self._apiKey = opts.apiKey
	if type(opts.apiKey) ~= "string" then
		self._authorization = opts.apiKey:AddPrefix("Bearer ")
	else
		self._authorization = "Bearer " .. opts.apiKey
	end
	self._baseUrl = (string.gsub(opts.baseUrl, "/+$", ""))
	self._http = opts.httpService
	local retries = opts.retries or {}
	self._maxAttempts = retries.maxAttempts or DEFAULT_MAX_ATTEMPTS
	self._backoffSeconds = retries.backoffSeconds or DEFAULT_BACKOFF_SECONDS
	self._wait = retries.wait or defaultWait
	return self
end

-- URL-encode a single string, suitable for path segments and query
-- values. Wraps HttpService:UrlEncode so namespace modules don't need
-- to grab their own HttpService reference.
function Http:encode(value: any): string
	return self._http:UrlEncode(tostring(value))
end

-- Maps a non-2xx response to the JunjoError the caller sees, reading
-- the canonical `{ code, message, status }` envelope when the body
-- carries one and falling back to transport-level fields otherwise. The
-- server's x-request-id header lands on `requestId` (worth quoting in
-- bug reports) and a Retry-After header (primarily on 429) lands on
-- `retryAfterSeconds`, reusing the same parse the retry policy uses.
local function raiseResponseError(self, res): ()
	local parsed = parseErrorBody(self._http, res.Body)
	local code = (parsed and parsed.code) or "internal"
	local message = (parsed and parsed.message) or res.StatusMessage or "request failed"
	local status = (parsed and parsed.status) or res.StatusCode
	local requestId = findHeader(res.Headers, "x-request-id")
	local retryAfterSeconds = readRetryAfterSeconds(res.Headers)
	JunjoError.raise(message, code, status, requestId, retryAfterSeconds)
end

local function send(self, method: string, path: string, body: any, contentType: string?): any
	local url = self._baseUrl .. path
	local headers = {
		Authorization = self._authorization,
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

	local isRead = method == "GET"
	local attempt = 0
	while true do
		attempt += 1
		-- Retries are only available while attempt < maxAttempts; the
		-- final attempt fails exactly like the non-retry path below.
		local canRetry = attempt < self._maxAttempts

		local ok, res = pcall(function()
			return self._http:RequestAsync(opts)
		end)

		if not ok then
			-- Network-level failure (HttpService disabled, DNS, TLS, etc.).
			-- The underlying error is already a string with Roblox context.
			-- Retryable for GET only: the request may have reached the
			-- server before failing, and a write may have applied.
			if not (canRetry and isRead) then
				JunjoError.raise(tostring(res), "network", nil)
			end
			self._wait(computeBackoffSeconds(self._backoffSeconds, attempt))
		else
			if type(res) ~= "table" or type(res.StatusCode) ~= "number" then
				JunjoError.raise("HttpService returned an unexpected response shape", "internal", nil)
			end

			local status = res.StatusCode
			local retryable = status == 429 or (status >= 500 and isRead)
			if retryable and canRetry then
				local delay = computeBackoffSeconds(self._backoffSeconds, attempt)
				if status == 429 then
					local retryAfter = readRetryAfterSeconds(res.Headers)
					if retryAfter ~= nil and retryAfter > delay then
						delay = retryAfter
					end
				end
				self._wait(delay)
			else
				if status < 200 or status >= 300 then
					raiseResponseError(self, res)
				end

				if status == 204 or res.Body == nil or res.Body == "" then
					return nil
				end

				local parseOk, decoded = pcall(self._http.JSONDecode, self._http, res.Body)
				if not parseOk then
					JunjoError.raise("response body was not valid JSON", "internal", status)
				end
				return decoded
			end
		end
	end
end

function Http:request(method: string, path: string, body: any): any
	return send(self, method, path, body, nil)
end

function Http:get(path: string): any
	return send(self, "GET", path, nil, nil)
end

function Http:post(path: string, body: any): any
	return send(self, "POST", path, body, nil)
end

-- POST with an explicit content-type and a body that is sent verbatim
-- (no JSON-encode, no Junjo.Null substitution). Used by groups.bulkInvite
-- to deliver a CSV body.
function Http:postRaw(path: string, body: string, contentType: string): any
	return send(self, "POST", path, body, contentType)
end

function Http:patch(path: string, body: any): any
	return send(self, "PATCH", path, body, nil)
end

function Http:put(path: string, body: any): any
	return send(self, "PUT", path, body, nil)
end

-- DELETE with an optional JSON body. Most Junjo routes take a body-less
-- DELETE; groups:unban sends `{ actorUserId }` for moderator
-- attribution when the caller supplies one.
function Http:delete(path: string, body: any): any
	return send(self, "DELETE", path, body, nil)
end

return Http
