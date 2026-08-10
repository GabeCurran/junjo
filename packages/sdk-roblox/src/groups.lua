--!nonstrict
-- Nonstrict, not strict: cross-module `require(script.Parent.X)` types
-- and the metatable-OOP idiom below need the Roblox definition files to
-- pass strict analysis, which CI cannot run yet. Public signatures
-- carry annotations regardless.
--
-- Groups namespace. Mirrors the TypeScript SDK's `junjo.groups` surface
-- (groups CRUD, membership operations, per-group bans, group
-- relationships, sub-group hierarchy). The TS SDK's `subscribe` (SSE
-- stream) is intentionally
-- omitted: Roblox HttpService does not stream. Roblox real-time will
-- arrive post-V1 via MessagingService.
--
-- Roblox game servers are TRUSTED callers: they hold the per-game
-- `jk_` key, so the full groups surface (membership, moderation,
-- relationships) is legitimately available server-side. Never ship the
-- key to clients.
--
-- Every method returns the parsed server response verbatim (table /
-- string / number / nil). Timestamp fields stay as ISO 8601 strings
-- (Roblox callers can convert via `DateTime.fromIsoDate(s)` when they
-- want a DateTime value). A field cleared on the server is returned
-- as `nil` in the parsed table; pass `Junjo.Null` to send a JSON null.

local JunjoError = require(script.Parent.JunjoError)
local Null = require(script.Parent.Null)
local tryGet = require(script.Parent.TryGet)
local pageAll = require(script.Parent.PageAll)
local Types = require(script.Parent.Types)

type Group = Types.Group
type Member = Types.Member
type BanHistoryEntry = Types.BanHistoryEntry
type Page<T> = Types.Page<T>

local Groups = {}
Groups.__index = Groups

-- Shallow-copies opts so a pageAll loop can vary the cursor without
-- mutating the caller's table.
local function withCursor(opts, cursor: string?)
	local merged = {}
	if opts then
		for k, v in pairs(opts) do
			merged[k] = v
		end
	end
	merged.cursor = cursor
	return merged
end

function Groups.new(http, inviteBaseUrl: string)
	local self = setmetatable({}, Groups)
	self._http = http
	self._inviteBaseUrl = inviteBaseUrl
	return self
end

-- ============================================================
-- CRUD
-- ============================================================

function Groups:create(input: { [string]: any })
	if input == nil then
		JunjoError.raise("groups:create(input) requires an input table", "invalid_config", nil)
	end
	return self._http:post("/v1/groups", input)
end

-- Pass `opts.viewer` (an external userId) to scope visibility to that
-- user; secret groups they aren't an active member of return nil.
-- Without it the server treats the call as admin/server-side and
-- returns the group regardless of visibility.
function Groups:get(id: string, opts: { viewer: string? }?): Group?
	local path = "/v1/groups/" .. self._http:encode(id)
	if opts and opts.viewer ~= nil then
		path = path .. "?viewer=" .. self._http:encode(opts.viewer)
	end
	return tryGet(self._http, path)
end

-- `opts.viewer` filters out secret groups the viewer isn't an active
-- member of (same semantics as `get`).
function Groups:list(opts: { limit: number?, cursor: string?, gameId: string?, viewer: string? }?): Page<Group>
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
	if opts and opts.viewer ~= nil then
		table.insert(query, "viewer=" .. self._http:encode(opts.viewer))
	end
	local path = "/v1/groups"
	if #query > 0 then
		path = path .. "?" .. table.concat(query, "&")
	end
	return self._http:get(path)
end

-- Generic-for iterator over `list(...)` that walks every page until
-- `nextCursor` is nil. Use when you genuinely need every group; prefer
-- `list(...)` with explicit pagination for UI surfaces. `opts.limit`
-- is the per-page size hint (server-capped); `opts.cursor` is owned by
-- the iterator and ignored if supplied.
function Groups:listAll(opts: { limit: number?, gameId: string?, viewer: string? }?): () -> Group?
	return pageAll(function(cursor)
		return self:list(withCursor(opts, cursor))
	end)
end

function Groups:update(id: string, input: { [string]: any })
	if input == nil then
		JunjoError.raise("groups:update(id, input) requires an input table", "invalid_config", nil)
	end
	return self._http:patch("/v1/groups/" .. self._http:encode(id), input)
end

function Groups:delete(id: string, opts: { hard: boolean? }?)
	local path = "/v1/groups/" .. self._http:encode(id)
	if opts and opts.hard then
		path = path .. "?hard=true"
	end
	self._http:delete(path)
end

function Groups:restore(id: string)
	return self._http:post("/v1/groups/" .. self._http:encode(id) .. "/restore", nil)
end

-- ============================================================
-- Membership
-- ============================================================

function Groups:inviteByUserId(groupId: string, userId: string, opts: { roleId: string? }?)
	local body = { targetUserId = userId }
	if opts and opts.roleId ~= nil then
		body.roleId = opts.roleId
	end
	return self._http:post(
		"/v1/groups/" .. self._http:encode(groupId) .. "/invitations",
		body
	)
end

function Groups:inviteByCode(groupId: string, input: { roleId: string?, expiresIn: any? }?)
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

function Groups:inviteByLink(groupId: string, input: { roleId: string?, expiresIn: any? }?)
	local invitation = self:inviteByCode(groupId, input)
	local url = self._inviteBaseUrl .. "/invite/" .. self._http:encode(invitation.code)
	return { invitation = invitation, url = url }
end

