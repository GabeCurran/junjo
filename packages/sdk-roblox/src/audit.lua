-- Audit namespace. Mirrors the TypeScript SDK's `junjo.audit` surface
-- (a single `list(groupId, opts?)` method). Pagination is timestamp-
-- based: the response carries a `nextCursor` ISO 8601 string; pass it
-- back as `opts.before` on the next call.

local Audit = {}
Audit.__index = Audit

function Audit.new(http)
	local self = setmetatable({}, Audit)
	self._http = http
	return self
end

function Audit:list(groupId, opts)
	local query = {}
	if opts and opts.limit ~= nil then
		table.insert(query, "limit=" .. self._http:encode(opts.limit))
	end
	if opts and opts.before ~= nil then
		-- `before` is forwarded verbatim (must be an ISO 8601 string).
		-- Lua does not have a Date type; the response's `nextCursor`
		-- (also ISO) is the cursor consumers feed back here.
		table.insert(query, "before=" .. self._http:encode(opts.before))
	end
	if opts and opts.actions ~= nil then
		for _, action in ipairs(opts.actions) do
			table.insert(query, "actions=" .. self._http:encode(action))
		end
	end
	local path = "/v1/groups/" .. self._http:encode(groupId) .. "/audit"
	if #query > 0 then
		path = path .. "?" .. table.concat(query, "&")
	end
	return self._http:get(path)
end

return Audit
