-- Junjo.VERSION must stay in sync with package.json's "version" field
-- (the release workflow additionally checks it against the release tag).

local fs = require("@lune/fs")
local serde = require("@lune/serde")

local t = require("../helpers/testkit")

local cases = {}

local function case(name, fn)
	table.insert(cases, { name = name, fn = fn })
end

case("Junjo.VERSION matches package.json", function()
	local Junjo = t.loadJunjo()
	local pkg = serde.decode("json", fs.readFile("package.json"))
	t.assertEqual(Junjo.VERSION, pkg.version, "Junjo.VERSION vs package.json version")
end)

case("Junjo.VERSION is a semver-shaped string", function()
	local Junjo = t.loadJunjo()
	if not string.match(Junjo.VERSION, "^%d+%.%d+%.%d+$") then
		error("Junjo.VERSION is not X.Y.Z shaped: " .. tostring(Junjo.VERSION))
	end
end)

return { name = "Junjo.VERSION", cases = cases }
