-- Loads the Roblox SDK source (packages/sdk-roblox/src) inside lune by
-- simulating the two Roblox globals the source relies on: the `script`
-- instance tree (for `require(script.Parent.X)`-style paths) and
-- `game:GetService`. The SDK source itself stays Roblox-only; this shim
-- exists so lune can execute it for tests.
--
-- Mirrors rojo's filesystem mapping (default.project.json): `src/` with
-- its init.lua becomes the `Junjo` ModuleScript, sibling .lua files
-- become its child ModuleScripts, and sub-directories without an
-- init.lua become Folders.
--
-- Run with cwd = packages/sdk-roblox (the npm script and CI both do).

local fs = require("@lune/fs")
local luau = require("@lune/luau")

local SRC_DIR = "src"

-- ============================================================
-- Instance-tree nodes
-- ============================================================
--
-- A node stands in for a ModuleScript / Folder. Reads of `Parent`,
-- `Name`, and child names go through __index; unknown lookups raise so
-- a typo'd require path fails loudly instead of returning nil.

local NodeMeta = {}

NodeMeta.__index = function(node, key)
	if key == "Parent" then
		return rawget(node, "__parent")
	end
	if key == "Name" then
		return rawget(node, "__name")
	end
	local child = rawget(node, "__children")[key]
	if child ~= nil then
		return child
	end
	error(
		string.format(
			"roblox shim: %q has no child named %q",
			tostring(rawget(node, "__name")),
			tostring(key)
		),
		2
	)
end

local function makeNode(name, parent)
	local node = {
		__name = name,
		__parent = parent,
		__children = {},
		__file = nil,
	}
	return setmetatable(node, NodeMeta)
end

local function buildTree(dirPath, name, parent)
	local node = makeNode(name, parent)
	for _, entry in ipairs(fs.readDir(dirPath)) do
		local fullPath = dirPath .. "/" .. entry
		if fs.isDir(fullPath) then
			node.__children[entry] = buildTree(fullPath, entry, node)
		elseif entry == "init.lua" then
			node.__file = fullPath
		elseif string.sub(entry, -4) == ".lua" then
			local childName = string.sub(entry, 1, -5)
			local child = makeNode(childName, node)
			child.__file = fullPath
			node.__children[childName] = child
		end
	end
	return node
end

-- ============================================================
-- Module loading
-- ============================================================

-- Loads a fresh copy of the SDK (no module cache shared across calls,
-- so warn-once state etc. is isolated per test). Returns the Junjo
-- module table plus a `warnings` array capturing every `warn(...)` the
-- SDK emitted.
--
-- opts (all optional):
--   defaultHttpService - what game:GetService("HttpService") returns
--                        (only consulted when Junjo.new gets no
--                        config.httpService override)
--   players            - what game:GetService("Players") returns
local function loadJunjo(opts)
	opts = opts or {}
	if not fs.isDir(SRC_DIR) then
		error("roblox shim: src/ not found; run the tests with cwd = packages/sdk-roblox")
	end

	local warnings = {}
	local cache = {}

	local fakeGame = {
		GetService = function(_, serviceName)
			if serviceName == "HttpService" then
				-- Tests always inject config.httpService, so a hollow
				-- stub is enough for the default.
				return opts.defaultHttpService or {}
			end
			if serviceName == "Players" then
				return opts.players or { LocalPlayer = nil }
			end
			error("roblox shim: unhandled service " .. tostring(serviceName))
		end,
	}

	local function recordWarn(...)
		local parts = {}
		for _, value in ipairs({ ... }) do
			table.insert(parts, tostring(value))
		end
		table.insert(warnings, table.concat(parts, " "))
	end

	local root = buildTree(SRC_DIR, "Junjo", nil)

	local requireNode
	requireNode = function(node)
		local cached = cache[node]
		if cached ~= nil then
			return cached
		end
		local file = rawget(node, "__file")
		if file == nil then
			error("roblox shim: cannot require a Folder node: " .. tostring(rawget(node, "__name")))
		end
		local chunk = luau.load(fs.readFile(file), {
			debugName = file,
			environment = {
				script = node,
				require = requireNode,
				game = fakeGame,
				warn = recordWarn,
			},
			injectGlobals = true,
		})
		local result = chunk()
		cache[node] = result
		return result
	end

	return requireNode(root), warnings
end

return {
	loadJunjo = loadJunjo,
}
