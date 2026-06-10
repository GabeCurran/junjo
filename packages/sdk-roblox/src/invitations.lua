--!nonstrict
-- Nonstrict, not strict: cross-module `require(script.Parent.X)` types
-- and the metatable-OOP idiom below need the Roblox definition files to
-- pass strict analysis, which CI cannot run yet. Public signatures
-- carry annotations regardless.
--
-- Invitations namespace. Mirrors the TypeScript SDK's `junjo.invitations`
-- surface (list, get-by-code, revoke). Accept / decline live on
-- `junjo.groups` to match the TS SDK shape.

local tryGet = require(script.Parent.TryGet)

local Invitations = {}
Invitations.__index = Invitations

function Invitations.new(http)
	local self = setmetatable({}, Invitations)
	self._http = http
	return self
end

function Invitations:list(
	groupId: string,
	opts: { limit: number?, cursor: string?, includeExpired: boolean?, includeUsed: boolean? }?
)
	local query = {}
	if opts and opts.limit ~= nil then
		table.insert(query, "limit=" .. self._http:encode(opts.limit))
	end
	if opts and opts.cursor ~= nil then
		table.insert(query, "cursor=" .. self._http:encode(opts.cursor))
	end
	if opts and opts.includeExpired ~= nil then
		table.insert(query, "includeExpired=" .. tostring(opts.includeExpired))
	end
	if opts and opts.includeUsed ~= nil then
		table.insert(query, "includeUsed=" .. tostring(opts.includeUsed))
	end
	local path = "/v1/groups/" .. self._http:encode(groupId) .. "/invitations"
	if #query > 0 then
		path = path .. "?" .. table.concat(query, "&")
	end
	return self._http:get(path)
end

function Invitations:get(code: string)
	return tryGet(self._http, "/v1/invitations/" .. self._http:encode(code))
end

function Invitations:revoke(code: string)
	self._http:delete("/v1/invitations/" .. self._http:encode(code))
end

return Invitations
