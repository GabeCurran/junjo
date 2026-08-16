-- Lune-based test runner for the Junjo.io SDK for Roblox.
--
-- The SDK source under src/ is Roblox-only Luau; lune executes it via
-- the shim in helpers/roblox.luau (a fake `script` tree + `game`), and
-- HTTP behavior is exercised through the SDK's documented
-- `config.httpService` injection point (helpers/fakeHttp.luau).
--
-- Run from packages/sdk-roblox:
--   lune run tests/run.luau
-- or via npm (skips politely when lune is not installed):
--   npm test

local process = require("@lune/process")

local specs = {
	require("./specs/http"),
	require("./specs/retry"),
	require("./specs/adapter"),
	require("./specs/urls"),
	require("./specs/null"),
	require("./specs/guards"),
	require("./specs/apikey"),
	require("./specs/moderation"),
	require("./specs/queries"),
	require("./specs/permissions"),
	require("./specs/bans"),
	require("./specs/friends"),
	require("./specs/pageAll"),
	require("./specs/version"),
}

local passed = 0
local failed = 0

for _, spec in ipairs(specs) do
	print(spec.name)
	for _, case in ipairs(spec.cases) do
		local ok, err = pcall(case.fn)
		if ok then
			passed += 1
			print("  PASS  " .. case.name)
		else
			failed += 1
			print("  FAIL  " .. case.name)
			print("        " .. tostring(err))
		end
	end
end

print("")
print(string.format("%d passed, %d failed", passed, failed))

if failed > 0 then
	process.exit(1)
end
