--!strict
-- JunjoError: structured error value raised by the Junjo Roblox SDK on
-- non-2xx responses, network failures, and configuration errors. Mirrors
-- the TypeScript SDK's JunjoError shape: { name, message, code, status }.
-- The `code` field is stable across releases; branch on `err.code` rather
-- than `err.message`.
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
	},
	JunjoError
))

-- `message` and `code` accept any value (server envelopes are untrusted
-- JSON); both are rendered with `tostring`.
function JunjoError.new(message: any, code: any, status: number?): JunjoError
	local self = setmetatable({}, JunjoError)
	self.name = "JunjoError"
	self.message = tostring(message or "request failed")
	self.code = tostring(code or "internal")
	self.status = status
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

function JunjoError.raise(message: any, code: any, status: number?): never
	error(JunjoError.new(message, code, status), 0)
end

return JunjoError
