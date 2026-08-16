-- The permission surface added for hierarchical authorization: the
-- opt-in `inherit` parent walk on `:check` / `:can`, the batched
-- `:checkBatch` route, the `kind` filter on groups:list, and the
-- server-to-server `members:add`.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

local function jsonOk(body)
	return { StatusCode = 200, StatusMessage = "OK", Body = body }
end

case("check omits inherit by default", function()
	local c = t.newClient({
		handler = function()
			return jsonOk('{"allowed":false,"source":"default"}')
		end,
	})
	c.junjo:check("user_1", "grp_1", "guild.kick")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/permissions/check?userId=user_1&groupId=grp_1&permission=guild%2Ekick",
		"no inherit param"
	)
end)

case("check sends inherit=true and surfaces viaGroupId", function()
	local c = t.newClient({
		handler = function()
			return jsonOk('{"allowed":true,"source":"role","viaRoleId":"role_1","viaGroupId":"grp_parent"}')
		end,
	})
	local result = c.junjo:check("user_1", "grp_child", "guild.kick", true)
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/permissions/check?userId=user_1&groupId=grp_child&permission=guild%2Ekick&inherit=true",
		"inherit param appended"
	)
	t.assertEqual(result.allowed, true, "allowed")
	t.assertEqual(result.viaGroupId, "grp_parent", "viaGroupId decoded")
end)

case("check with inherit=false omits the param", function()
	local c = t.newClient({
		handler = function()
			return jsonOk('{"allowed":false,"source":"none"}')
		end,
	})
	c.junjo:check("user_1", "grp_1", "guild.kick", false)
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/permissions/check?userId=user_1&groupId=grp_1&permission=guild%2Ekick",
		"no inherit param"
	)
end)

case("can forwards inherit and returns the boolean", function()
	local c = t.newClient({
		handler = function()
			return jsonOk('{"allowed":true,"source":"role","viaGroupId":"grp_parent"}')
		end,
	})
	local allowed = c.junjo:can("user_1", "grp_child", "guild.kick", true)
	t.assertEqual(allowed, true, "allowed")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/permissions/check?userId=user_1&groupId=grp_child&permission=guild%2Ekick&inherit=true",
		"inherit param appended"
	)
end)

case("checkBatch POSTs one request and returns results in order", function()
	local c = t.newClient({
		handler = function()
			return jsonOk('{"results":[{"allowed":true,"source":"role"},{"allowed":false,"source":"none"}]}')
		end,
	})
	local results = c.junjo:checkBatch({
		{ userId = "user_1", groupId = "grp_1", permission = "kick" },
		{ userId = "user_2", groupId = "grp_2", permission = "invite" },
	})
	t.assertEqual(#c.fake.requests, 1, "one request")
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/permissions/check-batch",
		"batch URL"
	)
	t.assertEqual(#results, 2, "two results")
	t.assertEqual(results[1].allowed, true, "first result")
	t.assertEqual(results[2].allowed, false, "second result")
end)

case("checkBatch makes no request for an empty list", function()
	local c = t.newClient({
		handler = function()
			return jsonOk('{"results":[]}')
		end,
	})
	local results = c.junjo:checkBatch({})
	t.assertEqual(#c.fake.requests, 0, "no request")
	t.assertEqual(#results, 0, "no results")
end)

case("checkBatch forwards inherit in the body", function()
	local c = t.newClient({
		handler = function()
			return jsonOk('{"results":[{"allowed":true,"source":"role"}]}')
		end,
	})
	c.junjo:checkBatch({ { userId = "user_1", groupId = "grp_1", permission = "kick" } }, true)
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.inherit, true, "inherit in body")
	t.assertEqual(#body.checks, 1, "one check")
end)

case("checkBatch splits inputs past the 100 entry cap", function()
	local sizes = {}
	-- Forward-declared so the handler closure captures this local
	-- rather than a global; a local's scope starts after its statement.
	local c
	c = t.newClient({
		handler = function(request)
			local body = c.fake:JSONDecode(request.Body)
			table.insert(sizes, #body.checks)
			local results = {}
			for _ = 1, #body.checks do
				table.insert(results, '{"allowed":true,"source":"role"}')
			end
			return jsonOk('{"results":[' .. table.concat(results, ",") .. "]}")
		end,
	})

	local checks = {}
	for i = 1, 250 do
		table.insert(checks, { userId = "user_" .. i, groupId = "grp_1", permission = "kick" })
	end
	local results = c.junjo:checkBatch(checks)

	t.assertEqual(#c.fake.requests, 3, "three requests")
	t.assertEqual(sizes[1], 100, "first slice")
	t.assertEqual(sizes[2], 100, "second slice")
	t.assertEqual(sizes[3], 50, "third slice")
	t.assertEqual(#results, 250, "all results concatenated")
end)

case("groups:list appends an encoded kind filter", function()
	local c = t.newClient({
		handler = function()
			return jsonOk('{"items":[],"nextCursor":null}')
		end,
	})
	c.junjo.groups:list({ kind = "instance" })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups?kind=instance",
		"kind param"
	)
end)

case("groups:list without a kind sends no kind param", function()
	local c = t.newClient({
		handler = function()
			return jsonOk('{"items":[],"nextCursor":null}')
		end,
	})
	c.junjo.groups:list({ limit = 10 })
	t.assertEqual(c.fake.requests[1].Url, "https://api.test/v1/groups?limit=10", "no kind param")
end)

case("members:add POSTs the group members collection", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 201,
				StatusMessage = "Created",
				Body = '{"id":"mem_1","userId":"user_1","status":"active","roles":[]}',
			}
		end,
	})
	local member = c.junjo.members:add("grp_1", "user_1")
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp_1/members",
		"members URL"
	)
	t.assertEqual(c.fake:JSONDecode(c.fake.requests[1].Body).userId, "user_1", "userId in body")
	t.assertEqual(member.status, "active", "member decoded")
end)

case("members:add sends roleId and actorUserId only when given", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 201,
				StatusMessage = "Created",
				Body = '{"id":"mem_1","userId":"user_1","status":"active","roles":["role_1"]}',
			}
		end,
	})
	c.junjo.members:add("grp_1", "user_1", { roleId = "role_1", actorUserId = "user_admin" })
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.roleId, "role_1", "roleId in body")
	t.assertEqual(body.actorUserId, "user_admin", "actorUserId in body")
end)

case("members:add omits optional fields when not given", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 201,
				StatusMessage = "Created",
				Body = '{"id":"mem_1","userId":"user_1","status":"active","roles":[]}',
			}
		end,
	})
	c.junjo.members:add("grp_1", "user_1")
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.roleId, nil, "no roleId")
	t.assertEqual(body.actorUserId, nil, "no actorUserId")
end)

case("members:add percent-encodes the group id", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 201,
				StatusMessage = "Created",
				Body = '{"id":"mem_1","userId":"user_1","status":"active","roles":[]}',
			}
		end,
	})
	c.junjo.members:add("has/slash", "user_1")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/has%2Fslash/members",
		"encoded group id"
	)
end)

return { name = "Permissions inherit + batch, kind filter, members:add", cases = cases }
