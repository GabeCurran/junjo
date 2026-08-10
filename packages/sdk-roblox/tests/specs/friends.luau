-- Friends surface: request lifecycle, the friendship list / remove /
-- relationship probe / suggestions, and the blocks / tags / visibility
-- sub-namespaces. Mirrors the server routes in
-- packages/server/src/routes/{friends,friendTags,visibility,
-- suggestions}.ts as registered in app.ts.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

local ok200 = function(body)
	return function()
		return { StatusCode = 200, StatusMessage = "OK", Body = body }
	end
end

local noContent = function()
	return { StatusCode = 204, StatusMessage = "No Content", Body = "" }
end

-- ============================================================
-- friends.requests
-- ============================================================

case("requests:list GETs the encoded friend-requests path", function()
	local c = t.newClient({
		handler = ok200('{"inbound":[{"id":"req_1"}],"outbound":[]}'),
	})
	local result = c.junjo.friends.requests:list("user 1")
	t.assertEqual(c.fake.requests[1].Method, "GET", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%201/friend-requests",
		"encoded list URL"
	)
	t.assertEqual(result.inbound[1].id, "req_1", "inbound decoded")
	t.assertEqual(#result.outbound, 0, "outbound empty")
end)

case("requests:list appends an encoded direction query param", function()
	local c = t.newClient({
		handler = ok200('{"inbound":[],"outbound":[]}'),
	})
	c.junjo.friends.requests:list("user_1", { direction = "in" })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user_1/friend-requests?direction=in",
		"direction query"
	)
end)

case("requests:send posts targetJunjoUserId and passes a pending result through", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 201,
				StatusMessage = "Created",
				Body = '{"status":"pending","request":{"id":"req_1","actorJunjoUserId":"user/1","targetJunjoUserId":"user/2"}}',
			}
		end,
	})
	local result = c.junjo.friends.requests:send("user/1", "user/2")
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%2F1/friend-requests",
		"encoded send URL"
	)
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.targetJunjoUserId, "user/2", "targetJunjoUserId in body")
	t.assertEqual(result.status, "pending", "pending status")
	t.assertEqual(result.request.id, "req_1", "request present")
	t.assertEqual(result.friendship, nil, "friendship absent")
end)

case("requests:send passes an auto-accepted result through", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 201,
				StatusMessage = "Created",
				Body = '{"status":"auto-accepted","friendship":{"id":"rel_1","junjoUserId":"user_2","since":"2026-01-01T00:00:00.000Z"}}',
			}
		end,
	})
	local result = c.junjo.friends.requests:send("user_1", "user_2")
	t.assertEqual(result.status, "auto-accepted", "auto-accepted status")
	t.assertEqual(result.friendship.id, "rel_1", "friendship present")
	t.assertEqual(result.friendship.since, "2026-01-01T00:00:00.000Z", "since stays an ISO string")
	t.assertEqual(result.request, nil, "request absent")
end)

case("requests:accept posts body-less to the encoded accept path", function()
	local c = t.newClient({
		handler = ok200('{"id":"rel_1","junjoUserId":"user_2","since":"2026-01-01T00:00:00.000Z"}'),
	})
	local friendship = c.junjo.friends.requests:accept("req 1")
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/friend-requests/req%201/accept",
		"encoded accept URL"
	)
	t.assertEqual(c.fake.requests[1].Body, nil, "no body on the wire")
	t.assertEqual(friendship.id, "rel_1", "friendship decoded")
end)

case("requests:decline posts body-less to the decline path", function()
	local c = t.newClient({ handler = noContent })
	c.junjo.friends.requests:decline("req_1")
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/friend-requests/req_1/decline",
		"decline URL"
	)
	t.assertEqual(c.fake.requests[1].Body, nil, "no body on the wire")
end)

case("requests:cancel DELETEs the encoded request path", function()
	local c = t.newClient({ handler = noContent })
	c.junjo.friends.requests:cancel("req?x")
	t.assertEqual(c.fake.requests[1].Method, "DELETE", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/friend-requests/req%3Fx",
		"encoded cancel URL"
	)
end)

-- ============================================================
-- friends list / remove / relationship / suggestions
-- ============================================================

case("list builds the limit / cursor / tagId / viewer query and returns the page", function()
	local c = t.newClient({
		handler = ok200('{"items":[{"id":"rel_1"}],"nextCursor":"c2"}'),
	})
	local page = c.junjo.friends:list("user 1", {
		limit = 10,
		cursor = "a&b",
		tagId = "tag 1",
		viewer = "user&2",
	})
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%201/friends?limit=10&cursor=a%26b&tagId=tag%201&viewer=user%262",
		"encoded list URL"
	)
	t.assertEqual(page.items[1].id, "rel_1", "page item")
	t.assertEqual(page.nextCursor, "c2", "page cursor")
end)

case("list without opts sends no query string", function()
	local c = t.newClient({
		handler = ok200('{"items":[],"nextCursor":null}'),
	})
	c.junjo.friends:list("user_1")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user_1/friends",
		"bare list URL"
	)
