-- URL building: user-supplied ids must be percent-encoded in path
-- segments and query values (mirrors the TS SDK's encodeURIComponent
-- usage). The fake's UrlEncode mirrors Roblox HttpService:UrlEncode
-- (everything but ASCII alphanumerics, "-" and "_" is encoded).

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

case("path segments built from ids are percent-encoded", function()
	local c = t.newClient()
	c.junjo.groups:restore("grp/../x y")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp%2F%2E%2E%2Fx%20y/restore",
		"encoded group id"
	)
end)

case("nested member / role path segments are each encoded", function()
	local c = t.newClient()
	c.junjo.members:assignRole("grp 1", "user?x", "role#9")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp%201/members/user%3Fx/roles/role%239",
		"encoded member role path"
	)
end)

case("query values are percent-encoded", function()
	local c = t.newClient()
	c.junjo.members:list("g", { limit = 5, cursor = "a&b=c" })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/g/members?limit=5&cursor=a%26b%3Dc",
		"encoded cursor"
	)
end)

case("permission check query params are percent-encoded", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"allowed":true,"source":"role"}' }
		end,
	})
	c.junjo:check("user 1", "grp&x", "perm=weird")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/permissions/check?userId=user%201&groupId=grp%26x&permission=perm%3Dweird",
		"encoded check query"
	)
end)

case("numeric ids are stringified before encoding", function()
	local c = t.newClient()
	c.junjo.groups:get(12345)
	t.assertEqual(c.fake.requests[1].Url, "https://api.test/v1/groups/12345", "numeric id")
end)

return { name = "URL building", cases = cases }
