-- Junjo Luau client. Mirrors the TypeScript SDK's `JunjoConfig` shape and
-- wraps Roblox's HttpService for outbound REST calls. Phase 8.1 shipped
-- the HTTP wrapper and `Junjo.new` factory; Phase 8.2 layers per-namespace
-- methods on top (groups / members / roles / invitations / audit /
-- webhooks) plus the top-level `:can` and `:check` permission checks.
-- Phase 8.3 will add the `RobloxUserIdAdapter`.
--
-- File layout under `packages/sdk-roblox/src/`:
--   - init.lua        - this file (composes the namespaces)
--   - JunjoError.lua  - the error class raised on non-2xx responses
--   - Null.lua        - the JSON-null sentinel
--   - Http.lua        - the internal HTTP wrapper exposed as junjo.http
--   - groups.lua      - groups namespace (groups + membership lifecycle)
--   - members.lua     - members namespace (lookups + roles + overrides)
--   - roles.lua       - roles namespace (CRUD + permission grants)
--   - invitations.lua - invitations namespace (list / get / revoke)
--   - audit.lua       - audit namespace (list)
--   - webhooks.lua    - webhooks.endpoints sub-namespace (CRUD)

local HttpService = game:GetService("HttpService")

local JunjoError = require(script.JunjoError)
local Null = require(script.Null)
local Http = require(script.Http)
local Groups = require(script.groups)
local Members = require(script.members)
local Roles = require(script.roles)
local Invitations = require(script.invitations)
local Audit = require(script.audit)
local Webhooks = require(script.webhooks)

local DEFAULT_BASE_URL = "https://api.junjo.io"

local Junjo = {}
Junjo.__index = Junjo

Junjo.Null = Null
Junjo.JunjoError = JunjoError
Junjo.DEFAULT_BASE_URL = DEFAULT_BASE_URL

local function trimTrailingSlashes(s)
	return (string.gsub(s, "/+$", ""))
end

local function resolveApiKey(config, httpService)
	-- If a secret name is configured, try GetSecret first. On failure
	-- (HttpService:GetSecret unavailable, secret not registered, etc.)
	-- fall back to config.apiKey when present; otherwise raise.
	if type(config.apiKeySecret) == "string" and config.apiKeySecret ~= "" then
		local ok, secret = pcall(function()
			return httpService:GetSecret(config.apiKeySecret)
		end)
		if ok and secret ~= nil then
			return secret
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
	return config.apiKey
end

function Junjo.new(config)
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

	local http = Http.new({
		apiKey = apiKey,
		baseUrl = trimmedBaseUrl,
		httpService = httpService,
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

function Junjo:check(userId, groupId, permission)
	local path = "/v1/permissions/check"
		.. "?userId=" .. self.http:encode(userId)
		.. "&groupId=" .. self.http:encode(groupId)
		.. "&permission=" .. self.http:encode(permission)
	return self.http:get(path)
end

function Junjo:can(userId, groupId, permission)
	local result = self:check(userId, groupId, permission)
	return result.allowed == true
end

return Junjo
