# Minecraft integration plan

Status: approved Nov 5, 2026. First consumer: Kappable (Paper/Velocity plugin platform), first server: Merchant Villages (MV). Source requirements live in the Kappable repo (`kappable-mc/docs/JUNJO-REQUIREMENTS.md`, `JUNJO-HANDOFF.md`).

Guiding rule: every feature added here is a generic Junjo feature that any game can use. Minecraft-specific glue (Bukkit permission attachment, importing PermissionsEx data, world handling) stays in Kappable.

## Model mapping

| Minecraft concept | Junjo |
|---|---|
| Network (MV) | one Game |
| Game server, store, website, Discord bot | one API key each |
| Server ranks | Roles inside one network Group |
| Player's ranks (several at once) | MemberRole rows |
| Personal permissions | MemberPermissionOverride rows |
| Weight | Role `priority` |
| Prefix, suffix, ladder position | Role `metadata` (new) / Member `metadata` |
| Party, duel/match team, clan | Groups with `kind` = `party`, `match`, `clan` |
| Java UUID, Bedrock UUID, website, Discord | ExternalIdentity rows on one JunjoUser |

## Decisions

1. Permission semantics are extended inside Junjo (not stored as opaque data), so Junjo's own checks, the dashboard and every SDK give the same answer as Kappable's local resolver.
2. Precedence, applied in this order:
   1. Layer: the member's own overrides, then directly held roles, then their parents, then grandparents. A role reachable through several paths sits at its shortest distance. The first layer with any matching entry decides.
   2. Within that layer, the most specific match wins: exact key, then the longest `a.b.*`, down to `*`.
   3. Same layer and same specificity: deny wins.
3. World and server contexts are deferred. The wire shape leaves room for a `context` field as an additive change.
4. Identity linking v1 refuses a link when both sides hold a role above the default role, when either side is banned, or when the side being attached holds anything beyond its default-role membership.
5. Read paths return the id in the caller's preferred namespace (see Phase 2).
6. Game-wide ban events must reach game servers over a live stream no later than the Java SDK release.
7. Scoped (least-privilege) API keys are deferred.

## Phase 1: permission model

1. **Game config `permissions.mode`**: `"exact"` (default, current behavior) or `"nodes"`.
   - `nodes` mode: a trailing `.*` and a bare `*` match as wildcards; keys are lowercased on write and on check; `*` anywhere else and whitespace are rejected; role names are unique case-insensitively.
   - Switching a game to `nodes` is refused if any stored key would change meaning (contains `*`, or collides after lowercasing).
   - One mode flag instead of separate toggles keeps the conformance matrix at two modes.
2. **Role-level deny**: role entries carry a value (grant or deny). Available in both modes.
3. **Role inheritance**: a role may have several parent roles in the same group. Cycle-checked on write, depth bounded by the same limit as group parents (100). Available in both modes. Changing a parent invalidates cached answers for the group.
4. **One resolver** implementing the precedence above for both modes; the mode only changes key matching. Group-level `inherit` keeps working: each group level is resolved with the layered rules, nearest group first. Existing games have no denies or parents, so their answers do not change.
5. **Wire shape**: entries are objects, `{ permission, value }`, so `context` can be added later without a breaking change. An entry without context applies everywhere.
6. **Role `metadata`**: free JSON object, matching Group and Member metadata.
7. **Bulk endpoints**:
   - replace a role's full entry list atomically (one audit entry carrying the diff)
   - set a role's parents
   - read a group's full role graph (roles, entries, parents, metadata) in one call
   - read one member's roles and overrides in one call
