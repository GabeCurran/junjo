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

case("JunjoError carries the x-request-id from a failed response", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 400,
				StatusMessage = "Bad Request",
				Body = '{"code":"bad_request","message":"name: too short","status":400}',
				-- The server delivers x-request-id lowercased, as Roblox does.
				Headers = { ["x-request-id"] = "req_abc123" },
			}
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.groups:create({ kind = "guild", name = "" })
	end, "bad_request")
	t.assertEqual(err.requestId, "req_abc123", "requestId from x-request-id header")
	t.assertEqual(err.retryAfterSeconds, nil, "no Retry-After present")
end)

case("the x-request-id lookup tolerates a differently-cased header name", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 403,
				StatusMessage = "Forbidden",
				Body = '{"code":"permission_denied","message":"nope","status":403}',
				Headers = { ["X-Request-Id"] = "req_MixedCase" },
			}
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "permission_denied")
	t.assertEqual(err.requestId, "req_MixedCase", "requestId matched case-insensitively")
end)

case("JunjoError carries retryAfterSeconds from a 429 Retry-After header", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 429,
				StatusMessage = "Too Many Requests",
				Body = '{"code":"rate_limit_exceeded","message":"slow down","status":429}',
				Headers = { ["Retry-After"] = "12", ["x-request-id"] = "req_ratelimited" },
			}
		end,
	})
	-- Default client opts out of retries, so the 429 raises immediately.
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "rate_limit_exceeded")
	t.assertEqual(err.status, 429, "status")
	t.assertEqual(err.retryAfterSeconds, 12, "retryAfterSeconds parsed as integer seconds")
	t.assertEqual(err.requestId, "req_ratelimited", "requestId alongside Retry-After")
end)

case("requestId and retryAfterSeconds are nil when the headers are absent", function()
	local c = t.newClient({
		handler = function()
			return {
				StatusCode = 500,
				StatusMessage = "Internal Server Error",
				Body = '{"code":"internal","message":"boom","status":500}',
			}
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "internal")
	t.assertEqual(err.requestId, nil, "no request-id header")
	t.assertEqual(err.retryAfterSeconds, nil, "no Retry-After header")
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

case("a request body with a reference cycle raises invalid_config before any request", function()
	local c = t.newClient()
	local looped = { name = "Wolves" }
	looped.self = looped
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:post("/v1/groups", looped)
	end, "invalid_config")
	t.assertContains(err.message, "reference cycle", "cycle message")
	t.assertEqual(#c.fake.requests, 0, "no request was sent")
end)

case("a shared (non-cyclic) subtable in the body does not trip the cycle guard", function()
	local c = t.newClient()
	local shared = { note = "shared" }
	c.junjo.http:post("/v1/groups", { a = shared, b = shared })
	t.assertEqual(#c.fake.requests, 1, "request went out")
	t.assertContains(c.fake.requests[1].Body, '"shared"', "shared subtable encoded")
end)

case("a sentinel-free body is encoded without the substitution pass", function()
	-- Observable contract: bodies with and without Junjo.Null both
	-- encode correctly (the sentinel-free path skips the deep copy
	-- internally; behavior must be identical either way).
	local c = t.newClient()
	c.junjo.http:post("/v1/groups", { kind = "guild", name = "Wolves" })
	t.assertContains(c.fake.requests[1].Body, '"Wolves"', "plain body encoded")
	c.junjo.http:post("/v1/groups", { name = "Wolves", parentId = c.Junjo.Null })
	t.assertContains(c.fake.requests[2].Body, '"parentId":null', "sentinel body still nulled")
end)

-- Roblox's JSONEncode turns an empty table into "[]", which the
-- server's object schemas reject with 400; the SDK must emit a literal
-- "{}" for a TOP-LEVEL empty body while leaving nested empty tables as
-- arrays. The fake HttpService mirrors Roblox's "[]" behavior, so
-- these assert the raw encoded body that would go over the wire.

case("groups:ban with no opts sends the empty-object body {}", function()
	local c = t.newClient()
	c.junjo.groups:ban("grp_1", "user_1")
	t.assertEqual(c.fake.requests[1].Body, "{}", "raw body")
end)

case("groups:kick with no reason sends the empty-object body {}", function()
	local c = t.newClient()
	c.junjo.groups:kick("grp_1", "user_1")
	t.assertEqual(c.fake.requests[1].Body, "{}", "raw body")
end)

case("groups:declineInvitation with no opts sends the empty-object body {}", function()
	local c = t.newClient()
	c.junjo.groups:declineInvitation("code_1")
	t.assertEqual(c.fake.requests[1].Body, "{}", "raw body")
end)

case("groups:inviteByCode with no input sends the empty-object body {}", function()
	local c = t.newClient({
		handler = function()
			return { StatusCode = 200, StatusMessage = "OK", Body = '{"code":"inv_1"}' }
		end,
	})
	c.junjo.groups:inviteByCode("grp_1")
	t.assertEqual(c.fake.requests[1].Body, "{}", "raw body")
end)

case("members:setNotes with an empty table sends the empty-object body {}", function()
	local c = t.newClient()
	c.junjo.members:setNotes("grp_1", "user_1", {})
	t.assertEqual(c.fake.requests[1].Body, "{}", "raw body")
end)

case("friends.tags:assign with an empty tagIds array still sends a nested []", function()
	-- Regression guard for the top-level-only rule: `tagIds = {}` is a
	-- genuine empty ARRAY the server requires; only the TOP-LEVEL empty
	-- table becomes "{}".
	local c = t.newClient()
	c.junjo.friends.tags:assign("user_1", "user_2", {})
	t.assertEqual(c.fake.requests[1].Body, '{"tagIds":[]}', "nested empty array preserved")
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
