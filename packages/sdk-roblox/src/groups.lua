-- Groups namespace. Mirrors the TypeScript SDK's `junjo.groups` surface
-- (groups CRUD, membership operations, group relationships, sub-group
-- hierarchy). The TS SDK's `subscribe` (SSE stream) is intentionally
-- omitted: Roblox HttpService does not stream. Roblox real-time will
-- arrive post-V1 via MessagingService.
--
-- Every method returns the parsed server response verbatim (table /
-- string / number / nil). Timestamp fields stay as ISO 8601 strings
-- (Roblox callers can convert via `DateTime.fromIsoDate(s)` when they
-- want a DateTime value). A field cleared on the server is returned
-- as `nil` in the parsed table; pass `Junjo.Null` to send a JSON null.

local JunjoError = require(script.Parent.JunjoError)
local Null = require(script.Parent.Null)

local Groups = {}
Groups.__index = Groups

function Groups.new(http, inviteBaseUrl)
	local self = setmetatable({}, Groups)
	self._http = http
	self._inviteBaseUrl = inviteBaseUrl
	return self
end

-- Catch a "not_found" JunjoError and translate it to nil (matches the
-- TypeScript SDK's `Promise<X | null>` shape for single-row lookups).
-- Other errors re-throw verbatim.
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

-- ============================================================
-- CRUD
-- ============================================================

function Groups:create(input)
	return self._http:post("/v1/groups", input)
end

function Groups:get(id)
	return tryGet(self._http, "/v1/groups/" .. self._http:encode(id))
end

function Groups:list(opts)
	local query = {}
	if opts and opts.limit ~= nil then
		table.insert(query, "limit=" .. self._http:encode(opts.limit))
	end
	if opts and opts.cursor ~= nil then
		table.insert(query, "cursor=" .. self._http:encode(opts.cursor))
	end
	if opts and opts.gameId ~= nil then
		table.insert(query, "gameId=" .. self._http:encode(opts.gameId))
	end
	local path = "/v1/groups"
	if #query > 0 then
		path = path .. "?" .. table.concat(query, "&")
	end
	return self._http:get(path)
end

function Groups:update(id, input)
	return self._http:patch("/v1/groups/" .. self._http:encode(id), input)
end

function Groups:delete(id, opts)
	local path = "/v1/groups/" .. self._http:encode(id)
	if opts and opts.hard then
		path = path .. "?hard=true"
	end
	self._http:delete(path)
end

function Groups:restore(id)
	return self._http:post("/v1/groups/" .. self._http:encode(id) .. "/restore", nil)
end

-- ============================================================
-- Membership
-- ============================================================

function Groups:inviteByUserId(groupId, userId, opts)
	local body = { targetUserId = userId }
	if opts and opts.roleId ~= nil then
		body.roleId = opts.roleId
	end
	return self._http:post(
		"/v1/groups/" .. self._http:encode(groupId) .. "/invitations",
		body
	)
end

function Groups:inviteByCode(groupId, input)
	local body = {}
	if input then
		if input.roleId ~= nil then body.roleId = input.roleId end
		if input.expiresIn ~= nil then body.expiresIn = input.expiresIn end
	end
	return self._http:post(
		"/v1/groups/" .. self._http:encode(groupId) .. "/invitations",
		body
	)
end

function Groups:inviteByLink(groupId, input)
	local invitation = self:inviteByCode(groupId, input)
	local url = self._inviteBaseUrl .. "/invite/" .. self._http:encode(invitation.code)
	return { invitation = invitation, url = url }
end

-- Bulk-invite a list of user ids via a single text/csv body. Each
-- non-empty line is one user id; the server returns
-- `{ invited, skipped, errors }`. The TypeScript SDK accepts a
-- `ReadableStream<Uint8Array>` body too; the Roblox version takes a
-- string only since HttpService does not consume streams.
function Groups:bulkInvite(groupId, csv, opts)
	local path = "/v1/groups/" .. self._http:encode(groupId) .. "/bulk-invite"
	if opts and opts.roleId ~= nil then
		path = path .. "?roleId=" .. self._http:encode(opts.roleId)
	end
	return self._http:postRaw(path, csv, "text/csv")
end

function Groups:acceptInvitation(code, userId)
	return self._http:post(
		"/v1/invitations/" .. self._http:encode(code) .. "/accept",
		{ userId = userId }
	)
end

function Groups:declineInvitation(code, opts)
	local body = {}
	if opts and opts.userId ~= nil then
		body.userId = opts.userId
	end
	self._http:post("/v1/invitations/" .. self._http:encode(code) .. "/decline", body)
end

function Groups:leave(groupId, userId)
	return self._http:post(
		"/v1/groups/" .. self._http:encode(groupId) .. "/leave",
		{ userId = userId }
	)
end

function Groups:kick(groupId, userId, opts)
	local body = {}
	if opts and opts.reason ~= nil then
		body.reason = opts.reason
	end
	return self._http:post(
		"/v1/groups/" .. self._http:encode(groupId)
			.. "/members/" .. self._http:encode(userId) .. "/kick",
		body
	)
end

-- ============================================================
-- Group relationships
-- ============================================================

function Groups:setRelationship(groupAId, groupBId, relationshipType, opts)
	local body = { type = relationshipType }
	if opts and opts.mutual ~= nil then
		body.mutual = opts.mutual
	end
	return self._http:put(
		"/v1/groups/" .. self._http:encode(groupAId)
			.. "/relationships/" .. self._http:encode(groupBId),
		body
	)
end

function Groups:clearRelationship(groupAId, groupBId, opts)
	local path = "/v1/groups/" .. self._http:encode(groupAId)
		.. "/relationships/" .. self._http:encode(groupBId)
	if opts and opts.mutual then
		path = path .. "?mutual=true"
	end
	self._http:delete(path)
end

function Groups:getRelationship(groupAId, groupBId)
	return tryGet(
		self._http,
		"/v1/groups/" .. self._http:encode(groupAId)
			.. "/relationships/" .. self._http:encode(groupBId)
	)
end

function Groups:listRelationships(groupId)
	return self._http:get(
		"/v1/groups/" .. self._http:encode(groupId) .. "/relationships"
	)
end

-- ============================================================
-- Sub-groups
-- ============================================================

-- Set the parent of a group. Pass a string parent id to set, or pass
-- `nil` / `Junjo.Null` to clear. Lua nil and the explicit Null sentinel
-- are both treated as "clear parent" because Lua tables cannot carry
-- plain nil values; the server requires the `parentGroupId` field to be
-- present (as either a string or JSON null), so the SDK substitutes
-- Null on the wire.
function Groups:setParent(groupId, parentGroupId)
	local value = parentGroupId
	if value == nil then
		value = Null
	end
	return self._http:put(
		"/v1/groups/" .. self._http:encode(groupId) .. "/parent",
		{ parentGroupId = value }
	)
end

function Groups:listChildren(groupId)
	return self._http:get(
		"/v1/groups/" .. self._http:encode(groupId) .. "/children"
	)
end

return Groups
