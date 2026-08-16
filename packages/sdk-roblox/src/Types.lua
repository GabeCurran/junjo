--!nonstrict
-- Nonstrict, not strict: consumers require this module via
-- `require(script.Parent.Types)`, which needs the Roblox definition
-- files to pass strict analysis, which CI cannot run yet.
--
-- Shared response-shape types for the Junjo.io Roblox SDK. Pure type
-- exports: the module returns an empty table at runtime. Fields the
-- server serializes as JSON null arrive as Lua nil after JSONDecode,
-- so nullable wire fields are typed `T?` here. Timestamp fields stay
-- as ISO 8601 strings (convert via `DateTime.fromIsoDate(s)` when a
-- DateTime value is wanted).

-- One page of a cursor-paginated listing. `nextCursor` is nil on the
-- last page; feed it back as `opts.cursor` to fetch the next one, or
-- let `Junjo.pageAll` / the namespace `listAll` helpers do the loop.
export type Page<T> = {
	items: { T },
	nextCursor: string?,
}

export type Group = {
	id: string,
	gameId: string,
	kind: string,
	name: string,
	visibility: "public" | "invite-only" | "secret",
	metadata: { [string]: any },
	defaultRoleId: string?,
	parentGroupId: string?,
	memberCount: number,
	hasPasscode: boolean,
	createdAt: string,
	updatedAt: string,
	softDeletedAt: string?,
}

export type Member = {
	id: string,
	groupId: string,
	userId: string,
	status: "active" | "invited" | "left" | "kicked" | "banned",
	roles: { string },
	metadata: { [string]: any },
	notesPublic: string?,
	notesPrivate: string?,
	joinedAt: string,
	bannedUntil: string?,
}

-- One set/lift event from a ban timeline. Served by both the per-group
-- route (GET /v1/groups/:id/bans/history) and the per-user game-level
-- route (GET /v1/bans/:userId/history); `scope` tells them apart.
export type BanHistoryEntry = {
	id: string,
	gameId: string,
	userId: string,
	scope: "game" | "group",
	groupId: string?,
	kind: "set" | "lifted",
	reason: string?,
	expiresAt: string?,
	eventAt: string,
	actorUserId: string?,
}

-- One game-level ban row (POST/GET /v1/bans). `userId` and `bannedBy`
-- carry the dev's external user ids. `expiresAt` nil = permanent.
export type GameBan = {
	id: string,
	gameId: string,
	userId: string,
	bannedAt: string,
	expiresAt: string?,
	reason: string?,
	bannedBy: string?,
}

-- One pending friend request (Junjo.io friends surface). The
-- `*JunjoUserId` field names are historical; the VALUES are the dev's
-- external user ids in v1.
export type FriendRequest = {
	id: string,
	gameId: string,
	actorJunjoUserId: string,
	targetJunjoUserId: string,
	createdAt: string,
}

-- GET /v1/users/:userId/friend-requests. A direction filter empties
-- (not omits) the other side.
export type FriendRequestList = {
	inbound: { FriendRequest },
	outbound: { FriendRequest },
}

-- One confirmed friendship from the requested user's POV; the
-- `junjoUserId` is the OTHER party (external id).
export type Friendship = {
	id: string,
	gameId: string,
	junjoUserId: string,
	since: string,
}

-- POST /v1/users/:userId/friend-requests. Exactly one of `request`
-- (status = "pending") or `friendship` (status = "auto-accepted") is
-- present.
export type FriendRequestSendResult = {
	status: "pending" | "auto-accepted",
	request: FriendRequest?,
	friendship: Friendship?,
}

-- One block row from the blocking user's POV; `junjoUserId` is the
-- blocked party (external id).
export type Block = {
	id: string,
	gameId: string,
	junjoUserId: string,
	blockedAt: string,
}

-- A per-user friend label. Private to its owner (`junjoUserId`, the
-- external id); `color` is nil until set.
export type FriendTag = {
	id: string,
	gameId: string,
	junjoUserId: string,
	name: string,
	color: string?,
	createdAt: string,
}

-- PUT /v1/users/:userId/friends/:otherUserId/tags: the replaced tag
-- set on one friend.
export type FriendTagAssignment = {
	friendJunjoUserId: string,
	tagIds: { string },
}

-- GET/PATCH /v1/users/:userId/visibility. `allowed` is the set the
-- game permits; `updatedAt` is nil until the user first overrides the
-- game default.
export type UserVisibilitySettings = {
	gameId: string,
	junjoUserId: string,
	friendsListVisibility: "public" | "friends-only" | "private",
	allowed: { string },
	updatedAt: string?,
}

-- One mutual-friend suggestion (GET /v1/users/:userId/friends/
-- suggestions). `sampleMutualJunjoUserIds` carries up to 5 of the
-- mutual friends for "you know A, B, +N others" UX.
export type FriendSuggestion = {
	junjoUserId: string,
	mutualCount: number,
	sampleMutualJunjoUserIds: { string },
}

-- GET /v1/users/:viewerUserId/friends/:otherUserId/relationship.
-- `since` is nil exactly when `state` is "none".
export type FriendshipRelationship = {
	state: "none" | "friends" | "request_outgoing" | "request_incoming" | "blocked_by_me" | "blocked_by_them",
	since: string?,
}

-- One invitation row. Served by the per-group list
-- (GET /v1/groups/:id/invitations) and the public preview
-- (GET /v1/invitations/:code). `targetUserId` is nil for open-code
-- invites; `roleId` is a stored hint, not auto-applied on accept.
-- `expiresAt` nil = never expires; `usedAt` / `usedBy` are nil until
-- the code is redeemed. `createdBy` is nil (no actor is wired through
-- the create path in v1).
export type Invitation = {
	id: string,
	groupId: string,
	code: string,
	roleId: string?,
	targetUserId: string?,
	createdBy: string?,
	createdAt: string,
	expiresAt: string?,
	usedAt: string?,
	usedBy: string?,
}

-- GET /v1/whoami: which game the configured API key belongs to.
export type KeyInfo = {
	gameId: string,
}

-- GET /v1/permissions/check and each entry of the batch response.
-- `source` is one of "role", "override", "default", "none".
-- `viaRoleId` is present only when source is "role"; `viaGroupId` only
-- on an inherited check that resolved to a decision.
export type PermissionCheckResult = {
	allowed: boolean,
	source: string,
	viaRoleId: string?,
	viaGroupId: string?,
}

-- One entry of a POST /v1/permissions/check-batch request.
export type PermissionCheckRequest = {
	userId: string,
	groupId: string,
	permission: string,
}

return {}
