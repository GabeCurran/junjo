--!nonstrict
-- Nonstrict, not strict: cross-module `require(script.X)` types and the
-- metatable-OOP idiom below need the Roblox definition files to pass
-- strict analysis, which CI cannot run yet. Public signatures carry
-- annotations regardless.
--
-- Junjo Luau client. Mirrors the TypeScript SDK's `JunjoConfig` shape and
-- wraps Roblox's HttpService for outbound REST calls. Provides the
-- `Junjo.new` factory, per-namespace methods (groups / members / roles /
-- invitations / audit / webhooks / bans / friends), the top-level `:can`,
-- `:check`, and `:keyInfo` helpers, the `Junjo.pageAll` pagination
-- utility, and `Junjo.RobloxUserIdAdapter`.
--
-- File layout under `packages/sdk-roblox/src/`:
--   - init.lua             - this file (composes the namespaces)
--   - JunjoError.lua       - the error class raised on non-2xx responses
--   - Null.lua             - the JSON-null sentinel
--   - Http.lua             - the internal HTTP wrapper exposed as junjo.http
--   - TryGet.lua           - shared "404 -> nil" lookup helper
--   - PageAll.lua          - cursor-pagination iterator (Junjo.pageAll)
--   - Types.lua            - shared response-shape type exports
--   - groups.lua           - groups namespace (groups + membership lifecycle)
--   - members.lua          - members namespace (lookups + roles + overrides)
--   - roles.lua            - roles namespace (CRUD + permission grants)
--   - invitations.lua      - invitations namespace (list / get / revoke)
--   - audit.lua            - audit namespace (list)
--   - webhooks.lua         - webhooks.endpoints sub-namespace (CRUD)
--   - bans.lua             - game-level bans namespace (add / remove /
--                            get / list / history)
--   - friends.lua          - friends namespace (requests / blocks /
--                            tags / visibility sub-namespaces)
--   - adapters/
--     - RobloxUserId.lua   - the RobloxUserIdAdapter factory

local HttpService = game:GetService("HttpService")

local JunjoError = require(script.JunjoError)
local Null = require(script.Null)
local Http = require(script.Http)
local PageAll = require(script.PageAll)
local Types = require(script.Types)
local Groups = require(script.groups)
local Members = require(script.members)
local Roles = require(script.roles)
local Invitations = require(script.invitations)
local Audit = require(script.audit)
local Webhooks = require(script.webhooks)
local Bans = require(script.bans)
local Friends = require(script.friends)
local RobloxUserIdAdapter = require(script.adapters.RobloxUserId)

local DEFAULT_BASE_URL = "https://api.junjo.io"

local Junjo = {}
Junjo.__index = Junjo

Junjo.Null = Null
Junjo.JunjoError = JunjoError
Junjo.DEFAULT_BASE_URL = DEFAULT_BASE_URL
Junjo.RobloxUserIdAdapter = RobloxUserIdAdapter

-- Cursor-pagination iterator for arbitrary list endpoints; the
-- namespace `listAll` / `banHistoryAll` / `historyAll` methods are
-- wired through it. See PageAll.lua for the iteration contract.
Junjo.pageAll = PageAll

-- Response-shape types, re-exported so consumers can annotate their own
-- code via `Junjo.Group` etc. without requiring src/Types.lua directly.
export type Group = Types.Group
export type Member = Types.Member
export type BanHistoryEntry = Types.BanHistoryEntry
export type Page<T> = Types.Page<T>
export type KeyInfo = Types.KeyInfo
export type GameBan = Types.GameBan
export type FriendRequest = Types.FriendRequest
export type FriendRequestList = Types.FriendRequestList
export type Friendship = Types.Friendship
export type FriendRequestSendResult = Types.FriendRequestSendResult
export type Block = Types.Block
export type FriendTag = Types.FriendTag
export type FriendTagAssignment = Types.FriendTagAssignment
export type UserVisibilitySettings = Types.UserVisibilitySettings
export type FriendSuggestion = Types.FriendSuggestion
export type FriendshipRelationship = Types.FriendshipRelationship

-- The SDK version baked into this source tree. Releases MUST keep this
-- in sync with packages/sdk-roblox/package.json's "version" field and
-- the `roblox-vX.Y.Z` release tag; the roblox-release.yml workflow
-- fails the build on a mismatch.
Junjo.VERSION = "0.1.0"

