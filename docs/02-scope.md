# 02 — Scope

## V1 (everything below ships before public launch)

Gabe explicitly chose **all-at-once** release model over phased shipping. Estimated timeline: ~32-40 weekends (~8-10 months at 1 weekend/week). The product launches when all of this works end-to-end.

### Core entities

- **Group** — generic noun in the API. Devs set a `kind` string ("guild" / "clan" / "faction" / "party" / "crew" / etc.) for their UI display + analytics filtering. The SDK API never says the word "guild" anywhere.
- **Member** — a user's relationship to a group. One user can be in many groups. Per-membership custom JSON metadata. Member notes (private "officer notes" + public "member notes").
- **Role** — defined per group by the dev. Multi-role per member. Role hierarchy via a priority integer (higher = more authority). Default role on join. Optional role color for UI.
- **Permission** — dev-defined keys per game ("invite_member", "edit_treasury", "claim_territory", etc.). Permissions assigned to roles. Member-level overrides supported (grant/revoke for a specific member regardless of their roles).

### Group features

- Create / delete with metadata + `kind`
- Visibility: public, invite-only, secret
- Custom JSON metadata blob
- Soft delete with 7-day undo window

### Membership features

- Invite by code, by link, by direct user-id push
- Accept / decline / kick
- Per-member custom JSON
- Public + private member notes
- Audit log entry for every membership change

### Permission API

- Single core call: `can(userId, groupId, "permissionKey") → boolean`
- Member-level overrides take precedence over role-derived permissions
- Cached server-side for performance

### Group relationships (Minecraft-faction inspired)

- Define a relationship between two groups: `ally`, `enemy`, `neutral`, or any custom string
- Query: `getRelationship(groupAId, groupBId) → { type, since, set_by }`
- Useful for: faction wars, alliance systems, PvP friend/foe checks

### Real-time

- SSE subscription per group + per game
- Events: `member.joined`, `member.left`, `role.changed`, `permission.granted`, `permission.revoked`, `group.updated`, `group.relationship.changed`, plus an admin event channel
- Webhooks dispatched on the same events with retries + HMAC signing

### Auth

- Pluggable auth adapter pattern: `verifyToken(token) → { userId } | null`
- Built-in adapters for Clerk, Supabase Auth, raw JWT
- BYO custom adapter via callback

### Audit log

- Append-only log per group of every state change with actor + timestamp
- Queryable via API
- Visible in admin dashboard

### Admin dashboard (cloud only)

- See all groups in your game
- Inspect any group + members + roles
- Manual permission overrides for support cases
- Audit log viewer
- Multi-game support — one dashboard, many games

### Analytics dashboard (cloud only)

- Group churn (join → leave time)
- Group growth over time
- Member activity heatmap
- Role distribution
- Most-used permission keys

### Cross-game shared identity (network effect)

- One Junjo account = one player. The same player can carry their identity across multiple games that use Junjo.
- Each game keeps its own group memberships; identity is just the user-id resolution layer.
- This is the network effect: every new game on Junjo makes Junjo more valuable to the next dev.

### Bulk-invite via CSV

Upload a CSV of user-ids or emails to bulk-invite to a group. Useful for migrating from existing systems.

### Sub-groups / alliances

A group can declare itself a child of another group. Useful for:
- WoW-style guild alliances
- Multi-tiered factions (faction → sub-faction → squad)
- Tournament structures

### Discord/Slack integration

Devs can wire group events to Discord/Slack webhooks for community visibility:
- "Player Foo joined the Crimson Wolves"
- "Officer Bar promoted Member Baz to Veteran"

## Out of scope (don't build)

These get punted to other tools or BYO:

- **In-app chat.** Use Sendbird, Stream, Discord, or homegrown sockets. Chat is a whole separate product.
- **Friends list.** Different concept; not the same data model. Could be V3 if huge demand from real users.
- **Game state sync.** Use Colyseus / Nakama / your own backend. Junjo is *not* a real-time game engine.
- **Authentication itself.** BYO. The whole point is composing with the dev's existing identity provider.
- **Matchmaking.** Different product entirely.
- **Leaderboards / achievements.** Could be V3 if real users ask. Don't build speculatively.
- **Game-specific systems** — territory blocks, citadel buildings, faction power, guild XP. These belong in the dev's code; Junjo provides the structural primitives only.

## Inspirations

What we're learning from existing games:

| Game | Contribution |
|------|--------------|
| **WoW** | Multi-tier hierarchical ranks, per-rank permissions, public + officer notes per member |
| **RuneScape** | Tiered ranks with promotion criteria (game-specific so just expose member metadata for it) |
| **Minecraft Factions** | Group-to-group relationships (ally/enemy/neutral), claimable resources tied to permissions |
| **TERA** | Multi-role per member, role colors / display names |
| **CoD / Halo** | Clan tag (just a short string in group metadata), flat membership |

Junjo provides the primitives; game-specific systems (territory blocks, citadel buildings, faction power) stay in the dev's code.

## V2+ (after V1 ships and gets traction)

**Note:** Gabe explicitly pulled all V2 ideas into V1 above. This V2 list is for *new* ideas that emerge after V1 ships and real users tell us what's missing.

Likely candidates:
- Unity / C# SDK (Asset Store package)
- Godot / GDScript SDK
- Friends list (if asked)
- Leaderboards (if asked)
- More auth adapters (Auth0, Firebase, Cognito)
- Self-serve cloud signup flow + Stripe billing