end)

case("listAll walks pages by feeding nextCursor back as cursor", function()
	local c = t.newClient({
		handler = function(_, callIndex)
			if callIndex == 1 then
				return {
					StatusCode = 200,
					StatusMessage = "OK",
					Body = '{"items":[{"id":"rel_1"},{"id":"rel_2"}],"nextCursor":"c2"}',
				}
			end
			return {
				StatusCode = 200,
				StatusMessage = "OK",
				Body = '{"items":[{"id":"rel_3"}],"nextCursor":null}',
			}
		end,
	})
	local ids = {}
	for friendship in c.junjo.friends:listAll("user_1", { limit = 2, tagId = "tag_1" }) do
		table.insert(ids, friendship.id)
	end
	t.assertEqual(table.concat(ids, ","), "rel_1,rel_2,rel_3", "all items yielded in order")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user_1/friends?limit=2&tagId=tag_1",
		"first page URL"
	)
	t.assertEqual(
		c.fake.requests[2].Url,
		"https://api.test/v1/users/user_1/friends?limit=2&cursor=c2&tagId=tag_1",
		"second page carries the cursor"
	)
end)

case("remove DELETEs the encoded pair path", function()
	local c = t.newClient({ handler = noContent })
	c.junjo.friends:remove("user 1", "user/2")
	t.assertEqual(c.fake.requests[1].Method, "DELETE", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%201/friends/user%2F2",
		"encoded remove URL"
	)
end)

case("getRelationship GETs the encoded relationship path", function()
	local c = t.newClient({
		handler = ok200('{"state":"friends","since":"2026-01-01T00:00:00.000Z"}'),
	})
	local rel = c.junjo.friends:getRelationship("user 1", "user/2")
	t.assertEqual(c.fake.requests[1].Method, "GET", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%201/friends/user%2F2/relationship",
		"encoded relationship URL"
	)
	t.assertEqual(rel.state, "friends", "state decoded")
	t.assertEqual(rel.since, "2026-01-01T00:00:00.000Z", "since stays an ISO string")
end)

case("getRelationship returns state none (not nil) when no relationship exists", function()
	-- The server never 404s this probe: never-seen users and untouched
	-- pairs come back as a 200 with state = "none" and a null since.
	local c = t.newClient({
		handler = ok200('{"state":"none","since":null}'),
	})
	local rel = c.junjo.friends:getRelationship("user_1", "user_2")
	t.assertEqual(rel.state, "none", "none state passthrough")
	t.assertEqual(rel.since, nil, "null since decodes to nil")
end)

case("suggestions GETs the suggestions path with an encoded limit", function()
	local c = t.newClient({
		handler = ok200('{"items":[{"junjoUserId":"user_9","mutualCount":3}]}'),
	})
	local items = c.junjo.friends:suggestions("user 1", { limit = 5 })
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%201/friends/suggestions?limit=5",
		"encoded suggestions URL"
	)
	t.assertEqual(items[1].junjoUserId, "user_9", "items flattened from the envelope")
	t.assertEqual(items[1].mutualCount, 3, "mutualCount decoded")
end)

case("suggestions without opts sends no query string", function()
	local c = t.newClient({
		handler = ok200('{"items":[]}'),
	})
	local items = c.junjo.friends:suggestions("user_1")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user_1/friends/suggestions",
		"bare suggestions URL"
	)
	t.assertEqual(#items, 0, "empty array")
end)

-- ============================================================
-- friends.blocks
-- ============================================================

case("blocks:list GETs the blocks path and flattens the items envelope", function()
	local c = t.newClient({
		handler = ok200('{"items":[{"id":"blk_1","junjoUserId":"user_2"}]}'),
	})
	local blocks = c.junjo.friends.blocks:list("user 1")
	t.assertEqual(c.fake.requests[1].Method, "GET", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%201/blocks",
		"encoded blocks URL"
	)
	t.assertEqual(blocks[1].id, "blk_1", "items flattened")
end)

case("blocks:add posts targetJunjoUserId to the blocks path", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 201,
				StatusMessage = "Created",
				Body = '{"id":"blk_1","junjoUserId":"user/2"}',
			}
		end,
	})
	local block = c.junjo.friends.blocks:add("user_1", "user/2")
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user_1/blocks",
		"blocks URL"
	)
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.targetJunjoUserId, "user/2", "targetJunjoUserId in body")
	t.assertEqual(block.id, "blk_1", "block decoded")
end)

case("blocks:remove DELETEs the encoded pair path", function()
	local c = t.newClient({ handler = noContent })
	c.junjo.friends.blocks:remove("user 1", "user?2")
	t.assertEqual(c.fake.requests[1].Method, "DELETE", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%201/blocks/user%3F2",
		"encoded remove URL"
	)
end)

-- ============================================================
-- friends.tags
-- ============================================================

