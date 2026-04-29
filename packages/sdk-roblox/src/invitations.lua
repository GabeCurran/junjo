-- Invitations namespace. Mirrors the TypeScript SDK's `junjo.invitations`
-- surface (list, get-by-code, revoke). Accept / decline live on
-- `junjo.groups` to match the TS SDK shape.

local JunjoError = require(script.Parent.JunjoError)

local Invitations = {}
Invitations.__index = Invitations

function Invitations.new(http)
	local self = setmetatable({}, Invitations)
	self._http = http
	return self
end

local function tryGet(http, path)
	local ok, result = pcall(function()
		return http:get(path)
	end)
	if ok then
		return result
	end
	if JunjoError.is(result) and result.code == "not_found" then
		return nil
	end
	error(result, 0)
end

function Invitations:list(groupId, opts)
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

function Invitations:get(code)
	return tryGet(self._http, "/v1/invitations/" .. self._http:encode(code))
end

function Invitations:revoke(code)
	self._http:delete("/v1/invitations/" .. self._http:encode(code))
end

return Invitations
