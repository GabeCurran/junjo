-- Query-parameter shapes added alongside the moderation surface: the
-- `viewer` visibility scope on groups get / list, the comma-joined
-- `status` filter on members list, and the top-level keyInfo call
-- (GET /v1/whoami).

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

local groupBody = '{"id":"grp_1","name":"Wolves"}'

case("groups:get appends an encoded viewer query param", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = groupBody }
		end,
	})
	local group = c.junjo.groups:get("grp_1", { viewer = "user 1" })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp_1?viewer=user%201",
		"encoded viewer"
	)
	t.assertEqual(group.id, "grp_1", "group decoded")
end)

case("groups:get without a viewer sends no query string", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = groupBody }
		end,
	})
	c.junjo.groups:get("grp_1")
	t.assertEqual(c.fake.requests[1].Url, "https://api.test/v1/groups/grp_1", "bare URL")
end)

case("groups:get with a viewer still maps not_found to nil", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 404,
				StatusMessage = "Not Found",
				Body = '{"code":"not_found","message":"no such group","status":404}',
			}
		end,
	})
	t.assertEqual(c.junjo.groups:get("secret", { viewer = "outsider" }), nil, "404 -> nil")
end)

case("groups:list appends viewer after the paging params", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"items":[],"nextCursor":null}' }
		end,
	})
	c.junjo.groups:list({ limit = 5, viewer = "user&1" })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups?limit=5&viewer=user%261",
		"encoded list viewer"
	)
end)

case("members:list joins opts.status with commas", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"items":[],"nextCursor":null}' }
		end,
	})
	c.junjo.members:list("grp_1", { status = { "active", "banned" } })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp_1/members?status=active%2Cbanned",
		"comma-joined status (encoded)"
	)
end)

case("members:list omits an empty status array", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"items":[],"nextCursor":null}' }
		end,
	})
	c.junjo.members:list("grp_1", { status = {} })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp_1/members",
		"no status param"
	)
end)

case("keyInfo GETs /v1/whoami and returns the gameId envelope", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"gameId":"game_1"}' }
		end,
	})
	local info = c.junjo:keyInfo()
	t.assertEqual(c.fake.requests[1].Method, "GET", "method")
	t.assertEqual(c.fake.requests[1].Url, "https://api.test/v1/whoami", "whoami URL")
	t.assertEqual(info.gameId, "game_1", "gameId decoded")
end)

return { name = "Query params + keyInfo", cases = cases }