case("tags:list GETs the friend-tags path and flattens the items envelope", function()
	local c = t.newClient({
		handler = ok200('{"items":[{"id":"tag_1","name":"IRL"}]}'),
	})
	local tags = c.junjo.friends.tags:list("user 1")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%201/friend-tags",
		"encoded tags URL"
	)
	t.assertEqual(tags[1].name, "IRL", "items flattened")
end)

case("tags:create posts name and color to the friend-tags path", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 201,
				StatusMessage = "Created",
				Body = '{"id":"tag_1","name":"IRL","color":"#ff0000"}',
			}
		end,
	})
	local tag = c.junjo.friends.tags:create("user_1", { name = "IRL", color = "#ff0000" })
	t.assertEqual(c.fake.requests[1].Method, "POST", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user_1/friend-tags",
		"tags URL"
	)
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.name, "IRL", "name in body")
	t.assertEqual(body.color, "#ff0000", "color in body")
	t.assertEqual(tag.id, "tag_1", "tag decoded")
end)

case("tags:create omits color when not given", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 201, StatusMessage = "Created", Body = '{"id":"tag_1"}' }
		end,
	})
	c.junjo.friends.tags:create("user_1", { name = "Guild" })
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.name, "Guild", "name in body")
	t.assertEqual(body.color, nil, "color absent")
end)

case("tags:update PATCHes the encoded tag path with the patch body", function()
	local c = t.newClient({
		handler = ok200('{"id":"tag_1","name":"Renamed"}'),
	})
	local tag = c.junjo.friends.tags:update("tag 1", { name = "Renamed" })
	t.assertEqual(c.fake.requests[1].Method, "PATCH", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/friend-tags/tag%201",
		"encoded update URL"
	)
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.name, "Renamed", "name in body")
	t.assertEqual(body.color, nil, "untouched color absent")
	t.assertEqual(tag.name, "Renamed", "tag decoded")
end)

case("tags:update sends Junjo.Null color as a JSON null", function()
	local c = t.newClient({
		handler = ok200('{"id":"tag_1","name":"IRL","color":null}'),
	})
	c.junjo.friends.tags:update("tag_1", { color = c.Junjo.Null })
	t.assertContains(c.fake.requests[1].Body, '"color":null', "literal null on the wire")
end)

case("tags:delete DELETEs the encoded tag path", function()
	local c = t.newClient({ handler = noContent })
	c.junjo.friends.tags:delete("tag?x")
	t.assertEqual(c.fake.requests[1].Method, "DELETE", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/friend-tags/tag%3Fx",
		"encoded delete URL"
	)
end)

case("tags:assign PUTs the tagIds array to the encoded tags path", function()
	local c = t.newClient({
		handler = ok200('{"friendJunjoUserId":"user_2","tagIds":["tag_1","tag_2"]}'),
	})
	local assignment = c.junjo.friends.tags:assign("user 1", "user/2", { "tag_1", "tag_2" })
	t.assertEqual(c.fake.requests[1].Method, "PUT", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%201/friends/user%2F2/tags",
		"encoded assign URL"
	)
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(#body.tagIds, 2, "tagIds length")
	t.assertEqual(body.tagIds[1], "tag_1", "first tag id")
	t.assertEqual(body.tagIds[2], "tag_2", "second tag id")
	t.assertEqual(assignment.friendJunjoUserId, "user_2", "assignment decoded")
end)

case("tags:assign with an empty array clears the set", function()
	local c = t.newClient({
		handler = ok200('{"friendJunjoUserId":"user_2","tagIds":[]}'),
	})
	c.junjo.friends.tags:assign("user_1", "user_2", {})
	-- An empty Lua table would normally encode as {}; the server
	-- requires a tagIds ARRAY, so assert the wire shape explicitly.
	t.assertContains(c.fake.requests[1].Body, '"tagIds":[]', "empty array on the wire")
end)

-- ============================================================
-- friends.visibility
-- ============================================================

case("visibility:get GETs the encoded visibility path", function()
	local c = t.newClient({
		handler = ok200('{"junjoUserId":"user_1","friendsListVisibility":"public","updatedAt":null}'),
	})
	local settings = c.junjo.friends.visibility:get("user 1")
	t.assertEqual(c.fake.requests[1].Method, "GET", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user%201/visibility",
		"encoded visibility URL"
	)
	t.assertEqual(settings.friendsListVisibility, "public", "settings decoded")
	t.assertEqual(settings.updatedAt, nil, "null updatedAt decodes to nil")
end)

case("visibility:set PATCHes friendsListVisibility in the body", function()
	local c = t.newClient({
		handler = ok200('{"junjoUserId":"user_1","friendsListVisibility":"friends-only"}'),
	})
	local settings = c.junjo.friends.visibility:set("user_1", "friends-only")
	t.assertEqual(c.fake.requests[1].Method, "PATCH", "method")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/users/user_1/visibility",
		"visibility URL"
	)
	local body = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(body.friendsListVisibility, "friends-only", "friendsListVisibility in body")
	t.assertEqual(settings.friendsListVisibility, "friends-only", "settings decoded")
end)

return { name = "Friends", cases = cases }
