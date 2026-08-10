-- Tiny shared assertion + setup kit for the spec files.

local roblox = require("./roblox")
local fakeHttp = require("./fakeHttp")

local M = {}

M.loadJunjo = roblox.loadJunjo
M.newFakeHttp = fakeHttp.new
M.newSecretStub = fakeHttp.newSecretStub

-- Builds a fully-wired client backed by a fake HttpService.
-- Returns { junjo, fake, Junjo, warnings }.
function M.newClient(opts)
	opts = opts or {}
	local Junjo, warnings = roblox.loadJunjo()
	local fake = fakeHttp.new({ handler = opts.handler, secrets = opts.secrets })
	local junjo = Junjo.new({
		apiKey = opts.apiKey or "jk_test.secret",
		baseUrl = opts.baseUrl or "https://api.test",
		httpService = fake,
		retries = opts.retries,
	})
	return {
		junjo = junjo,
		fake = fake,
		Junjo = Junjo,
		warnings = warnings,
	}
end

function M.assertEqual(actual, expected, label)
	if actual ~= expected then
		error(
			string.format(
				"%s: expected %s, got %s",
				label or "assertEqual",
				tostring(expected),
				tostring(actual)
			),
			2
		)
	end
end

function M.assertContains(haystack, needle, label)
	if type(haystack) ~= "string" or not string.find(haystack, needle, 1, true) then
		error(
			string.format(
				"%s: expected to find %q in %q",
				label or "assertContains",
				tostring(needle),
				tostring(haystack)
			),
			2
		)
	end
end

-- Asserts fn() raises, and returns whatever it raised.
function M.expectError(fn, label)
	local ok, err = pcall(fn)
	if ok then
		error((label or "expectError") .. ": expected an error, got success", 2)
	end
	return err
end

-- Asserts fn() raises a JunjoError with the given code; returns the error.
function M.expectJunjoError(JunjoError, fn, code, label)
	local err = M.expectError(fn, label)
	if not JunjoError.is(err) then
		error(
			string.format("%s: expected a JunjoError, got %s", label or "expectJunjoError", tostring(err)),
			2
		)
	end
	M.assertEqual(err.code, code, (label or "expectJunjoError") .. " code")
	return err
end

return M