export type JunjoConfig = {
	-- A `jk_<prefix>.<secret>` string OR a Secret userdata returned by
	-- HttpService:GetSecret. Required unless apiKeySecret resolves.
	apiKey: any?,
	-- Roblox secret-store name; resolved via HttpService:GetSecret with
	-- apiKey as the fallback when the lookup fails.
	apiKeySecret: string?,
	baseUrl: string?,
	inviteBaseUrl: string?,
	-- Injection point for tests; defaults to game:GetService("HttpService").
	httpService: any?,
	-- Opt-in transport retries; see the policy header in Http.lua.
	-- maxAttempts is the total attempt cap including the first request
	-- (default 1 = no retry; > 1 opts in). backoffSeconds is the base
	-- for exponential backoff with jitter (default 1). wait is a test
	-- seam for the sleep between attempts; defaults to task.wait.
	retries: {
		maxAttempts: number?,
		backoffSeconds: number?,
		wait: ((seconds: number) -> ())?,
	}?,
}

local function trimTrailingSlashes(s: string): string
	return (string.gsub(s, "/+$", ""))
end

-- Validates config.retries at construction time so a bad retry policy
-- surfaces as invalid_config before any request, not as a confusing
-- runtime failure mid-retry. See Http.lua for the policy itself.
local function validateRetries(retries: any)
	if retries == nil then
		return
	end
	if type(retries) ~= "table" then
		JunjoError.raise("config.retries must be a table", "invalid_config", nil)
	end
	local maxAttempts = retries.maxAttempts
	if maxAttempts ~= nil then
		if type(maxAttempts) ~= "number" or maxAttempts < 1 or maxAttempts % 1 ~= 0 then
			JunjoError.raise(
				"config.retries.maxAttempts must be an integer >= 1",
				"invalid_config",
				nil
			)
		end
	end
	local backoffSeconds = retries.backoffSeconds
	if backoffSeconds ~= nil then
		if type(backoffSeconds) ~= "number" or backoffSeconds <= 0 then
			JunjoError.raise(
				"config.retries.backoffSeconds must be a positive number",
				"invalid_config",
				nil
			)
		end
	end
	if retries.wait ~= nil and type(retries.wait) ~= "function" then
		JunjoError.raise("config.retries.wait must be a function", "invalid_config", nil)
	end
end

