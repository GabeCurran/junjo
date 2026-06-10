-- Http.lua behavior: network failures, the success-status split between
-- pcall failure and non-2xx status codes, error-envelope parsing, JSON
-- decode failures, and the JSONEncode pcall on request bodies.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

case("RequestAsync raising surfaces as a network JunjoError", function()
	local c = t.newClient({
		handler = function()
			error("Http requests are not enabled. Enable via game settings.")
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "network")
	t.assertContains(err.message, "Http requests are not enabled", "network message")
end)

case("2xx responses decode to the parsed JSON value", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"id":"grp_1","name":"Wolves"}' }
		end,
	})
	local group = c.junjo.groups:create({ kind = "guild", name = "Wolves" })
	t.assertEqual(group.id, "grp_1", "decoded id")
	t.assertEqual(group.name, "Wolves", "decoded name")
end)

case("non-2xx with a JSON envelope maps code / message / status", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 400,
				StatusMessage = "Bad Request",
				Body = '{"code":"bad_request","message":"name: too short","status":400}',
			}
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.groups:create({ kind = "guild", name = "" })
	end, "bad_request")
	t.assertEqual(err.status, 400, "status")
	t.assertEqual(err.message, "name: too short", "message")
end)

case("non-2xx with a non-JSON body falls back to StatusMessage / internal", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 502, StatusMessage = "Bad Gateway", Body = "<html>bad gateway</html>" }
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "internal")
	t.assertEqual(err.status, 502, "status falls back to StatusCode")
	t.assertEqual(err.message, "Bad Gateway", "message falls back to StatusMessage")
end)

case("204 / empty bodies return nil", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 204, StatusMessage = "No Content", Body = "" }
		end,
	})
	t.assertEqual(c.junjo.http:delete("/v1/roles/role_1"), nil, "204 result")
end)

case("a 2xx body that is not valid JSON raises internal with the status", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = "not json at all" }
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "internal")
	t.assertEqual(err.status, 200, "status carried through")
	t.assertContains(err.message, "not valid JSON", "decode failure message")
end)

case("an unexpected RequestAsync return shape raises internal", function()
	local c = t.newClient({
		handler = function()
			return "definitely not a response table"
		end,
	})
	t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "internal")
end)

case("a body JSONEncode cannot serialize raises invalid_config before any request", function()
	local c = t.newClient()
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:post("/v1/groups", { callback = function() end })
	end, "invalid_config")
	t.assertContains(err.message, "not JSON-encodable", "encode failure message")
	t.assertEqual(#c.fake.requests, 0, "no request was sent")
end)

case("tryGet lookups translate not_found to nil", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 404,
				StatusMessage = "Not Found",
				Body = '{"code":"not_found","message":"no such group","status":404}',
			}
		end,
	})
	t.assertEqual(c.junjo.groups:get("does-not-exist"), nil, "groups:get on 404")
	t.assertEqual(c.junjo.members:getById("missing"), nil, "members:getById on 404")
	t.assertEqual(c.junjo.roles:get("missing"), nil, "roles:get on 404")
	t.assertEqual(c.junjo.invitations:get("missing"), nil, "invitations:get on 404")
end)

case("tryGet lookups re-throw every other error code", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 403,
				StatusMessage = "Forbidden",
				Body = '{"code":"permission_denied","message":"nope","status":403}',
			}
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.groups:get("grp_1")
	end, "permission_denied")
	t.assertEqual(err.status, 403, "status preserved")
end)

return { name = "Http", cases = cases }
