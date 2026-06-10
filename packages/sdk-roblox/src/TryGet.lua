--!nonstrict
-- Nonstrict, not strict: the `require(script.Parent.X)` type needs the
-- Roblox definition files to pass strict analysis, which CI cannot run
-- yet. The signature carries annotations regardless.
--
-- Shared "404 -> nil" lookup helper used by the groups / members /
-- roles / invitations namespaces. Catches a "not_found" JunjoError
-- raised by `http:get(path)` and translates it to nil (matches the
-- TypeScript SDK's `Promise<X | null>` shape for single-row lookups).
-- Every other error re-throws verbatim.

local JunjoError = require(script.Parent.JunjoError)

local function tryGet(http: any, path: string): any
	local ok, result = pcall(function()
		return http:get(path)
	end)
	if ok then
		return result
	end
	if JunjoError.is(result) and result.code == "not_found" then
		return nil
	end
	error(result, 0)
end

return tryGet
