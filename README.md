# Junjo

Game-domain primitives for groups, ranks, and permissions. A drop-in social-organization layer for any multiplayer game (browser, Unity, Roblox, etc.) that handles guilds, clans, factions, parties, and the role/permission model around them. Plugs into your existing auth - does not replace it.

## Status

**2026-04-19** - project just initialized. No code yet. Currently scoping the monorepo + SDK API surface.

## Read first

The `docs/` directory captures every decision made during scoping so far. Read in order:

1. `docs/01-product.md` - what Junjo is, who it's for, the market gap
2. `docs/02-scope.md` - V1 feature list, out of scope, game inspirations
3. `docs/03-architecture.md` - tech stack, API-first pattern, SDK design, auth adapter
4. `docs/04-monetization.md` - open-core model, pricing tiers, cost math
5. `docs/05-decisions.md` - running log of decisions and rationale

## Next steps

- Scaffold monorepo (npm workspaces): `packages/server`, `packages/sdk`, `packages/react`, `packages/sdk-roblox`, `packages/shared`, `apps/dashboard`, `apps/docs`, plus shared TS configs
- Draft the SDK API surface (TypeScript types, public methods, error shapes)
- Draft the Postgres schema (Prisma)
- Decide on licensing (MIT vs BSL vs source-available)
- Register `junjo.io` domain + npm `@junjo` org + GitHub repo

## Owner

Gabe Curran. Side passion project. ~10-month time-to-launch (all-at-once release model). See [the parent job-search plan](C:\Users\Gabe\.claude\plans\i-really-want-to-drifting-chipmunk.md) for how this fits the broader career trajectory.
