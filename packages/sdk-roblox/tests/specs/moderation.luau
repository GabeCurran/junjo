-- Membership moderation surface: open join (with and without a
-- passcode), per-group ban / unban body + method shapes, and the
-- banHistory page query. Mirrors the server routes
-- POST /v1/groups/:id/join, POST + DELETE
-- /v1/groups/:id/members/:userId/ban, and GET /v1/groups/:id/bans/history.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

local memberBody = '{"id":"mem_1","groupId":"grp_1","userId":"user_1","status":"active"}'

case("join posts userId to /join and omits passcode when not given", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = memberBody }
		end,
	})
	local member = c.junjo.groups:join("grp 1", "user/1")
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(c.fake.requests[1].Url, "https://api.test/v1/groups/grp%201/join", "encoded join URL")
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.userId, "user/1", "userId in body")
	t.assertEqual(body.passcode, nil, "passcode absent")
	t.assertEqual(member.id, "mem_1", "member decoded")
end)

case("join forwards opts.passcode in the body", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = memberBody }
		end,
	})
	c.junjo.groups:join("grp_1", "user_1", { passcode = "wolfpack" })
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.userId, "user_1", "userId in body")
	t.assertEqual(body.passcode, "wolfpack", "passcode in body")
end)

case("ban posts reason / expiresAt / actorUserId to the ban path", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = memberBody }
		end,
	})
	c.junjo.groups:ban("grp 1", "user?x", {
		reason = "griefing",
		expiresAt = "2027-01-01T00:00:00.000Z",
		actorUserId = "mod_9",
	})
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp%201/members/user%3Fx/ban",
		"encoded ban URL"
	)
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.reason, "griefing", "reason in body")
	t.assertEqual(body.expiresAt, "2027-01-01T00:00:00.000Z", "expiresAt in body")
	t.assertEqual(body.actorUserId, "mod_9", "actorUserId in body")
end)

case("ban without opts still posts to the ban path", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = memberBody }
		end,
	})
	c.junjo.groups:ban("grp_1", "user_1")
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp_1/members/user_1/ban",
		"ban URL"
	)
end)

case("unban DELETEs the ban path with actorUserId in the body", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = memberBody }
		end,
	})
	c.junjo.groups:unban("grp_1", "user_1", { actorUserId = "mod_9" })
	t.assertEqual(c.fake.requests[1].Method, "DELETE", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp_1/members/user_1/ban",
		"unban URL"
	)
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.actorUserId, "mod_9", "actorUserId in body")
end)

case("unban without opts sends a body-less DELETE", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = memberBody }
		end,
	})
	c.junjo.groups:unban("grp_1", "user_1")
	t.assertEqual(c.fake.requests[1].Method, "DELETE", "method")
	t.assertEqual(c.fake.requests[1].Body, nil, "no body on the wire")
end)

case("banHistory builds the limit / cursor query and returns the page", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 200,
				StatusMessage = "OK",
				Body = '{"items":[{"id":"bh_1","kind":"set"}],"nextCursor":"c2"}',
			}
		end,
	})
	local page = c.junjo.groups:banHistory("grp 1", { limit = 10, cursor = "a&b" })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp%201/bans/history?limit=10&cursor=a%26b",
		"encoded banHistory URL"
	)
	t.assertEqual(page.items[1].id, "bh_1", "page item")
	t.assertEqual(page.nextCursor, "c2", "page cursor")
end)

case("banHistory without opts sends no query string", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"items":[],"nextCursor":null}' }
		end,
	})
	c.junjo.groups:banHistory("grp_1")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp_1/bans/history",
		"bare banHistory URL"
	)
end)

return { name = "Membership moderation", cases = cases }
