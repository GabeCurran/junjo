-- Junjo.pageAll and the listAll / banHistoryAll conveniences built on
-- it: multi-page iteration feeds each page's nextCursor back into the
-- fetch, stops after the page whose nextCursor is nil, and propagates
-- fetch errors out of the loop unchanged.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

-- Handler for a two-page listing: page 1 (no cursor) hands back
-- nextCursor "c1"; page 2 ends the listing with a JSON-null cursor.
local function twoPageHandler(pageOneItems, pageTwoItems)
	return function(requestOptions)
		if string.find(requestOptions.Url, "cursor=c1", 1, true) then
			return {
				StatusCode = 200,
				StatusMessage = "OK",
				Body = '{"items":' .. pageTwoItems .. ',"nextCursor":null}',
			}
		end
		return {
			StatusCode = 200,
			StatusMessage = "OK",
			Body = '{"items":' .. pageOneItems .. ',"nextCursor":"c1"}',
		}
	end
end

case("iterates items across pages, feeding nextCursor back into the fetch", function()
	local Junjo = t.loadJunjo()
	local seenCursors = {}
	local pages = {
		{ items = { "a", "b" }, nextCursor = "c1" },
		{ items = { "c" }, nextCursor = "c2" },
		{ items = { "d" }, nextCursor = nil },
	}
	local fetchCount = 0
	local collected = {}
	for item in Junjo.pageAll(function(cursor)
		fetchCount += 1
		table.insert(seenCursors, tostring(cursor))
		return pages[fetchCount]
	end) do
		table.insert(collected, item)
	end
	t.assertEqual(table.concat(collected, ","), "a,b,c,d", "items in order")
	t.assertEqual(table.concat(seenCursors, ","), "nil,c1,c2", "cursors fed back")
	t.assertEqual(fetchCount, 3, "no fetch after the nil-cursor page")
end)