-- Per-game API keys are issued by the server in the shape
-- `jk_<prefix>.<secret>`. The cross-game admin token (`jadm_<random>`)
-- is a separate, narrower credential that ONLY gates /v1/admin/*;
-- sending it as the SDK apiKey surfaces server-side as the cryptic
-- "malformed API key". Catch the known confusion at construction time
-- so the developer gets a useful message before any network round-trip.
-- Mirrors the TypeScript SDK's validateApiKeyShape.
local API_KEY_SHAPE = "^jk_[%w_%-]+%.[%w_%-]+$"

local warnedNonStandardKeyShape = false

local function validateApiKeyShape(apiKey: any)
	-- A Secret userdata (from HttpService:GetSecret) cannot be inspected
	-- from Lua; shape validation only applies to plain strings.
	if type(apiKey) ~= "string" then
		return
	end
	if apiKey == "" then
		JunjoError.raise("config.apiKey must be a non-empty string", "invalid_config", nil)
	end
	if string.sub(apiKey, 1, 5) == "jadm_" then
		JunjoError.raise(
			"apiKey looks like a cross-game admin token (jadm_*); the SDK needs a per-game "
				.. "API key (jk_<prefix>.<secret>). Mint one via POST /v1/admin/games/:gameId/api-keys.",
			"invalid_config",
			nil
		)
	end
	-- Non-conforming strings might be valid in tests / forward-compat
	-- contexts, so warn once instead of raising; the server is still the
	-- source of truth and rejects genuinely-bad keys with 401.
	if not string.match(apiKey, API_KEY_SHAPE) and not warnedNonStandardKeyShape then
		warnedNonStandardKeyShape = true
		warn(
			"[junjo-sdk] apiKey does not match the expected jk_<prefix>.<secret> shape; "
				.. "the server may reject it as malformed. Pass a per-game key minted via "
				.. "/v1/admin/games/:gameId/api-keys."
		)
	end
end

local warnedSecretFallback = false

local function resolveApiKey(config: JunjoConfig, httpService: any): any
	-- If a secret name is configured, try GetSecret first. On failure
	-- (HttpService:GetSecret unavailable, secret not registered, etc.)
	-- fall back to config.apiKey when present; otherwise raise.
	if type(config.apiKeySecret) == "string" and config.apiKeySecret ~= "" then
		local ok, secret = pcall(function()
			return httpService:GetSecret(config.apiKeySecret)
		end)
		if ok and secret ~= nil then
			validateApiKeyShape(secret)
			return secret
		end
		if config.apiKey ~= nil and not warnedSecretFallback then
			-- Falling back silently would hide a misconfigured secret
			-- store in production. Warn once, naming the SECRET (never
			-- the key value). The fallback should be a separate
			-- low-privilege dev-game key, never a production key.
			warnedSecretFallback = true
			warn(
				"[junjo-sdk] HttpService:GetSecret('"
					.. config.apiKeySecret
					.. "') failed; falling back to the literal config.apiKey. Register the "
					.. "secret for production use, and make sure the fallback is a separate "
					.. "low-privilege dev-game key, never a production key."
			)
		end
		if config.apiKey == nil then
			JunjoError.raise(
				"HttpService:GetSecret('"
					.. config.apiKeySecret
					.. "') failed and no apiKey fallback was provided",
				"invalid_config",
				nil
			)
		end
	end
	if config.apiKey == nil then
		JunjoError.raise("config.apiKey or config.apiKeySecret is required", "invalid_config", nil)
	end
	validateApiKeyShape(config.apiKey)
	return config.apiKey
end

function Junjo.new(config: JunjoConfig)
	if config == nil then
		JunjoError.raise("Junjo.new(config) requires a config table", "invalid_config", nil)
	end
	if type(config) ~= "table" then
		JunjoError.raise("Junjo.new(config) requires a table argument", "invalid_config", nil)
	end

	local httpService = config.httpService or HttpService

	local baseUrl = config.baseUrl or DEFAULT_BASE_URL
	if type(baseUrl) ~= "string" or baseUrl == "" then
		JunjoError.raise("config.baseUrl must be a non-empty string", "invalid_config", nil)
	end
	local trimmedBaseUrl = trimTrailingSlashes(baseUrl)

	local inviteBaseUrl = config.inviteBaseUrl or trimmedBaseUrl
	if type(inviteBaseUrl) ~= "string" or inviteBaseUrl == "" then
		JunjoError.raise("config.inviteBaseUrl must be a non-empty string", "invalid_config", nil)
	end
	local trimmedInviteBaseUrl = trimTrailingSlashes(inviteBaseUrl)

	local apiKey = resolveApiKey(config, httpService)

	validateRetries(config.retries)

	local http = Http.new({
		apiKey = apiKey,
		baseUrl = trimmedBaseUrl,
		httpService = httpService,
		retries = config.retries,
	})

	local self = setmetatable({}, Junjo)
	self.config = {
		baseUrl = trimmedBaseUrl,
		inviteBaseUrl = trimmedInviteBaseUrl,
	}
	self.http = http
	self.groups = Groups.new(http, trimmedInviteBaseUrl)
	self.members = Members.new(http)
	self.roles = Roles.new(http)
	self.invitations = Invitations.new(http)
	self.audit = Audit.new(http)
	self.webhooks = Webhooks.new(http)
	self.bans = Bans.new(http)
	self.friends = Friends.new(http)
	return self
end

-- ============================================================
-- Top-level permission checks
-- ============================================================
--
-- Mirror the TypeScript SDK's top-level `Junjo.can` and `Junjo.check`.
-- `:check` returns the full envelope `{ allowed, source, viaRoleId? }`
-- so admin tooling can render "you don't have permission because role
-- X is missing key Y" UX. `:can` is a boolean wrapper on top.

function Junjo:check(userId: string, groupId: string, permission: string)
	local path = "/v1/permissions/check"
		.. "?userId=" .. self.http:encode(userId)
		.. "&groupId=" .. self.http:encode(groupId)
		.. "&permission=" .. self.http:encode(permission)
	return self.http:get(path)
end

function Junjo:can(userId: string, groupId: string, permission: string): boolean
	local result = self:check(userId, groupId, permission)
	return result.allowed == true
end

-- ============================================================
-- Top-level key info
-- ============================================================

-- Asks the server which game the configured API key belongs to
-- (GET /v1/whoami). Useful as a connectivity and credential check
-- during setup and in health probes. Named `keyInfo` to match the
-- TypeScript SDK, where "whoami" is reserved for token verification.
function Junjo:keyInfo(): Types.KeyInfo
	return self.http:get("/v1/whoami")
end

return Junjo