-- Bulk-invite a list of user ids via a single text/csv body. Each
-- non-empty line is one user id; the server returns
-- `{ invited, skipped, errors }`. The TypeScript SDK accepts a
-- `ReadableStream<Uint8Array>` body too; the Roblox version takes a
-- string only since HttpService does not consume streams.
function Groups:bulkInvite(groupId: string, csv: string, opts: { roleId: string? }?)
	local path = "/v1/groups/" .. self._http:encode(groupId) .. "/bulk-invite"
	if opts and opts.roleId ~= nil then
		path = path .. "?roleId=" .. self._http:encode(opts.roleId)
	end
	return self._http:postRaw(path, csv, "text/csv")
end

function Groups:acceptInvitation(code: string, userId: string)
	return self._http:post(
		"/v1/invitations/" .. self._http:encode(code) .. "/accept",
		{ userId = userId }
	)
end

function Groups:declineInvitation(code: string, opts: { userId: string? }?)
	local body = {}
	if opts and opts.userId ~= nil then
		body.userId = opts.userId
	end
	self._http:post("/v1/invitations/" .. self._http:encode(code) .. "/decline", body)
end

function Groups:leave(groupId: string, userId: string)
	return self._http:post(
		"/v1/groups/" .. self._http:encode(groupId) .. "/leave",
		{ userId = userId }
	)
end

-- Open join. The server enforces that the group's `visibility` is
-- "public"; invite-only groups return 403 and secret groups return 404.
-- Pass `opts.passcode` when the group has `hasPasscode = true`; the
-- server returns 403 passcode_required / passcode_invalid otherwise.
function Groups:join(groupId: string, userId: string, opts: { passcode: string? }?): Member
	local body = { userId = userId }
	if opts and opts.passcode ~= nil then
		body.passcode = opts.passcode
	end
	return self._http:post(
		"/v1/groups/" .. self._http:encode(groupId) .. "/join",
		body
	)
end

function Groups:kick(groupId: string, userId: string, opts: { reason: string? }?)
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
-- Per-group bans
-- ============================================================

-- Per-group ban. Distinct from kick: the banned user cannot rejoin via
-- public-join or invitation accept; those routes return 403 with
-- `code = "banned"`. `opts.expiresAt` (an ISO 8601 string) enables
-- time-bounded bans; omit it for a permanent ban. `opts.actorUserId`
-- attributes the action to a specific moderator in audit + events.
function Groups:ban(
	groupId: string,
	userId: string,
	opts: { reason: string?, expiresAt: string?, actorUserId: string? }?
): Member
	local body = {}
	if opts then
		if opts.reason ~= nil then body.reason = opts.reason end
		if opts.expiresAt ~= nil then body.expiresAt = opts.expiresAt end
		if opts.actorUserId ~= nil then body.actorUserId = opts.actorUserId end
	end
	return self._http:post(
		"/v1/groups/" .. self._http:encode(groupId)
			.. "/members/" .. self._http:encode(userId) .. "/ban",
		body
	)
end

-- Lift a per-group ban. The body is genuinely optional on the server
-- (no actor = null actor), so the DELETE goes out body-less unless
-- `opts.actorUserId` is supplied.
function Groups:unban(groupId: string, userId: string, opts: { actorUserId: string? }?): Member
	local body = nil
	if opts and opts.actorUserId ~= nil then
		body = { actorUserId = opts.actorUserId }
	end
	return self._http:delete(
		"/v1/groups/" .. self._http:encode(groupId)
			.. "/members/" .. self._http:encode(userId) .. "/ban",
		body
	)
end

-- Group-scoped ban-event timeline: every set/lift on this group across
-- all users, newest-first, cursor-paginated. Game-wide bans are NOT
-- included.
function Groups:banHistory(groupId: string, opts: { limit: number?, cursor: string? }?): Page<BanHistoryEntry>
	local query = {}
	if opts and opts.limit ~= nil then
		table.insert(query, "limit=" .. self._http:encode(opts.limit))
	end
	if opts and opts.cursor ~= nil then
		table.insert(query, "cursor=" .. self._http:encode(opts.cursor))
	end
	local path = "/v1/groups/" .. self._http:encode(groupId) .. "/bans/history"
	if #query > 0 then
		path = path .. "?" .. table.concat(query, "&")
	end
	return self._http:get(path)
end

-- Generic-for iterator over `banHistory(...)`. See `listAll` for the
-- iteration contract.
function Groups:banHistoryAll(groupId: string, opts: { limit: number? }?): () -> BanHistoryEntry?
	return pageAll(function(cursor)
		return self:banHistory(groupId, withCursor(opts, cursor))
	end)
end

-- ============================================================
-- Group relationships
-- ============================================================

function Groups:setRelationship(groupAId: string, groupBId: string, relationshipType: string, opts: { mutual: boolean? }?)
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

function Groups:clearRelationship(groupAId: string, groupBId: string, opts: { mutual: boolean? }?)
	local path = "/v1/groups/" .. self._http:encode(groupAId)
		.. "/relationships/" .. self._http:encode(groupBId)
	if opts and opts.mutual then
		path = path .. "?mutual=true"
	end
	self._http:delete(path)
end

function Groups:getRelationship(groupAId: string, groupBId: string)
	return tryGet(
		self._http,
		"/v1/groups/" .. self._http:encode(groupAId)
			.. "/relationships/" .. self._http:encode(groupBId)
	)
end

function Groups:listRelationships(groupId: string)
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
function Groups:setParent(groupId: string, parentGroupId: any)
	local value = parentGroupId
	if value == nil then
		value = Null
	end
	return self._http:put(
		"/v1/groups/" .. self._http:encode(groupId) .. "/parent",
		{ parentGroupId = value }
	)
end

function Groups:listChildren(groupId: string)
	return self._http:get(
		"/v1/groups/" .. self._http:encode(groupId) .. "/children"
	)
end

return Groups
