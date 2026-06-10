--!nonstrict
-- Nonstrict, not strict: cross-module `require(script.Parent.X)` types
-- and the metatable-OOP idiom below need the Roblox definition files to
-- pass strict analysis, which CI cannot run yet. Public signatures
-- carry annotations regardless.
--
-- Roles namespace. Mirrors the TypeScript SDK's `junjo.roles` surface
-- (role CRUD plus permission grant / revoke).

local JunjoError = require(script.Parent.JunjoError)
local tryGet = require(script.Parent.TryGet)

local Roles = {}
Roles.__index = Roles

function Roles.new(http)
	local self = setmetatable({}, Roles)
	self._http = http
	return self
end

-- Builds the create-role request body. Drops `permissions`: the
-- TS SDK's CreateRoleInput type still carries the field for
-- forward-compatibility, but the create route only reads name /
-- priority / color / isDefault. The grant route is the way to
-- populate role permissions.
local function buildCreateBody(input)
	local body = { name = input.name, priority = input.priority }
	if input.color ~= nil then body.color = input.color end
	if input.isDefault ~= nil then body.isDefault = input.isDefault end
	return body
end

function Roles:create(groupId: string, input: { name: string, priority: number, color: string?, isDefault: boolean? })
	if input == nil then
		JunjoError.raise("roles:create(groupId, input) requires an input table", "invalid_config", nil)
	end
	return self._http:post(
		"/v1/groups/" .. self._http:encode(groupId) .. "/roles",
		buildCreateBody(input)
	)
end

function Roles:get(id: string)
	return tryGet(self._http, "/v1/roles/" .. self._http:encode(id))
end

function Roles:update(id: string, input: { [string]: any })
	if input == nil then
		JunjoError.raise("roles:update(id, input) requires an input table", "invalid_config", nil)
	end
	return self._http:patch("/v1/roles/" .. self._http:encode(id), input)
end

function Roles:delete(id: string)
	self._http:delete("/v1/roles/" .. self._http:encode(id))
end

function Roles:list(groupId: string)
	return self._http:get("/v1/groups/" .. self._http:encode(groupId) .. "/roles")
end

function Roles:grantPermission(roleId: string, permission: string)
	return self._http:post(
		"/v1/roles/" .. self._http:encode(roleId) .. "/permissions",
		{ permission = permission }
	)
end

function Roles:revokePermission(roleId: string, permission: string)
	return self._http:delete(
		"/v1/roles/" .. self._http:encode(roleId)
			.. "/permissions/" .. self._http:encode(permission)
	)
end

return Roles