case("an empty final page ends iteration without yielding", function()
	local Junjo = t.loadJunjo()
	local pages = {
		{ items = { "a" }, nextCursor = "c1" },
		{ items = {}, nextCursor = nil },
	}
	local fetchCount = 0
	local collected = {}
	for item in Junjo.pageAll(function()
		fetchCount += 1
		return pages[fetchCount]
	end) do
		table.insert(collected, item)
	end
	t.assertEqual(#collected, 1, "only the real item")
	t.assertEqual(fetchCount, 2, "both pages fetched")
end)

case("errors raised by the fetch propagate out of the loop", function()
	local Junjo = t.loadJunjo()
	local collected = {}
	local err = t.expectError(function()
		for item in Junjo.pageAll(function(cursor)
			if cursor ~= nil then
				error("page two exploded", 0)
			end
			return { items = { "a" }, nextCursor = "c1" }
		end) do
			table.insert(collected, item)
		end
	end, "fetch error")
	t.assertContains(tostring(err), "page two exploded", "original error surfaced")
	t.assertEqual(#collected, 1, "items before the failure were yielded")
end)

case("a page repeating the previous non-nil cursor raises internal", function()
	-- Forward-progress guard: a BYO server that echoes the request
	-- cursor back as nextCursor would otherwise loop forever.
	local Junjo = t.loadJunjo()
	local collected = {}
	local fetchCount = 0
	local err = t.expectJunjoError(Junjo.JunjoError, function()
		for item in Junjo.pageAll(function(cursor)
			fetchCount += 1
			if cursor == nil then
				return { items = { "a" }, nextCursor = "stuck" }
			end
			return { items = { "b" }, nextCursor = "stuck" }
		end) do
			table.insert(collected, item)
		end
	end, "internal")
	t.assertContains(err.message, "same nextCursor", "names the stall")
	t.assertEqual(fetchCount, 2, "stopped at the repeating page")
	t.assertEqual(#collected, 1, "items before the stalled page were yielded")
end)

case("a fetch that returns a non-page raises internal", function()
	local Junjo = t.loadJunjo()
	t.expectJunjoError(Junjo.JunjoError, function()
		for _ in Junjo.pageAll(function()
			return "not a page"
		end) do
		end
	end, "internal")
end)

case("groups:listAll walks pages and forwards limit / viewer each fetch", function()
	local c = t.newClient({
		handler = twoPageHandler('[{"id":"grp_1"},{"id":"grp_2"}]', '[{"id":"grp_3"}]'),
	})
	local ids = {}
	for group in c.junjo.groups:listAll({ limit = 2, viewer = "user_1" }) do
		table.insert(ids, group.id)
	end
	t.assertEqual(table.concat(ids, ","), "grp_1,grp_2,grp_3", "all groups")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups?limit=2&viewer=user_1",
		"first page URL"
	)
	t.assertEqual(
		c.fake.requests[2].Url,
		"https://api.test/v1/groups?limit=2&cursor=c1&viewer=user_1",
		"second page URL carries the cursor"
	)
	t.assertEqual(#c.fake.requests, 2, "exactly two fetches")
end)

case("members:listAll walks pages and forwards the status filter", function()
	local c = t.newClient({
		handler = twoPageHandler('[{"id":"mem_1"}]', '[{"id":"mem_2"}]'),
	})
	local ids = {}
	for member in c.junjo.members:listAll("grp_1", { status = { "banned" } }) do
		table.insert(ids, member.id)
	end
	t.assertEqual(table.concat(ids, ","), "mem_1,mem_2", "all members")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp_1/members?status=banned",
		"first page URL"
	)
	t.assertEqual(
		c.fake.requests[2].Url,
		"https://api.test/v1/groups/grp_1/members?cursor=c1&status=banned",
		"second page URL carries cursor + filter"
	)
end)

case("groups:banHistoryAll walks the ban timeline pages", function()
	local c = t.newClient({
		handler = twoPageHandler('[{"id":"bh_1"}]', '[{"id":"bh_2"}]'),
	})
	local ids = {}
	for entry in c.junjo.groups:banHistoryAll("grp_1", { limit = 1 }) do
		table.insert(ids, entry.id)
	end
	t.assertEqual(table.concat(ids, ","), "bh_1,bh_2", "all entries")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/groups/grp_1/bans/history?limit=1",
		"first page URL"
	)
	t.assertEqual(
		c.fake.requests[2].Url,
		"https://api.test/v1/groups/grp_1/bans/history?limit=1&cursor=c1",
		"second page URL carries the cursor"
	)
end)

case("webhooks.endpoints:listAll walks pages and forwards the limit", function()
	local c = t.newClient({
		handler = twoPageHandler('[{"id":"whe_1"}]', '[{"id":"whe_2"}]'),
	})
	local ids = {}
	for endpoint in c.junjo.webhooks.endpoints:listAll({ limit = 1 }) do
		table.insert(ids, endpoint.id)
	end
	t.assertEqual(table.concat(ids, ","), "whe_1,whe_2", "all endpoints")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/webhooks?limit=1",
		"first page URL"
	)
	t.assertEqual(
		c.fake.requests[2].Url,
		"https://api.test/v1/webhooks?limit=1&cursor=c1",
		"second page URL carries the cursor"
	)
end)

case("webhooks.endpoints:list returns the full page envelope with the cursor", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 200,
				StatusMessage = "OK",
				Body = '{"items":[{"id":"whe_1"}],"nextCursor":"whe_1"}',
			}
		end,
	})
	local page = c.junjo.webhooks.endpoints:list({ limit = 5, cursor = "whe_0" })
	t.assertEqual(page.items[1].id, "whe_1", "items preserved")
	t.assertEqual(page.nextCursor, "whe_1", "cursor no longer discarded")
	t.assertEqual(
		c.fake.requests[1].Url,
		"https://api.test/v1/webhooks?limit=5&cursor=whe_0",
		"limit / cursor query"
	)
	t.assertEqual(#c.fake.requests, 1, "single fetch")

	local bare = c.junjo.webhooks.endpoints:list()
	t.assertEqual(c.fake.requests[2].Url, "https://api.test/v1/webhooks", "no query without opts")
	t.assertEqual(bare.nextCursor, "whe_1", "envelope shape without opts")
end)

return { name = "pageAll", cases = cases }
