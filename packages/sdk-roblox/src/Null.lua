--!strict
-- Sentinel for explicit JSON null inside request bodies. Lua's `nil`
-- means "key absent" in tables, so a caller that needs to send
-- `{ "defaultRoleId": null }` writes `{ defaultRoleId = Junjo.Null }`
-- and the body encoder substitutes a real JSON `null` at serialize time.
--
-- `require` caches modules, so every file in the SDK that requires this
-- module gets the same userdata reference. Reference-equality (`v == Null`)
-- is the discriminator the body encoder uses.

return newproxy(false)
