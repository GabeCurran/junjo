-- Game-level bans surface: add / remove body + method shapes, the
-- get 404 -> nil contract, the list / history page queries, and the
-- listAll / historyAll iterators. Mirrors the server routes
-- POST /v1/bans, DELETE /v1/bans/:userId, GET /v1/bans,
-- GET /v1/bans/:userId, and GET /v1/bans/:userId/history.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

local banBody = '{"id":"ban_1","gameId":"game_1","userId":"user_1","bannedAt":"2026-01-01T00:00:00.000Z","expiresAt":null,"reason":null,"bannedBy":null}'

case("add posts userId / reason / expiresAt / actorUserId to /v1/bans", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 201, StatusMessage = "Created", Body = banBody }
		end,
	})
	local ban = c.junjo.bans:add("user/1", {
		reason = "exploiting",
		expiresAt = "2027-01-01T00:00:00.000Z",
		actorUserId = "mod_9",
	})
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(c.fake.requests[1].Url, "https://api.test/v1/bans", "bans URL")
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.userId, "user/1", "userId in body")
	t.assertEqual(body.reason, "exploiting", "reason in body")
	t.assertEqual(body.expiresAt, "2027-01-01T00:00:00.000Z", "expiresAt in body")
	t.assertEqual(body.actorUserId, "mod_9", "actorUserId in body")
	t.assertEqual(ban.id, "ban_1", "ban decoded")
end)

case("add without opts posts only the userId", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 201, StatusMessage = "Created", Body = banBody }
		end,
	})
	c.junjo.bans:add("user_1")
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.userId, "user_1", "userId in body")
	t.assertEqual(body.reason, nil, "reason absent")
	t.assertEqual(body.expiresAt, nil, "expiresAt absent")
	t.assertEqual(body.actorUserId, nil, "actorUserId absent")
end)

case("remove DELETEs the encoded ban path with actorUserId in the body", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 204, StatusMessage = "No Content", Body = "" }
		end,
	})
	c.junjo.bans:remove("user?x", { actorUserId = "mod_9" })
	t.assertEqual(c.fake.requests[1].Method, "DELETE", "method")
	t.assertEqual(c.fake.requests[1].Url, "https://api.test/v1/bans/user%3Fx", "encoded remove URL")
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.actorUserId, "mod_9", "actorUserId in body")
end)

case("remove without opts sends a body-less DELETE", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 204, StatusMessage = "No Content", Body = "" }
		end,
	})
	c.junjo.bans:remove("user_1")
	t.assertEqual(c.fake.requests[1].Method, "DELETE", "method")
	t.assertEqual(c.fake.requests[1].Url, "https://api.test/v1/bans/user_1", "remove URL")
	t.assertEqual(c.fake.requests[1].Body, nil, "no body on the wire")
end)

case("get GETs the encoded ban path and returns the ban", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = banBody }
		end,
	})
	local ban = c.junjo.bans:get("user 1")
	t.assertEqual(c.fake.requests[1].Method, "GET", "method")
	t.assertEqual(c.fake.requests[1].Url, "https://api.test/v1/bans/user%201", "encoded get URL")
	t.assertEqual(ban.id, "ban_1", "ban decoded")
end)

case("get maps not_found to nil", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 404,
				StatusMessage = "Not Found",
				Body = '{"code":"not_found","message":"ban not found","status":404}',
			}
		end,
	})
	t.assertEqual(c.junjo.bans:get("user_1"), nil, "404 -> nil")
end)

case("list builds the limit / cursor / includeExpired query", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 200,
				StatusMessage = "OK",
				Body = '{"items":[{"id":"ban_1"}],"nextCursor":"c2"}',
			}
		end,
	})
	local page = c.junjo.bans:list({ limit = 10, cursor = "a&b", includeExpired = true })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/bans?limit=10&cursor=a%26b&includeExpired=true",
		"encoded list URL"
	)
	t.assertEqual(page.items[1].id, "ban_1", "page item")
	t.assertEqual(page.nextCursor, "c2", "page cursor")
end)

case("list omits includeExpired unless it is true", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"items":[],"nextCursor":null}' }
		end,
	})
	c.junjo.bans:list({ limit = 5, includeExpired = false })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/bans?limit=5",
		"includeExpired=false omitted"
	)
end)

case("list without opts sends no query string", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"items":[],"nextCursor":null}' }
		end,
	})
	c.junjo.bans:list()
	t.assertEqual(c.fake.requests[1].Url, "https://api.test/v1/bans", "bare list URL")
end)

case("history builds the limit / cursor / scope / groupId query on the encoded path", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 200,
				StatusMessage = "OK",
				Body = '{"items":[{"id":"bh_1","kind":"set"}],"nextCursor":null}',
			}
		end,
	})
	local page = c.junjo.bans:history("user 1", {
		limit = 10,
		cursor = "a&b",
		scope = "group",
		groupId = "grp 1",
	})
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/bans/user%201/history?limit=10&cursor=a%26b&scope=group&groupId=grp%201",
		"encoded history URL"
	)
	t.assertEqual(page.items[1].id, "bh_1", "page item")
end)

case("history without opts sends no query string", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"items":[],"nextCursor":null}' }
		end,
	})
	c.junjo.bans:history("user_1")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/bans/user_1/history",
		"bare history URL"
	)
end)

case("listAll walks pages by feeding nextCursor back as cursor", function()
	local c = t.newClient({
		handler = function(_, callIndex)
			if callIndex == 1 then
				return {
					StatusCode = 200,
					StatusMessage = "OK",
					Body = '{"items":[{"id":"ban_1"},{"id":"ban_2"}],"nextCursor":"c2"}',
				}
			end
			return {
				StatusCode = 200,
				StatusMessage = "OK",
				Body = '{"items":[{"id":"ban_3"}],"nextCursor":null}',
			}
		end,
	})
	local ids = {}
	for ban in c.junjo.bans:listAll({ limit = 2, includeExpired = true }) do
		table.insert(ids, ban.id)
	end
	t.assertEqual(#ids, 3, "all items yielded")
	t.assertEqual(table.concat(ids, ","), "ban_1,ban_2,ban_3", "order preserved")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/bans?limit=2&includeExpired=true",
		"first page URL"
	)
	t.assertEqual(
		c.fake.requests[2].Url,
		"https://api.test/v1/bans?limit=2&cursor=c2&includeExpired=true",
		"second page carries the cursor"
	)
end)

case("historyAll walks the per-user history pages", function()
	local c = t.newClient({
		handler = function(_, callIndex)
			if callIndex == 1 then
				return {
					StatusCode = 200,
					StatusMessage = "OK",
					Body = '{"items":[{"id":"bh_1"}],"nextCursor":"c2"}',
				}
			end
			return {
				StatusCode = 200,
				StatusMessage = "OK",
				Body = '{"items":[{"id":"bh_2"}],"nextCursor":null}',
			}
		end,
	})
	local ids = {}
	for entry in c.junjo.bans:historyAll("user_1", { scope = "game" }) do
		table.insert(ids, entry.id)
	end
	t.assertEqual(table.concat(ids, ","), "bh_1,bh_2", "all entries yielded")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/bans/user_1/history?scope=game",
		"first page URL"
	)
	t.assertEqual(
		c.fake.requests[2].Url,
		"https://api.test/v1/bans/user_1/history?cursor=c2&scope=game",
		"second page carries the cursor"
	)
end)

return { name = "Game-level bans", cases = cases }
