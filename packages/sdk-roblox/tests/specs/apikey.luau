-- API key shape validation in Junjo.new / resolveApiKey, mirroring the
-- TS SDK's validateApiKeyShape: jadm_ admin tokens raise, non-standard
-- shapes warn once, and GetSecret resolution still works.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

case("an admin token (jadm_*) raises invalid_config", function()
	local Junjo = t.loadJunjo()
	local fake = t.newFakeHttp()
	local err = t.expectJunjoError(Junjo.JunjoError, function()
		Junjo.new({ apiKey = "jadm_abc123", httpService = fake })
	end, "invalid_config")
	t.assertContains(err.message, "admin token", "names the confusion")
	t.assertContains(err.message, "jk_<prefix>.<secret>", "points at the right shape")
end)

case("an empty-string apiKey raises invalid_config", function()
	local Junjo = t.loadJunjo()
	local fake = t.newFakeHttp()
	t.expectJunjoError(Junjo.JunjoError, function()
		Junjo.new({ apiKey = "", httpService = fake })
	end, "invalid_config")
end)

case("a well-shaped key constructs without warning", function()
	local Junjo, warnings = t.loadJunjo()
	local fake = t.newFakeHttp()
	Junjo.new({ apiKey = "jk_live_abc.s3cr3t-value", httpService = fake })
	t.assertEqual(#warnings, 0, "no warnings for jk_<prefix>.<secret>")
end)

case("a non-standard key shape warns once (not per construction)", function()
	local Junjo, warnings = t.loadJunjo()
	local fake = t.newFakeHttp()
	Junjo.new({ apiKey = "weird-key-shape", httpService = fake })
	Junjo.new({ apiKey = "another weird one", httpService = fake })
	t.assertEqual(#warnings, 1, "warned exactly once")
	t.assertContains(warnings[1], "jk_<prefix>.<secret>", "warning names the shape")
end)

case("apiKeySecret resolves via GetSecret and is validated", function()
	local Junjo, warnings = t.loadJunjo()
	local fake = t.newFakeHttp({ secrets = { JUNJO_API_KEY = "jk_abc.def" } })
	Junjo.new({ apiKeySecret = "JUNJO_API_KEY", httpService = fake })
	t.assertEqual(#warnings, 0, "resolved secret passes shape validation")
end)

case("a missing secret falls back to apiKey", function()
	local Junjo = t.loadJunjo()
	local fake = t.newFakeHttp()
	local junjo = Junjo.new({
		apiKeySecret = "MISSING",
		apiKey = "jk_fallback.value",
		httpService = fake,
	})
	junjo.http:get("/v1/groups")
	t.assertEqual(
		fake.requests[1].Headers.Authorization,
		"Bearer jk_fallback.value",
		"fallback key used"
	)
end)

case("the apiKey fallback warns once, naming the secret and never the key", function()
	local Junjo, warnings = t.loadJunjo()
	local fake = t.newFakeHttp()
	local config = {
		apiKeySecret = "MISSING_SECRET",
		apiKey = "jk_fallback.value",
		httpService = fake,
	}
	Junjo.new(config)
	Junjo.new(config)
	t.assertEqual(#warnings, 1, "warned exactly once across constructions")
	t.assertContains(warnings[1], "[junjo-sdk]", "prefixed")
	t.assertContains(warnings[1], "MISSING_SECRET", "names the secret")
	t.assertContains(warnings[1], "low-privilege dev-game key", "points at a dev key")
	t.assertEqual(
		string.find(warnings[1], "jk_fallback.value", 1, true),
		nil,
		"never leaks the key value"
	)
end)

case("a resolved secret does not trigger the fallback warning", function()
	local Junjo, warnings = t.loadJunjo()
	local fake = t.newFakeHttp({ secrets = { JUNJO_API_KEY = "jk_abc.def" } })
	Junjo.new({
		apiKeySecret = "JUNJO_API_KEY",
		apiKey = "jk_fallback.value",
		httpService = fake,
	})
	t.assertEqual(#warnings, 0, "no warning when GetSecret succeeds")
end)

case("a Secret userdata apiKey builds the Authorization header via AddPrefix", function()
	local Junjo = t.loadJunjo()
	local secret = t.newSecretStub("jk_store.value")
	local fake = t.newFakeHttp({ secrets = { JUNJO_API_KEY = secret } })
	local junjo = Junjo.new({ apiKeySecret = "JUNJO_API_KEY", httpService = fake })
	junjo.http:get("/v1/groups")
	local header = fake.requests[1].Headers.Authorization
	t.assertEqual(type(header), "table", "header stays a Secret, not a string")
	t.assertEqual(header.__isSecretStub, true, "AddPrefix returned a new Secret")
	t.assertEqual(header.__secretValue, "Bearer jk_store.value", "Bearer scheme prefixed")
end)

case("a plain-string apiKey concatenates into the Authorization header", function()
	local Junjo = t.loadJunjo()
	local fake = t.newFakeHttp()
	local junjo = Junjo.new({ apiKey = "jk_plain.value", httpService = fake })
	junjo.http:get("/v1/groups")
	t.assertEqual(
		fake.requests[1].Headers.Authorization,
		"Bearer jk_plain.value",
		"string keys use plain concat"
	)
end)

case("a missing secret without an apiKey fallback raises invalid_config", function()
	local Junjo = t.loadJunjo()
	local fake = t.newFakeHttp()
	local err = t.expectJunjoError(Junjo.JunjoError, function()
		Junjo.new({ apiKeySecret = "MISSING", httpService = fake })
	end, "invalid_config")
	t.assertContains(err.message, "GetSecret", "names the failing lookup")
end)

return { name = "API key validation", cases = cases }
