--!nonstrict
-- Nonstrict, not strict: the `require(script.Parent.X)` type needs the
-- Roblox definition files to pass strict analysis, which CI cannot run
-- yet. The signature carries annotations regardless.
--
-- Shared pagination helper: wraps a cursor-paginated fetch into a
-- generic-for iterator, the Luau counterpart of the TypeScript SDK's
-- `paginate` async generator. An iterator (rather than a collect-all
-- table) is the idiomatic Luau shape: it drops straight into
-- `for item in ... do`, fetches pages lazily so callers can `break`
-- early without paying for pages they never read, and never
-- materializes an unbounded table on the server heap. Callers that do
-- want a flat array can trivially `table.insert` inside the loop.
--
-- `fetchPage` receives nil on the first call and the prior page's
-- `nextCursor` thereafter; iteration stops after the page whose
-- `nextCursor` is nil (JSON null decodes to nil). Any error raised by
-- `fetchPage` (JunjoError or otherwise) propagates out of the loop
-- unchanged.
--
-- Exposed as `Junjo.pageAll` for arbitrary list endpoints, and wired
-- into the namespace `listAll` / `banHistoryAll` conveniences.
--
-- Usage:
--   for member in Junjo.pageAll(function(cursor)
--       return junjo.members:list(groupId, { cursor = cursor })
--   end) do
--       print(member.userId)
--   end

local JunjoError = require(script.Parent.JunjoError)

local function pageAll(fetchPage: (cursor: string?) -> any): () -> any
	if type(fetchPage) ~= "function" then
		JunjoError.raise("pageAll(fetchPage) requires a function", "invalid_config", nil)
	end

	local items = nil
	local index = 0
	local cursor: string? = nil
	local exhausted = false

	return function()
		while true do
			if items ~= nil and index < #items then
				index += 1
				return items[index]
			end
			if exhausted then
				return nil
			end
			local page = fetchPage(cursor)
			if type(page) ~= "table" or type(page.items) ~= "table" then
				JunjoError.raise(
					"pageAll fetchPage must return a { items, nextCursor? } page",
					"internal",
					nil
				)
			end
			items = page.items
			index = 0
			-- Forward-progress guard: a page that hands back the same
			-- non-nil cursor it was fetched with would loop forever.
			-- The hosted Junjo API always advances the cursor, but a
			-- BYO-server base URL may not; fail loudly instead.
			if page.nextCursor ~= nil and page.nextCursor == cursor then
				JunjoError.raise(
					"pageAll fetchPage returned the same nextCursor twice in a row; "
						.. "refusing to loop forever",
					"internal",
					nil
				)
			end
			cursor = page.nextCursor
			if cursor == nil then
				exhausted = true
			end
		end
	end
end

return pageAll
