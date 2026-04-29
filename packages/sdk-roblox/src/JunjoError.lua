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

function JunjoError.raise(message, code, status)
	error(JunjoError.new(message, code, status), 0)
end

return JunjoError
