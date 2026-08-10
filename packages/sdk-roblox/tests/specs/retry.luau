-- Http.lua retry policy: opt-in via config.retries (default performs
-- zero retries), 429 retried for any method with Retry-After support,
-- 5xx and transport failures retried for GET only, exponential backoff
-- with jitter recorded through the injectable wait function.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

local RATE_LIMIT_BODY = '{"code":"rate_limit_exceeded","message":"slow down","status":429}'
local SERVER_ERROR_BODY = '{"code":"internal","message":"boom","status":500}'
local OK_BODY = '{"ok":true}'

local function rateLimited(headers)
	return {
		StatusCode = 429,
		StatusMessage = "Too Many Requests",
		Body = RATE_LIMIT_BODY,
		Headers = headers,
	}
end

local function serverError()
	return { StatusCode = 500, StatusMessage = "Internal Server Error", Body = SERVER_ERROR_BODY }
end

local function okResponse()
	return { StatusCode = 200, StatusMessage = "OK", Body = OK_BODY }
end

-- Builds a client with retries enabled and a fake clock: returns the
-- client plus the array of sleep durations the transport requested.
local function newRetryClient(opts)
	local sleeps = {}
	local c = t.newClient({
		handler = opts.handler,
		retries = {
			maxAttempts = opts.maxAttempts,
			backoffSeconds = opts.backoffSeconds,
			wait = function(seconds)
				table.insert(sleeps, seconds)
			end,
		},
	})
	return c, sleeps
end

local function assertBetween(value, low, high, label)
	if type(value) ~= "number" or value < low or value > high then
		error(
			string.format(
				"%s: expected a number in [%s, %s], got %s",
				label or "assertBetween",
				tostring(low),
				tostring(high),
				tostring(value)
			),
			2
		)
	end
end

case("429 then success retries and sleeps within the jitter bounds", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 3,
		backoffSeconds = 1,
		handler = function(_, callIndex)
			if callIndex == 1 then
				return rateLimited(nil)
			end
			return okResponse()
		end,
	})
	local result = c.junjo.http:get("/v1/groups")
	t.assertEqual(result.ok, true, "eventual success")
	t.assertEqual(#c.fake.requests, 2, "request count")
	t.assertEqual(#sleeps, 1, "sleep count")
	-- backoffSeconds * 2^0 * jitter, jitter in [1.0, 1.5).
	assertBetween(sleeps[1], 1, 1.5, "first backoff")
end)

case("429 Retry-After larger than the backoff wins", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 2,
		backoffSeconds = 1,
		handler = function(_, callIndex)
			if callIndex == 1 then
				return rateLimited({ ["Retry-After"] = "7" })
			end
			return okResponse()
		end,
	})
	local result = c.junjo.http:get("/v1/groups")
	t.assertEqual(result.ok, true, "eventual success")
	t.assertEqual(#sleeps, 1, "sleep count")
	t.assertEqual(sleeps[1], 7, "Retry-After seconds used verbatim")
end)

case("429 Retry-After smaller than the backoff is ignored", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 2,
		backoffSeconds = 1,
		handler = function(_, callIndex)
			if callIndex == 1 then
				-- Lowercase header name: the lookup is case-insensitive.
				return rateLimited({ ["retry-after"] = "0" })
			end
			return okResponse()
		end,
	})
	c.junjo.http:get("/v1/groups")
	t.assertEqual(#sleeps, 1, "sleep count")
	assertBetween(sleeps[1], 1, 1.5, "computed backoff kept")
end)

