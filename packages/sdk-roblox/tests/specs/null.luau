-- Junjo.Null round-trip: the sentinel becomes a literal JSON null on
-- the wire, plain values are untouched, and decoding the encoded body
-- yields the field as absent (Lua nil) again.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

case("top-level Null fields encode as literal JSON null", function()
	local c = t.newClient()
	c.junjo.groups:update("grp_1", { defaultRoleId = c.Junjo.Null, name = "Renamed" })
	local body = c.fake.requests[1].Body
	t.assertContains(body, '"defaultRoleId":null', "null on the wire")
	t.assertContains(body, '"name":"Renamed"', "plain field untouched")
end)

case("nested Null fields encode as literal JSON null", function()
	local c = t.newClient()
	c.junjo.http:patch("/v1/anything", { outer = { cleared = c.Junjo.Null, kept = "v" } })
	local body = c.fake.requests[1].Body
	t.assertContains(body, '"cleared":null', "nested null")
	t.assertContains(body, '"kept":"v"', "nested sibling untouched")
end)

case("setParent(nil) substitutes Null for the required field", function()
	local c = t.newClient()
	c.junjo.groups:setParent("grp_1", nil)
	t.assertContains(c.fake.requests[1].Body, '"parentGroupId":null', "nil becomes null")
end)

case("the encoded null decodes back to an absent field", function()
	local c = t.newClient()
	c.junjo.groups:update("grp_1", { defaultRoleId = c.Junjo.Null })
	local decoded = c.fake:JSONDecode(c.fake.requests[1].Body)
	t.assertEqual(decoded.defaultRoleId, nil, "JSON null reads back as Lua nil")
end)

return { name = "Junjo.Null", cases = cases }
