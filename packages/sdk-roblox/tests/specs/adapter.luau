-- Junjo.RobloxUserIdAdapter: every resolve shape (Player stub, numeric
-- id, string id, explicitUserId, LocalPlayer fallback) plus the
-- construction-time validation, exercised through the roblox shim's
-- `players` injection support.

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

-- Loads a fresh SDK copy with an injected Players service (what
-- game:GetService("Players") returns inside the shim).
local function loadWithPlayers(players)
	return t.loadJunjo({ players = players })
end

case("resolve(player) returns the stub's UserId as a string", function()
	local Junjo = loadWithPlayers(nil)
	local adapter = Junjo.RobloxUserIdAdapter()
	t.assertEqual(adapter:resolve({ UserId = 261 }), "261", "player stub")
end)

case("resolve(player) rejects a UserId that is not a positive integer", function()
	local Junjo = loadWithPlayers(nil)
	local adapter = Junjo.RobloxUserIdAdapter()
	for _, badUserId in ipairs({ 0, -5, 1.5, "261" }) do
		local err = t.expectJunjoError(Junjo.JunjoError, function()
			adapter:resolve({ UserId = badUserId })
		end, "invalid_config", "UserId = " .. tostring(badUserId))
		t.assertContains(err.message, "positive integer", "UserId validation message")
	end
end)

case("resolve(number) stringifies a positive integer id", function()
	local Junjo = loadWithPlayers(nil)
	local adapter = Junjo.RobloxUserIdAdapter()
	t.assertEqual(adapter:resolve(42), "42", "small id")
	t.assertEqual(adapter:resolve(3232235521), "3232235521", "large id")
end)

case("resolve(number) rejects non-positive and fractional numbers", function()
	local Junjo = loadWithPlayers(nil)
	local adapter = Junjo.RobloxUserIdAdapter()
	for _, badId in ipairs({ 0, -1, 2.5 }) do
		t.expectJunjoError(Junjo.JunjoError, function()
			adapter:resolve(badId)
		end, "invalid_config", "id = " .. tostring(badId))
	end
end)

case("resolve(string) returns a non-empty string verbatim", function()
	local Junjo = loadWithPlayers(nil)
	local adapter = Junjo.RobloxUserIdAdapter()
	t.assertEqual(adapter:resolve("u_123"), "u_123", "opaque id passthrough")
	t.assertEqual(adapter:resolve("261"), "261", "numeric string passthrough")
end)

case("resolve('') raises invalid_config", function()
	local Junjo = loadWithPlayers(nil)
	local adapter = Junjo.RobloxUserIdAdapter()
	t.expectJunjoError(Junjo.JunjoError, function()
		adapter:resolve("")
	end, "invalid_config")
end)

case("resolve(boolean) raises invalid_config naming the received type", function()
	local Junjo = loadWithPlayers(nil)
	local adapter = Junjo.RobloxUserIdAdapter()
	local err = t.expectJunjoError(Junjo.JunjoError, function()
		adapter:resolve(true)
	end, "invalid_config")
	t.assertContains(err.message, "got boolean", "type in message")
end)

case("resolve() reads LocalPlayer from the injected Players service", function()
	local Junjo = loadWithPlayers({ LocalPlayer = { UserId = 777 } })
	local adapter = Junjo.RobloxUserIdAdapter()
	t.assertEqual(adapter:resolve(), "777", "LocalPlayer UserId")
end)

case("resolve() with a nil LocalPlayer raises invalid_config", function()
	local Junjo = loadWithPlayers({ LocalPlayer = nil })
	local adapter = Junjo.RobloxUserIdAdapter()
	local err = t.expectJunjoError(Junjo.JunjoError, function()
		adapter:resolve()
	end, "invalid_config")
	t.assertContains(err.message, "LocalPlayer is nil", "server-context hint")
end)

case("opts.players on the adapter overrides the service default", function()
	local Junjo = loadWithPlayers({ LocalPlayer = nil })
	local adapter = Junjo.RobloxUserIdAdapter({
		players = { LocalPlayer = { UserId = 888 } },
	})
	t.assertEqual(adapter:resolve(), "888", "constructor-injected Players")
end)

case("explicitUserId wins over every argument shape", function()
	local Junjo = loadWithPlayers({ LocalPlayer = { UserId = 777 } })
	local adapter = Junjo.RobloxUserIdAdapter({ explicitUserId = "u_fixed" })
	t.assertEqual(adapter:resolve(), "u_fixed", "no argument")
	t.assertEqual(adapter:resolve({ UserId = 261 }), "u_fixed", "player argument ignored")
	t.assertEqual(adapter:resolve(42), "u_fixed", "numeric argument ignored")
	t.assertEqual(adapter:resolve("u_other"), "u_fixed", "string argument ignored")
end)

case("a numeric explicitUserId is stringified at construction", function()
	local Junjo = loadWithPlayers(nil)
	local adapter = Junjo.RobloxUserIdAdapter({ explicitUserId = 261 })
	t.assertEqual(adapter:resolve(), "261", "stringified id")
end)

case("invalid explicitUserId values raise invalid_config", function()
	local Junjo = loadWithPlayers(nil)
	for _, badId in ipairs({ "", 0, -1, 1.5, true }) do
		t.expectJunjoError(Junjo.JunjoError, function()
			Junjo.RobloxUserIdAdapter({ explicitUserId = badId })
		end, "invalid_config", "explicitUserId = " .. tostring(badId))
	end
end)

case("RobloxUserIdAdapter(opts) rejects a non-table opts", function()
	local Junjo = loadWithPlayers(nil)
	local err = t.expectJunjoError(Junjo.JunjoError, function()
		Junjo.RobloxUserIdAdapter("nope")
	end, "invalid_config")
	t.assertContains(err.message, "expected a table or nil", "opts validation message")
end)

return { name = "RobloxUserIdAdapter", cases = cases }