case("429 retries respect maxAttempts and surface the rate_limit_exceeded envelope", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 3,
		backoffSeconds = 1,
		handler = function()
			return rateLimited(nil)
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "rate_limit_exceeded")
	t.assertEqual(err.status, 429, "envelope status")
	t.assertEqual(err.message, "slow down", "envelope message")
	t.assertEqual(#c.fake.requests, 3, "attempts capped at maxAttempts")
	t.assertEqual(#sleeps, 2, "one sleep between each attempt")
end)

case("429 on a write (POST) is retried too", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 2,
		backoffSeconds = 1,
		handler = function(_, callIndex)
			if callIndex == 1 then
				return rateLimited(nil)
			end
			return okResponse()
		end,
	})
	local result = c.junjo.http:post("/v1/groups", { kind = "guild", name = "Wolves" })
	t.assertEqual(result.ok, true, "eventual success")
	t.assertEqual(#c.fake.requests, 2, "request count")
	t.assertEqual(#sleeps, 1, "sleep count")
end)

case("GET 5xx is retried then succeeds", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 2,
		backoffSeconds = 1,
		handler = function(_, callIndex)
			if callIndex == 1 then
				return serverError()
			end
			return okResponse()
		end,
	})
	local result = c.junjo.http:get("/v1/groups")
	t.assertEqual(result.ok, true, "eventual success")
	t.assertEqual(#c.fake.requests, 2, "request count")
	t.assertEqual(#sleeps, 1, "sleep count")
end)

case("GET 5xx exhausting maxAttempts raises the envelope error", function()
	local c = newRetryClient({
		maxAttempts = 2,
		backoffSeconds = 1,
		handler = function()
			return serverError()
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "internal")
	t.assertEqual(err.status, 500, "envelope status")
	t.assertEqual(err.message, "boom", "envelope message")
	t.assertEqual(#c.fake.requests, 2, "attempts capped at maxAttempts")
end)

case("POST 5xx is NOT retried", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 3,
		backoffSeconds = 1,
		handler = function()
			return serverError()
		end,
	})
	t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:post("/v1/groups", { kind = "guild", name = "Wolves" })
	end, "internal")
	t.assertEqual(#c.fake.requests, 1, "single attempt")
	t.assertEqual(#sleeps, 0, "no sleeps")
end)

case("GET transport failure is retried then succeeds", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 2,
		backoffSeconds = 1,
		handler = function(_, callIndex)
			if callIndex == 1 then
				error("connection reset by peer")
			end
			return okResponse()
		end,
	})
	local result = c.junjo.http:get("/v1/groups")
	t.assertEqual(result.ok, true, "eventual success")
	t.assertEqual(#c.fake.requests, 2, "request count")
	t.assertEqual(#sleeps, 1, "sleep count")
end)

case("GET transport failure exhausting maxAttempts raises network", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 3,
		backoffSeconds = 1,
		handler = function()
			error("connection reset by peer")
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "network")
	t.assertContains(err.message, "connection reset", "transport message")
	t.assertEqual(#c.fake.requests, 3, "attempts capped at maxAttempts")
	t.assertEqual(#sleeps, 2, "one sleep between each attempt")
end)

case("POST transport failure is NOT retried", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 3,
		backoffSeconds = 1,
		handler = function()
			error("connection reset by peer")
		end,
	})
	t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:post("/v1/groups", { kind = "guild", name = "Wolves" })
	end, "network")
	t.assertEqual(#c.fake.requests, 1, "single attempt")
	t.assertEqual(#sleeps, 0, "no sleeps")
end)

case("GET 4xx other than 429 is never retried even with retries enabled", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 3,
		backoffSeconds = 1,
		handler = function()
			return {
				StatusCode = 404,
				StatusMessage = "Not Found",
				Body = '{"code":"not_found","message":"no such group","status":404}',
			}
		end,
	})
	t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups/missing")
	end, "not_found")
	t.assertEqual(#c.fake.requests, 1, "single attempt")
	t.assertEqual(#sleeps, 0, "no sleeps")
end)

case("default config performs zero retries", function()
	local c = t.newClient({
		handler = function()
			return rateLimited(nil)
		end,
	})
	local err = t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "rate_limit_exceeded")
	t.assertEqual(err.status, 429, "envelope status")
	t.assertEqual(#c.fake.requests, 1, "single attempt")
end)

case("backoff grows exponentially within the jitter bounds", function()
	local c, sleeps = newRetryClient({
		maxAttempts = 4,
		backoffSeconds = 1,
		handler = function()
			return rateLimited(nil)
		end,
	})
	t.expectJunjoError(c.Junjo.JunjoError, function()
		c.junjo.http:get("/v1/groups")
	end, "rate_limit_exceeded")
	t.assertEqual(#c.fake.requests, 4, "attempts capped at maxAttempts")
	t.assertEqual(#sleeps, 3, "one sleep between each attempt")
	-- base * 2^(n-1) * jitter, jitter in [1.0, 1.5): bands never overlap,
	-- so each sleep is strictly longer than the previous one.
	assertBetween(sleeps[1], 1, 1.5, "first backoff")
	assertBetween(sleeps[2], 2, 3, "second backoff")
	assertBetween(sleeps[3], 4, 6, "third backoff")
	if not (sleeps[2] > sleeps[1] and sleeps[3] > sleeps[2]) then
		error("backoff did not grow monotonically: " .. table.concat(sleeps, ", "))
	end
end)

case("invalid retries config raises invalid_config at construction", function()
	local Junjo = t.loadJunjo()
	local fake = t.newFakeHttp()
	local function construct(retries)
		return function()
			Junjo.new({
				apiKey = "jk_test.secret",
				baseUrl = "https://api.test",
				httpService = fake,
				retries = retries,
			})
		end
	end
	t.expectJunjoError(Junjo.JunjoError, construct("nope"), "invalid_config")
	t.expectJunjoError(Junjo.JunjoError, construct({ maxAttempts = 0 }), "invalid_config")
	t.expectJunjoError(Junjo.JunjoError, construct({ maxAttempts = 1.5 }), "invalid_config")
	t.expectJunjoError(Junjo.JunjoError, construct({ backoffSeconds = 0 }), "invalid_config")
	t.expectJunjoError(Junjo.JunjoError, construct({ backoffSeconds = -1 }), "invalid_config")
	t.expectJunjoError(Junjo.JunjoError, construct({ wait = 5 }), "invalid_config")
end)

return { name = "Retry policy", cases = cases }