8. **Caps** (documented in `limits.mdx`): entries per role 5,000; parents per role 32; inheritance depth 100. MV needs about 1,600 entries in total, 40 roles, 12 roles per member and 9 levels.
9. **Conformance vectors**: a shared JSON file in `packages/shared` that the server tests and the Java SDK tests both run. Seed cases:
   - Admin: `*` minus 11 negations; each negated node is denied, everything else allowed
   - Admin inherits a default role that denies `bukkit.command.plugins`; Admin is still allowed (layer beats specificity)
   - Guest is denied `bukkit.command.plugins`
   - A member override `-chatfeelings.*` beats a role granting `chatfeelings.*`
   - A member override `-chatfeelings.*` beats a role granting the exact node `chatfeelings.hug` (layer beats specificity)
   - Donor bundle roles with up to 6 parents
   - A role reachable through two inheritance paths
   - Two directly held roles disagreeing at the same specificity: deny wins
   - A member holding the default role alongside a higher rank (documents why promotions replace the default role)
   - Case folding: `ChestShop.shop.*` grants `chestshop.shop.create` in `nodes` mode only
   - Inheritance cycle rejected on write
10. **Docs, shared TypeScript types, dashboard**: the dashboard must display denies and parents correctly (plainly is fine; it must never misreport access). The C++, Unreal and Roblox SDKs follow later; every change is additive on the wire.

## Phase 2: identity

1. **Namespaces**: an id's namespace is the part before its first `:` (`mc:<uuid>`, `web:<id>`, `discord:<id>`). The namespace is only consulted when the caller has a preference or the game declares a format for it, so existing ids that happen to contain `:` behave exactly as today.
2. **Canonical id formats**: game config can declare a format per namespace, from a small closed set (first: `uuid`, lowercase and hyphenated). Ids in a declared namespace that do not match are rejected with `400` on every path that accepts a user id, reads included, so `mc:ABC...` and `mc:abc...` can never become two users. Opt-in per game, independent of permission mode. Kappable declares `mc: uuid`.
3. **Preferred namespaces**: a new optional ordered list on ApiKey (set at mint time) and on WebhookEndpoint, for example `["discord", "mc"]`. Read paths, SSE events and webhook payloads that name a user return:
   1. the oldest identity in the first listed namespace the person has an id in
   2. otherwise the oldest identity overall, which may be in any namespace (documented; callers must handle ids outside their namespaces)

   Any cache that stores rendered user ids must key on the preference list too.
4. **Fix the read paths** that map JunjoUser to external id (for example `routes/admin.ts`, `routes/friends.ts`) so the choice is deterministic, and add an endpoint that lists a person's linked ids.
5. **Link codes**: a game server requests a code for `mc:<uuid>`; the website backend redeems it for `web:<id>`. Single use, 5 minute expiry, rate limited per identity, stored hashed.
6. **Refusals** as in decision 4. Staff tooling handles the refused cases.
7. **Unlink**: the removed id becomes a fresh, empty JunjoUser; roles stay with the remaining identities. Refused while the person is banned.
8. **Audit**: new actions `identity.linked` and `identity.unlinked`. API keys get a display name, and audit entries record which key acted.

## Phase 3: game-wide live stream

Game-scoped events (`game.user.banned`, `game.user.unbanned`, `identity.linked`, and the other user-scoped events) are webhook-only today. Add a game-level SSE stream with the same ordering and resync guarantees as group streams, so every server on a network sees a ban immediately. Must ship with or before Phase 4.

## Phase 4: Java SDK (`packages/sdk-java`)

Separate plan once Phases 1 to 3 fix the wire shapes. Settled: Java 21, Maven Central, own Gradle build, JDK `java.net.http` plus Gson, no Minecraft imports, local resolver that passes the conformance vectors (lowercasing with `Locale.ROOT`), local cache, offline write queue, SSE reconnect with resync, retries and timeouts.

## Later

- Live-event ordering and resync review for cross-server signals (handoff question 4)
- Hosting: Railway vs self-hosting per network (question 5)
- Dev setup without Docker Desktop (question 6), after Gabe's Docker CLI/WSL migration. Junjo moves off 5433 to its own fixed range, 25600-25699 (Kappable owns 25700-25799). Until then, tests run against a Postgres container started with the Docker CLI on 25601, and the dev scripts stay untouched.
- World and server contexts on permission entries
- Scoped API keys
