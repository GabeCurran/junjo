-- Placeholder. The real Luau client lands once the HTTP API stabilizes
-- and we can codegen or hand-write the corresponding Junjo:groups, :roles,
-- :members, :can methods around HttpService.

local Junjo = {}
Junjo.__index = Junjo

function Junjo.new(_config)
	error("not implemented")
end

return Junjo
