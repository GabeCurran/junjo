--!nonstrict
-- Nonstrict, not strict: cross-module `require(script.Parent.X)` types
-- and the metatable-OOP idiom below need the Roblox definition files to
-- pass strict analysis, which CI cannot run yet. Public signatures
-- carry annotations regardless.
--
-- Friends namespace. Mirrors the Junjo.io TypeScript SDK's
-- `junjo.friends` surface: the friendship list / remove /
-- getRelationship / suggestions methods plus the `requests`, `blocks`,
-- `tags`, and `visibility` sub-namespaces. Mirrors the server routes in
-- packages/server/src/routes/{friends,friendTags,visibility,
-- suggestions}.ts.
--
-- Roblox game servers are TRUSTED callers: they hold the per-game
-- `jk_` key, so the full friends surface (acting on behalf of any
-- player) is legitimately available server-side. Never ship the key to
-- clients; route player actions through your own server code.
--
-- Identity contract: every `userId` / `targetJunjoUserId` /
-- `otherUserId` parameter carries the dev's EXTERNAL user id (for
-- Roblox, typically `tostring(player.UserId)`). Wire fields named
-- `junjoUserId` / `actorJunjoUserId` / `targetJunjoUserId` also carry
-- external ids in v1; the names are historical.
--
-- Every method returns the parsed server response verbatim. Timestamp
-- fields stay as ISO 8601 strings (convert via `DateTime.fromIsoDate`
-- when a DateTime value is wanted).

local JunjoError = require(script.Parent.JunjoError)
local pageAll = require(script.Parent.PageAll)
local Types = require(script.Parent.Types)

type FriendRequest = Types.FriendRequest
type FriendRequestList = Types.FriendRequestList
type FriendRequestSendResult = Types.FriendRequestSendResult
type Friendship = Types.Friendship
type FriendshipRelationship = Types.FriendshipRelationship
type FriendSuggestion = Types.FriendSuggestion
type Block = Types.Block
type FriendTag = Types.FriendTag
type FriendTagAssignment = Types.FriendTagAssignment
type UserVisibilitySettings = Types.UserVisibilitySettings
type Page<T> = Types.Page<T>

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

-- ============================================================
-- friends.requests sub-namespace
-- ============================================================

local Requests = {}
Requests.__index = Requests

function Requests.new(http)
	local self = setmetatable({}, Requests)
	self._http = http
	return self
end

-- Pending friend requests for the user, inbound and outbound.
-- `opts.direction` ("in" / "out" / "both") filters to one side; the
-- omitted side comes back as an empty array.
function Requests:list(userId: string, opts: { direction: string? }?): FriendRequestList
	local path = "/v1/users/" .. self._http:encode(userId) .. "/friend-requests"
	if opts and opts.direction ~= nil then
		path = path .. "?direction=" .. self._http:encode(opts.direction)
	end
	return self._http:get(path)
end

-- Sends a friend request from userId to targetJunjoUserId. The result's
-- `status` is "pending" (with the created `request`) or "auto-accepted"
-- (with the new `friendship`, when the game's config does not require
-- explicit acceptance).
function Requests:send(userId: string, targetJunjoUserId: string): FriendRequestSendResult
	return self._http:post(
		"/v1/users/" .. self._http:encode(userId) .. "/friend-requests",
		{ targetJunjoUserId = targetJunjoUserId }
	)
end

-- Accepts an inbound request and returns the resulting friendship.
function Requests:accept(requestId: string): Friendship
	return self._http:post(
		"/v1/friend-requests/" .. self._http:encode(requestId) .. "/accept",
		nil
	)
end

-- Declines an inbound request (the recipient says no).
function Requests:decline(requestId: string)
	self._http:post(
		"/v1/friend-requests/" .. self._http:encode(requestId) .. "/decline",
		nil
	)
end

-- Cancels an outbound request (the sender retracts it).
function Requests:cancel(requestId: string)
	self._http:delete("/v1/friend-requests/" .. self._http:encode(requestId))
end

-- ============================================================
-- friends.blocks sub-namespace
-- ============================================================

