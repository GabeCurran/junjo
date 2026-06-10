--!nonstrict
-- Nonstrict, not strict: cross-module `require(script.Parent.X)` types
-- and the metatable-OOP idiom below need the Roblox definition files to
-- pass strict analysis, which CI cannot run yet. Public signatures
-- carry annotations regardless.
--
-- Members namespace. Mirrors the TypeScript SDK's `junjo.members`
-- surface (member lookups + role / permission edits + metadata / notes
-- mutations). Membership lifecycle (invite / accept / leave / kick) is
-- exposed via `junjo.groups` to match the TS SDK shape.

local JunjoError = require(script.Parent.JunjoError)
local tryGet = require(script.Parent.TryGet)

local Members = {}
Members.__index = Members

function Members.new(http)
	local self = setmetatable({}, Members)
	self._http = http
	return self
end

local function memberPath(self, groupId: string, userId: string): string
	return "/v1/groups/" .. self._http:encode(groupId)
		.. "/members/" .. self._http:encode(userId)
end

-- ============================================================
-- Lookups
-- ============================================================

function Members:get(groupId: string, userId: string)
	return tryGet(self._http, memberPath(self, groupId, userId))
end

function Members:getById(id: string)
	return tryGet(self._http, "/v1/members/" .. self._http:encode(id))
end

function Members:list(groupId: string, opts: { limit: number?, cursor: string? }?)
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

function Members:listForUser(userId: string, opts: { gameId: string? }?)
	local path = "/v1/users/" .. self._http:encode(userId) .. "/members"
	if opts and opts.gameId ~= nil then
		path = path .. "?gameId=" .. self._http:encode(opts.gameId)
	end
	return self._http:get(path)
end

-- ============================================================
-- Metadata + notes
-- ============================================================

function Members:setMetadata(groupId: string, userId: string, metadata: { [string]: any })
	if metadata == nil then
		JunjoError.raise(
			"members:setMetadata(groupId, userId, metadata) requires a metadata table",
			"invalid_config",
			nil
		)
	end
	return self._http:patch(memberPath(self, groupId, userId), { metadata = metadata })
end

-- Partial notes update. Pass `Junjo.Null` for either field to clear it
-- on the server; omit a field (or set it to nil) to leave it unchanged.
function Members:setNotes(groupId: string, userId: string, input: { notesPublic: any?, notesPrivate: any? })
	if input == nil then
		JunjoError.raise(
			"members:setNotes(groupId, userId, input) requires an input table",
			"invalid_config",
			nil
		)
	end
	local body = {}
	if input.notesPublic ~= nil then body.notesPublic = input.notesPublic end
	if input.notesPrivate ~= nil then body.notesPrivate = input.notesPrivate end
	return self._http:patch(memberPath(self, groupId, userId), body)
end

-- ============================================================
-- Role assignment
-- ============================================================

function Members:assignRole(groupId: string, userId: string, roleId: string)
	return self._http:post(
		memberPath(self, groupId, userId) .. "/roles/" .. self._http:encode(roleId),
		nil
	)
end

function Members:removeRole(groupId: string, userId: string, roleId: string)
	return self._http:delete(
		memberPath(self, groupId, userId) .. "/roles/" .. self._http:encode(roleId)
	)
end

-- ============================================================
-- Permission overrides
-- ============================================================

function Members:overridePermission(groupId: string, userId: string, permission: string, grant: boolean)
	return self._http:post(
		memberPath(self, groupId, userId) .. "/permissions/" .. self._http:encode(permission),
		{ grant = grant }
	)
end

function Members:clearPermissionOverride(groupId: string, userId: string, permission: string)
	self._http:delete(
		memberPath(self, groupId, userId) .. "/permissions/" .. self._http:encode(permission)
	)
end

function Members:listPermissionOverrides(groupId: string, userId: string)
	return self._http:get(memberPath(self, groupId, userId) .. "/permissions")
end

return Members
