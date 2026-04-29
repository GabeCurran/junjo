-- Members namespace. Mirrors the TypeScript SDK's `junjo.members`
-- surface (member lookups + role / permission edits + metadata / notes
-- mutations). Membership lifecycle (invite / accept / leave / kick) is
-- exposed via `junjo.groups` to match the TS SDK shape.

local JunjoError = require(script.Parent.JunjoError)

local Members = {}
Members.__index = Members

function Members.new(http)
	local self = setmetatable({}, Members)
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

local function memberPath(self, groupId, userId)
	return "/v1/groups/" .. self._http:encode(groupId)
		.. "/members/" .. self._http:encode(userId)
end

-- ============================================================
-- Lookups
-- ============================================================

function Members:get(groupId, userId)
	return tryGet(self._http, memberPath(self, groupId, userId))
end

function Members:getById(id)
	return tryGet(self._http, "/v1/members/" .. self._http:encode(id))
end

function Members:list(groupId, opts)
	local query = {}
	if opts and opts.limit ~= nil then
		table.insert(query, "limit=" .. self._http:encode(opts.limit))
	end
	if opts and opts.cursor ~= nil then
		table.insert(query, "cursor=" .. self._http:encode(opts.cursor))
	end
	local path = "/v1/groups/" .. self._http:encode(groupId) .. "/members"
	if #query > 0 then
		path = path .. "?" .. table.concat(query, "&")
	end
	return self._http:get(path)
end

function Members:listForUser(userId, opts)
	local path = "/v1/users/" .. self._http:encode(userId) .. "/members"
	if opts and opts.gameId ~= nil then
		path = path .. "?gameId=" .. self._http:encode(opts.gameId)
	end
	return self._http:get(path)
end

-- ============================================================
-- Metadata + notes
-- ============================================================

function Members:setMetadata(groupId, userId, metadata)
	return self._http:patch(memberPath(self, groupId, userId), { metadata = metadata })
end

-- Partial notes update. Pass `Junjo.Null` for either field to clear it
-- on the server; omit a field (or set it to nil) to leave it unchanged.
function Members:setNotes(groupId, userId, input)
	local body = {}
	if input.notesPublic ~= nil then body.notesPublic = input.notesPublic end
	if input.notesPrivate ~= nil then body.notesPrivate = input.notesPrivate end
	return self._http:patch(memberPath(self, groupId, userId), body)
end

-- ============================================================
-- Role assignment
-- ============================================================

function Members:assignRole(groupId, userId, roleId)
	return self._http:post(
		memberPath(self, groupId, userId) .. "/roles/" .. self._http:encode(roleId),
		nil
	)
end

function Members:removeRole(groupId, userId, roleId)
	return self._http:delete(
		memberPath(self, groupId, userId) .. "/roles/" .. self._http:encode(roleId)
	)
end

-- ============================================================
-- Permission overrides
-- ============================================================

function Members:overridePermission(groupId, userId, permission, grant)
	return self._http:post(
		memberPath(self, groupId, userId) .. "/permissions/" .. self._http:encode(permission),
		{ grant = grant }
	)
end

function Members:clearPermissionOverride(groupId, userId, permission)
	self._http:delete(
		memberPath(self, groupId, userId) .. "/permissions/" .. self._http:encode(permission)
	)
end

function Members:listPermissionOverrides(groupId, userId)
	return self._http:get(memberPath(self, groupId, userId) .. "/permissions")
end

return Members