local Blocks = {}
Blocks.__index = Blocks

function Blocks.new(http)
	local self = setmetatable({}, Blocks)
	self._http = http
	return self
end

-- Everyone the user has blocked, newest-first. Server response is the
-- `{ items }` envelope; the SDK flattens to a plain array for
-- ergonomics (matches the TypeScript SDK).
function Blocks:list(userId: string): { Block }
	local res = self._http:get("/v1/users/" .. self._http:encode(userId) .. "/blocks")
	if type(res) == "table" and res.items ~= nil then
		return res.items
	end
	return {}
end

-- Blocks another user. Idempotent: blocking the same target twice
-- returns the existing row. A block also removes any friendship or
-- pending request between the pair.
function Blocks:add(userId: string, targetJunjoUserId: string): Block
	return self._http:post(
		"/v1/users/" .. self._http:encode(userId) .. "/blocks",
		{ targetJunjoUserId = targetJunjoUserId }
	)
end

-- Unblocks a previously blocked user. A missing block raises a
-- JunjoError with code = "not_found".
function Blocks:remove(userId: string, otherUserId: string)
	self._http:delete(
		"/v1/users/" .. self._http:encode(userId)
			.. "/blocks/" .. self._http:encode(otherUserId)
	)
end

-- ============================================================
-- friends.tags sub-namespace
-- ============================================================

local Tags = {}
Tags.__index = Tags

function Tags.new(http)
	local self = setmetatable({}, Tags)
	self._http = http
	return self
end

-- The user's tags, name-ascending. Flattened from the `{ items }`
-- envelope like blocks:list.
function Tags:list(userId: string): { FriendTag }
	local res = self._http:get("/v1/users/" .. self._http:encode(userId) .. "/friend-tags")
	if type(res) == "table" and res.items ~= nil then
		return res.items
	end
	return {}
end

function Tags:create(userId: string, input: { name: string, color: string? }): FriendTag
	if input == nil then
		JunjoError.raise(
			"friends.tags:create(userId, input) requires an input table",
			"invalid_config",
			nil
		)
	end
	local body = { name = input.name }
	if input.color ~= nil then
		body.color = input.color
	end
	return self._http:post(
		"/v1/users/" .. self._http:encode(userId) .. "/friend-tags",
		body
	)
end

-- Renames or recolors a tag. Pass `Junjo.Null` as `patch.color` to
-- clear the color (Lua nil means "leave unchanged").
function Tags:update(tagId: string, patch: { name: string?, color: any? }): FriendTag
	if patch == nil then
		JunjoError.raise(
			"friends.tags:update(tagId, patch) requires a patch table",
			"invalid_config",
			nil
		)
	end
	local body = {}
	if patch.name ~= nil then body.name = patch.name end
	if patch.color ~= nil then body.color = patch.color end
	return self._http:patch("/v1/friend-tags/" .. self._http:encode(tagId), body)
end

function Tags:delete(tagId: string)
	self._http:delete("/v1/friend-tags/" .. self._http:encode(tagId))
end

-- Replaces the full set of tags on one friend (PUT semantics). Pass an
-- empty array to clear every tag.
function Tags:assign(userId: string, otherUserId: string, tagIds: { string }): FriendTagAssignment
	if tagIds == nil then
		JunjoError.raise(
			"friends.tags:assign(userId, otherUserId, tagIds) requires a tagIds array",
			"invalid_config",
			nil
		)
	end
	return self._http:put(
		"/v1/users/" .. self._http:encode(userId)
			.. "/friends/" .. self._http:encode(otherUserId) .. "/tags",
		{ tagIds = tagIds }
	)
end

-- ============================================================
-- friends.visibility sub-namespace
-- ============================================================

local Visibility = {}
Visibility.__index = Visibility

function Visibility.new(http)
	local self = setmetatable({}, Visibility)
	self._http = http
	return self
end

-- The user's friends-list visibility settings. `updatedAt` is nil
-- until the user first overrides the game default.
function Visibility:get(userId: string): UserVisibilitySettings
	return self._http:get("/v1/users/" .. self._http:encode(userId) .. "/visibility")
