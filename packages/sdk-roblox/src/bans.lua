--!nonstrict
-- Nonstrict, not strict: cross-module `require(script.Parent.X)` types
-- and the metatable-OOP idiom below need the Roblox definition files to
-- pass strict analysis, which CI cannot run yet. Public signatures
-- carry annotations regardless.
--
-- Game-level bans namespace. Mirrors the Junjo.io TypeScript SDK's
-- `junjo.bans` surface (add / remove / get / list / history plus the
-- listAll / historyAll iterators). Per-group bans live on the groups
-- namespace (`groups:ban` / `groups:unban`) alongside kick semantics;
-- the two compose -- server-side enforcement checks game-level first,
-- then per-group.
--
-- Roblox game servers are TRUSTED callers: they hold the per-game
-- `jk_` key, so the full moderation surface is legitimately available
-- server-side. Never ship the key to clients.
--
-- Every method returns the parsed server response verbatim. Timestamp
-- fields stay as ISO 8601 strings (convert via `DateTime.fromIsoDate`
-- when a DateTime value is wanted).

local tryGet = require(script.Parent.TryGet)
local pageAll = require(script.Parent.PageAll)
local Types = require(script.Parent.Types)

type GameBan = Types.GameBan
type BanHistoryEntry = Types.BanHistoryEntry
type Page<T> = Types.Page<T>

local Bans = {}
Bans.__index = Bans

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

function Bans.new(http)
	local self = setmetatable({}, Bans)
	self._http = http
	return self
end

-- Game-wide ban. Idempotent on a still-active ban for the same user
-- (the server returns the existing row); an expired ban is replaced by
-- a fresh one. `opts.expiresAt` (an ISO 8601 string) enables
-- time-bounded bans; omit it for a permanent ban. `opts.actorUserId`
-- attributes the action to a specific moderator in audit + history.
function Bans:add(
	userId: string,
	opts: { reason: string?, expiresAt: string?, actorUserId: string? }?
): GameBan
	local body = { userId = userId }
	if opts then
		if opts.reason ~= nil then body.reason = opts.reason end
		if opts.expiresAt ~= nil then body.expiresAt = opts.expiresAt end
		if opts.actorUserId ~= nil then body.actorUserId = opts.actorUserId end
	end
	return self._http:post("/v1/bans", body)
end

-- Lift a game-wide ban. The body is genuinely optional on the server
-- (no actor = null actor), so the DELETE goes out body-less unless
-- `opts.actorUserId` is supplied. A missing ban raises a JunjoError
-- with code = "not_found".
function Bans:remove(userId: string, opts: { actorUserId: string? }?)
	local body = nil
	if opts and opts.actorUserId ~= nil then
		body = { actorUserId = opts.actorUserId }
	end
	self._http:delete("/v1/bans/" .. self._http:encode(userId), body)
end

-- Current active game-level ban for the user, or nil when the user is
-- not banned, the ban has expired, or the user has never been seen in
-- this game (all surface as 404 on the server).
function Bans:get(userId: string): GameBan?
	return tryGet(self._http, "/v1/bans/" .. self._http:encode(userId))
end

-- Active bans, newest-first, cursor-paginated. Pass
-- `opts.includeExpired = true` to also return rows whose `expiresAt`
-- is in the past (runtime ban checks ignore those, but operators may
-- want to see them).
function Bans:list(
	opts: { limit: number?, cursor: string?, includeExpired: boolean? }?
): Page<GameBan>
	local query = {}
	if opts and opts.limit ~= nil then
		table.insert(query, "limit=" .. self._http:encode(opts.limit))
	end
	if opts and opts.cursor ~= nil then
		table.insert(query, "cursor=" .. self._http:encode(opts.cursor))
	end
	if opts and opts.includeExpired == true then
		table.insert(query, "includeExpired=true")
	end
	local path = "/v1/bans"
	if #query > 0 then
		path = path .. "?" .. table.concat(query, "&")
	end
	return self._http:get(path)
end

-- Generic-for iterator over `list(...)` that walks every page until
-- `nextCursor` is nil. `opts.limit` is the per-page size hint
-- (server-capped); `opts.cursor` is owned by the iterator and ignored
-- if supplied.
function Bans:listAll(opts: { limit: number?, includeExpired: boolean? }?): () -> GameBan?
	return pageAll(function(cursor)
		return self:list(withCursor(opts, cursor))
	end)
end

-- Append-only ban-event timeline for one user in this game,
-- newest-first, cursor-paginated. Includes both game-scope and
-- group-scope rows by default; `opts.scope` filters to one surface and
-- `opts.groupId` narrows to one group (the server forces scope=group
-- in that case, and rejects an explicit scope="game" + groupId combo).
function Bans:history(
	userId: string,
	opts: { limit: number?, cursor: string?, scope: string?, groupId: string? }?
): Page<BanHistoryEntry>
	local query = {}
	if opts and opts.limit ~= nil then
		table.insert(query, "limit=" .. self._http:encode(opts.limit))
	end
	if opts and opts.cursor ~= nil then
		table.insert(query, "cursor=" .. self._http:encode(opts.cursor))
	end
	if opts and opts.scope ~= nil then
		table.insert(query, "scope=" .. self._http:encode(opts.scope))
	end
	if opts and opts.groupId ~= nil then
		table.insert(query, "groupId=" .. self._http:encode(opts.groupId))
	end
	local path = "/v1/bans/" .. self._http:encode(userId) .. "/history"
	if #query > 0 then
		path = path .. "?" .. table.concat(query, "&")
	end
	return self._http:get(path)
end

-- Generic-for iterator over `history(...)`. See `listAll` for the
-- iteration contract.
function Bans:historyAll(
	userId: string,
	opts: { limit: number?, scope: string?, groupId: string? }?
): () -> BanHistoryEntry?
	return pageAll(function(cursor)
		return self:history(userId, withCursor(opts, cursor))
	end)
end

return Bans
