# 01 - Product

## One-liner

Junjo provides game-domain primitives for groups, ranks, and permissions. A drop-in layer for any multiplayer game that handles guilds, clans, factions, parties, alliances, and the role/permission model around them.

## Who it's for

Indie and mid-sized multiplayer game developers shipping games where players form persistent social groups:

- Browser-based MMOs and MOBAs (Three.js, Phaser, custom)
- Unity multiplayer games (co-op, persistent worlds)
- Roblox games with clan/faction systems
- Persistent indie titles where players want guild structure (faction wars, raid organizations, parties)

These devs *always* hit the same wall around month 3-6 of development: "how do I model guilds and ranks and permissions without it taking three weeks of my life?" Junjo answers that.

## The market gap

The competitive landscape:

| Tool | What it does | What it doesn't |
|------|--------------|-----------------|
| Colyseus | Real-time state sync, room management | No persistent group/rank concept |
| Nakama (Heroic Labs) | Full game backend, auth, friends, groups | Heavy; groups are flat, not rank/permission-aware |
| PlayFab (Microsoft) | Backend-as-a-service for AAA | Heavyweight, expensive, AAA-leaning |
| Photon | Real-time multiplayer, pay-per-CCU | No persistent social model |
| Pragma | Full game backend, B2B AAA | Enterprise-only, not for indies |
| Roblox `DataStoreService` | Native key-value storage | No real-time, no cross-server queries, no admin UI |

**The wedge:** none of these address game-design-level concepts like guilds, parties, hierarchical ranks, role-based permissions, group-to-group relationships, and audit logs as first-class primitives. Every dev re-implements them from scratch. Junjo provides exactly that layer - and nothing else.

## The honest "why us"

- The PokeDnD architecture (SSE hubs, Postgres, Prisma, Ory experience) maps almost 1:1 to what Junjo's backend needs.
- Gabe has felt the friction of bad auth/identity systems (Ory), so the design philosophy "BYO auth, we just compose" comes from real pain.
- The Roblox SDK can be dogfooded with the existing `mobarena-roblox` project, which means a real first user from day one.
- Gaming is a passion area; this is a Tier-1 portfolio piece for game-tools roles (Riot, Epic, Unity, Roblox, etc.) regardless of revenue.

## The bigger picture

Junjo lives at the intersection of two trends:

1. **The collapse of "build it yourself" backends for indie game devs.** Devs increasingly stitch together best-of-breed primitives (Colyseus for state sync, Stream for chat, Auth0/Clerk for identity) instead of writing everything. Junjo fills the obvious empty slot in that stack.
2. **The persistent-multiplayer renaissance** in browser games (.io games matured into long-lived titles with social structure) and Roblox (whose top games all have clan/squad systems).

Realistic timing: the audience is real today and growing. The hard part is reaching them, not the technology.