end

-- Sets the user's friends-list visibility. The value must be in the
-- game's allowed set (surfaced as `allowed` on `get`); otherwise the
-- server returns 400.
function Visibility:set(userId: string, value: string): UserVisibilitySettings
	return self._http:patch(
		"/v1/users/" .. self._http:encode(userId) .. "/visibility",
		{ friendsListVisibility = value }
	)
end

-- ============================================================
-- Top-level friends namespace
-- ============================================================

local Friends = {}
Friends.__index = Friends

function Friends.new(http)
	local self = setmetatable({}, Friends)
	self._http = http
	self.requests = Requests.new(http)
	self.blocks = Blocks.new(http)
	self.tags = Tags.new(http)
	self.visibility = Visibility.new(http)
	return self
end

-- Cursor-paginated friends list, newest-first by acceptance time.
-- `opts.tagId` filters to one tag; `opts.viewer` applies the owner's
-- visibility settings from that user's perspective (without it the
-- caller is treated as admin and sees everything).
function Friends:list(
	userId: string,
	opts: { limit: number?, cursor: string?, tagId: string?, viewer: string? }?
): Page<Friendship>
	local query = {}
	if opts and opts.limit ~= nil then
		table.insert(query, "limit=" .. self._http:encode(opts.limit))
	end
	if opts and opts.cursor ~= nil then
		table.insert(query, "cursor=" .. self._http:encode(opts.cursor))
	end
	if opts and opts.tagId ~= nil then
		table.insert(query, "tagId=" .. self._http:encode(opts.tagId))
	end
	if opts and opts.viewer ~= nil then
		table.insert(query, "viewer=" .. self._http:encode(opts.viewer))
	end
	local path = "/v1/users/" .. self._http:encode(userId) .. "/friends"
	if #query > 0 then
		path = path .. "?" .. table.concat(query, "&")
	end
	return self._http:get(path)
end

-- Generic-for iterator over `list(...)` that walks every page until
-- `nextCursor` is nil. `opts.tagId` and `opts.viewer` filter exactly
-- as on `list`; `opts.cursor` is owned by the iterator and ignored if
-- supplied.
function Friends:listAll(
	userId: string,
	opts: { limit: number?, tagId: string?, viewer: string? }?
): () -> Friendship?
	return pageAll(function(cursor)
		return self:list(userId, withCursor(opts, cursor))
	end)
end

-- Ends a friendship (both sides; unfriending is symmetric). A missing
-- friendship raises a JunjoError with code = "not_found".
function Friends:remove(userId: string, otherUserId: string)
	self._http:delete(
		"/v1/users/" .. self._http:encode(userId)
			.. "/friends/" .. self._http:encode(otherUserId)
	)
end

-- Single-pair viewer-perspective relationship probe. Use on a profile
-- view to render the right button in one round-trip instead of paging
-- through list(). Always returns a `{ state, since }` table; a pair
-- with no relationship (including never-seen users) comes back as
-- `state = "none"` with a nil `since`, NOT as a 404. Priority order
-- baked into the server resolver: blocks (viewer-side wins on the
-- both-blocked edge), friendship, pending request direction, none.
function Friends:getRelationship(viewerUserId: string, otherUserId: string): FriendshipRelationship
	return self._http:get(
		"/v1/users/" .. self._http:encode(viewerUserId)
			.. "/friends/" .. self._http:encode(otherUserId) .. "/relationship"
	)
end

-- Mutual-friend suggestions for the user, ranked by mutual count.
-- Flattened from the `{ items }` envelope like blocks:list.
function Friends:suggestions(userId: string, opts: { limit: number? }?): { FriendSuggestion }
	local path = "/v1/users/" .. self._http:encode(userId) .. "/friends/suggestions"
	if opts and opts.limit ~= nil then
		path = path .. "?limit=" .. self._http:encode(opts.limit)
	end
	local res = self._http:get(path)
	if type(res) == "table" and res.items ~= nil then
		return res.items
	end
	return {}
end

return Friends
