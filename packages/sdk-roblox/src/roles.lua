-- Roles namespace. Mirrors the TypeScript SDK's `junjo.roles` surface
-- (role CRUD plus permission grant / revoke).

local JunjoError = require(script.Parent.JunjoError)

local Roles = {}
Roles.__index = Roles

function Roles.new(http)
	local self = setmetatable({}, Roles)
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

function Roles:create(groupId, input)
	return self._http:post(
		"/v1/groups/" .. self._http:encode(groupId) .. "/roles",
		buildCreateBody(input)
	)
end

function Roles:get(id)
	return tryGet(self._http, "/v1/roles/" .. self._http:encode(id))
end

function Roles:update(id, input)
	return self._http:patch("/v1/roles/" .. self._http:encode(id), input)
end

function Roles:delete(id)
	self._http:delete("/v1/roles/" .. self._http:encode(id))
end

function Roles:list(groupId)
	return self._http:get("/v1/groups/" .. self._http:encode(groupId) .. "/roles")
end

function Roles:grantPermission(roleId, permission)
	return self._http:post(
		"/v1/roles/" .. self._http:encode(roleId) .. "/permissions",
		{ permission = permission }
	)
end

function Roles:revokePermission(roleId, permission)
	return self._http:delete(
		"/v1/roles/" .. self._http:encode(roleId)
			.. "/permissions/" .. self._http:encode(permission)
	)
end

return Roles
