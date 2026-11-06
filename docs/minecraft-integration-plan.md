# Minecraft integration plan

Status: approved Nov 5, 2026. Phases 1 to 5 built by Nov 6, 2026 and committed on `feat/game-stream`; see [Status and follow-ups](#status-and-follow-ups). First consumer: KappaMC (Paper/Velocity plugin platform), first server: Merchant Villages (MV). Source requirements live in the KappaMC repo (`kappa-mc/docs/JUNJO-REQUIREMENTS.md`, `JUNJO-HANDOFF.md`).

Guiding rule: every feature added here is a generic Junjo feature that any game can use. Minecraft-specific glue (Bukkit permission attachment, importing PermissionsEx data, world handling) stays in KappaMC.

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

1. Permission semantics are extended inside Junjo (not stored as opaque data), so Junjo's own checks, the dashboard and every SDK give the same answer as KappaMC's local resolver.
2. Precedence, applied in this order:
   1. Layer: the member's own overrides, then directly held roles, then their parents, then grandparents. A role reachable through several paths sits at its shortest distance. The first layer with any matching entry decides.
   2. Within that layer, the most specific match wins: exact key, then the longest `a.b.*`, down to `*`.
   3. Same layer and same specificity: deny wins.
3. World and server contexts are deferred. The wire shape leaves room for a `context` field as an additive change.
4. Identity linking v1 refuses a link when both sides hold a role above the default role, when either side is banned, or when the side being attached holds anything beyond its default-role membership.
5. Read paths return the id in the caller's preferred namespace (see Phase 2).
6. Game ban events must reach game servers over a live stream no later than the Java SDK release.
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
2. **Canonical id formats**: game config can declare a format per namespace, from a small closed set (first: `uuid`, lowercase and hyphenated). Ids in a declared namespace that do not match are rejected with `400` on every path that accepts a user id, reads included, so `mc:ABC...` and `mc:abc...` can never become two users. Opt-in per game, independent of permission mode. KappaMC declares `mc: uuid`.
3. **Preferred namespaces**: a new optional ordered list on ApiKey (set at mint time) and on WebhookEndpoint, for example `["discord", "mc"]`. Read paths, SSE events and webhook payloads that name a user return:
   1. the oldest identity in the first listed namespace the person has an id in
   2. otherwise the oldest identity overall, which may be in any namespace (documented; callers must handle ids outside their namespaces)

   Any cache that stores rendered user ids must key on the preference list too.
4. **Fix the read paths** that map JunjoUser to external id (for example `routes/admin.ts`, `routes/friends.ts`) so the choice is deterministic, and add an endpoint that lists a person's linked ids.
5. **Link codes**: a game server requests a code for `mc:<uuid>`; the website backend redeems it for `web:<id>`. Single use, 5 minute expiry, rate limited per identity, stored hashed.
6. **Refusals** as in decision 4. Staff tooling handles the refused cases.
7. **Unlink**: the removed id becomes a fresh, empty JunjoUser; roles stay with the remaining identities. Refused while the person is banned.
8. **Audit**: new actions `identity.linked` and `identity.unlinked`. API keys get a display name, and audit entries record which key acted.

## Phase 3: game stream

Game-scoped events (`game.user.banned`, `game.user.unbanned`, `identity.linked`, and the other user-scoped events) are webhook-only today. Add a game stream (SSE) so every server on a network sees a ban immediately. Must ship with or before Phase 4. Settled Nov 5, 2026 (with KappaMC's `JUNJO-MV-NEEDS.md` items 4 and 5 folded in):

1. **`GET /v1/events`** carries every event of the game (group events included). Optional `?types=a,b` uses the same type list as webhook endpoints; an unknown type is `400`. Per game only: games sharing a `networkId` do not see each other's events. Any per-game API key may open it.
2. **Durable event log.** Every event is written to an `EventLog` table in the transaction that caused it, numbered from a per-game counter. Positions are gapless and follow commit order within a game. Retention is 24 hours by default (`EVENT_LOG_RETENTION_HOURS`).
3. **Positions and resume.** The game stream sends the position on the SSE `id:` line (the event's own random `id` is unchanged). A client resumes with `Last-Event-ID`; a position the log can no longer serve answers `410 stream_position_expired`, meaning "load a fresh snapshot". Heartbeats carry the stream's position.
4. **Snapshot position.** `GET /v1/events/position` and a `Junjo-Stream-Position` header on the reads an SDK cache loads from. The position is read before the data, so a snapshot holds every event up to it and possibly a few after; applying an event twice must be harmless.
5. **Several server instances.** Each instance reads new log rows for games with open streams on a local write and on a short poll (`EVENT_STREAM_POLL_MS`, default 1 s), so streams see writes from every instance.
6. **Limits.** 10 open game streams per key and 200 per game per instance (`429 too_many_streams`); a client that stops reading is closed after 30 s and resumes from its position.
7. **New event `member.updated`** (`changed`: `metadata`, `notes`, `overrides`), on group streams, the game stream and webhooks.
8. **SDKs.** TS `junjo.events.subscribe` reconnects with backoff and resumes from its position; React gets a hook for game events. Group streams keep their behaviour.

## Phase 3b: safe writes and import (before Phase 4)

From KappaMC's `JUNJO-MV-NEEDS.md` items 1, 3, 6, 7 and 8; the Java SDK's offline write queue depends on these.

1. `Idempotency-Key` on writes: a retry with the same key returns the original result.
2. A version per member and conditional writes (`If-Match`, refused with `412` on a mismatch), so a queued write replayed after a newer change is refused.
3. Bulk membership import (direct add with roles, overrides and metadata in one atomic call).
4. An optional past `bannedAt` on game bans, so imported bans keep their original dates.
5. Nodes mode rejects empty key segments (`a..b`, `a.`, `.a`), and switching to nodes mode is refused if stored keys have them.

## Phase 4: Java SDK (`packages/sdk-java`)

Separate plan once Phases 1 to 3b fix the wire shapes. Settled: Java 21, Maven Central, own Gradle build, JDK `java.net.http` plus Gson, no Minecraft imports, local resolver that passes the conformance vectors (lowercasing with `Locale.ROOT`), local cache, offline write queue, SSE reconnect with resync, retries and timeouts.

## Phase 5: running well on a network

KappaMC's tier 2 items, after the Java SDK:

- Mutes with reason, issuer and expiry, built as typed sanctions
- Parties: size caps per group kind, cleanup of empty and abandoned groups, limits on rapid create and delete
- A last-known display name per linked id
- A full game export (roles, members, bans, identities, audit)

## Status and follow-ups

| Phase | State |
|---|---|
| 1 Permission model | Committed on `feat/game-stream`. |
| 2 Identity | Committed on `feat/game-stream`. |
| 3 Game stream | Committed on `feat/game-stream`: server, TypeScript SDK (`junjo.events`), React (`useGameEvents`), docs. |
| 3b Safe writes and import | Committed on `feat/game-stream`: server, TypeScript SDK, React, Java, docs. Ban and sanction lifts with nothing active answer `404 not_found` with `details.reason: "not_active"`. |
| 4 Java SDK | Committed on `feat/game-stream` in `packages/sdk-java` (Gradle wrapper, Java 21 target, Gson only). Unit and conformance tests plus live tests against a real server. Not published. |
| 5 Network features | Committed on `feat/game-stream`: sanctions, group kind limits, display names, game export; server, TypeScript SDK (`junjo.export()`), React (`useSanctions`), Java, docs. |

Accepted gaps, documented:

- Group streams stay single-instance and have no resume; the game stream covers both.
- C++, Unreal and Roblox SDKs do not know the event types added since Phase 2 (`identity.*`, `member.updated`, sanctions); they skip unknown types safely.

Follow-ups:

- Publish the Java SDK to Maven Central (needs Gabe's signing key and Central account).
- Dashboard screens for sanctions and group kind limits (the API and SDKs have them; the dashboard has only the `canExport` toggle).

## Later

- Postgres `LISTEN`/`NOTIFY` as the cross-instance wake-up for game streams, replacing the poll delay
- Hosting: Railway vs self-hosting per network
- Dev setup without Docker Desktop, after Gabe's Docker CLI/WSL migration. Junjo moves off 5433 to its own fixed range, 25600-25699 (KappaMC owns 25700-25799). Until then, tests run against a Postgres container started with the Docker CLI on 25601, and the dev scripts stay untouched.
- World and server contexts on permission entries
- Scoped API keys
