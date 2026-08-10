--!strict
-- JunjoError: structured error value raised by the Junjo.io SDK for Roblox on
-- non-2xx responses, network failures, and configuration errors. Mirrors
-- the other Junjo.io SDKs' JunjoError shape:
-- { name, message, code, status, requestId, retryAfterSeconds }.
-- The `code` field is stable across releases; branch on `err.code` rather
-- than `err.message`.
--
-- `requestId` carries the server's x-request-id from the failing response
-- (nil when the header is absent or no response was received); quote it in
-- bug reports. `retryAfterSeconds` carries the integer seconds from a
-- Retry-After response header (present primarily on 429, nil otherwise);
-- honor it in your own backoff, since the opt-in retry policy only honors
-- it internally.
--
-- Errors are raised with `error(table, 0)` to suppress Lua's automatic
-- file:line prefix so the value `pcall` returns is the raw JunjoError
-- table. Consumers branch on `Junjo.JunjoError.is(err)` after `pcall`.

local JunjoError = {}
JunjoError.__index = JunjoError

export type JunjoError = typeof(setmetatable(
	{} :: {
		name: string,
		message: string,
		code: string,
		status: number?,
		requestId: string?,
		retryAfterSeconds: number?,
	},
	JunjoError
))

-- `message` and `code` accept any value (server envelopes are untrusted
-- JSON); both are rendered with `tostring`. `requestId` and
-- `retryAfterSeconds` are set by the transport from the failing response
-- headers and are nil for config and transport failures that carry no
-- response.
function JunjoError.new(
	message: any,
	code: any,
	status: number?,
	requestId: string?,
	retryAfterSeconds: number?
): JunjoError
	local self = setmetatable({}, JunjoError)
	self.name = "JunjoError"
	self.message = tostring(message or "request failed")
	self.code = tostring(code or "internal")
	self.status = status
	self.requestId = requestId
	self.retryAfterSeconds = retryAfterSeconds
	return self
end

function JunjoError.is(value: any): boolean
	return type(value) == "table" and getmetatable(value) == JunjoError
end

function JunjoError.__tostring(self: JunjoError): string
	if self.status ~= nil then
		return string.format("JunjoError(%s, %d): %s", self.code, self.status, self.message)
	end
	return string.format("JunjoError(%s): %s", self.code, self.message)
end

function JunjoError.raise(
	message: any,
	code: any,
	status: number?,
	requestId: string?,
	retryAfterSeconds: number?
): never
	error(JunjoError.new(message, code, status, requestId, retryAfterSeconds), 0)
end

return JunjoError
