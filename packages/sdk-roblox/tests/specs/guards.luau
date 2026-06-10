-- Nil-input guards: every public method with a required input table
-- raises invalid_config (naming the method) when called with nil, and
-- optional-input methods keep accepting nil.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

local function expectGuard(c, fn, methodLabel)
	local err = t.expectJunjoError(c.Junjo.JunjoError, fn, "invalid_config", methodLabel)
	t.assertContains(err.message, methodLabel, "message names " .. methodLabel)
	t.assertEqual(#c.fake.requests, 0, methodLabel .. " sent no request")
end

case("required-input methods raise invalid_config on nil", function()
	local c = t.newClient()
	expectGuard(c, function()
		c.junjo.groups:create(nil)
	end, "groups:create")
	expectGuard(c, function()
		c.junjo.groups:update("grp_1", nil)
	end, "groups:update")
	expectGuard(c, function()
		c.junjo.members:setMetadata("grp_1", "user_1", nil)
	end, "members:setMetadata")
	expectGuard(c, function()
		c.junjo.members:setNotes("grp_1", "user_1", nil)
	end, "members:setNotes")
	expectGuard(c, function()
		c.junjo.roles:create("grp_1", nil)
	end, "roles:create")
	expectGuard(c, function()
		c.junjo.roles:update("role_1", nil)
	end, "roles:update")
	expectGuard(c, function()
		c.junjo.webhooks.endpoints:create(nil)
	end, "webhooks.endpoints:create")
	expectGuard(c, function()
		c.junjo.webhooks.endpoints:update("whe_1", nil)
	end, "webhooks.endpoints:update")
end)

case("optional-input methods keep accepting nil", function()
	local c = t.newClient()
	c.junjo.groups:list(nil)
	c.junjo.groups:list()
	c.junjo.groups:delete("grp_1")
	c.junjo.groups:inviteByCode("grp_1")
	c.junjo.groups:declineInvitation("code123")
	c.junjo.groups:kick("grp_1", "user_1")
	c.junjo.members:list("grp_1")
	c.junjo.members:listForUser("user_1")
	c.junjo.invitations:list("grp_1")
	c.junjo.audit:list("grp_1")
	t.assertEqual(#c.fake.requests, 10, "every optional-input call went through")
end)

case("declineInvitation forwards opts.userId in the body", function()
	local c = t.newClient()
	c.junjo.groups:declineInvitation("code123", { userId = "user_bob" })
	t.assertContains(c.fake.requests[1].Body, '"userId":"user_bob"', "decline body")
	t.assertContains(c.fake.requests[1].Url, "/v1/invitations/code123/decline", "decline url")
end)

return { name = "Nil-input guards", cases = cases }
