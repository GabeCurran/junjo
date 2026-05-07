# Junjo

[![CI](https://github.com/GabeCurran/junjo/actions/workflows/ci.yml/badge.svg)](https://github.com/GabeCurran/junjo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![npm @junjo/sdk](https://img.shields.io/npm/v/@junjo/sdk?label=%40junjo%2Fsdk)](https://www.npmjs.com/package/@junjo/sdk)
[![npm @junjo/react](https://img.shields.io/npm/v/@junjo/react?label=%40junjo%2Freact)](https://www.npmjs.com/package/@junjo/react)

A drop-in social-organization layer for multiplayer games. Guilds, clans, factions, parties, and the role/permission model around them. Plugs into your existing auth; never replaces it.

![Junjo dashboard](docs/screenshots/dashboard-home.png)

```ts
const junjo = new Junjo({ apiKey: process.env.JUNJO_API_KEY });
const guild = await junjo.groups.create({ kind: "guild", name: "Crimson Dawn" });
await junjo.groups.inviteByUserId(guild.id, "user_123");
```

## What's in the box

- **`@junjo/sdk`**: typed TypeScript client for any Node or browser app.
- **`@junjo/react`**: React hooks (`useGroup`, `useMembers`, `useCan`, ...) with optimistic updates.
- **`junjo-roblox`**: Luau client for Roblox experiences.
- **Cross-game admin dashboard**: Next.js app for inspecting and managing groups across games.
- **Server**: Hono on Node, Postgres via Prisma. Self-hostable (MIT) or use the cloud.
- **Auth adapters**: Clerk, Supabase, JWT, BYO.

## A few screens from the admin dashboard

| Group members | Per-game analytics |
| --- | --- |
| ![Group members](docs/screenshots/dashboard-group-members.png) | ![Analytics](docs/screenshots/dashboard-analytics.png) |

## Documentation

User and developer docs live at **`apps/docs`** (Nextra). Run `npm run dev` and open `http://localhost:3001`, or browse the source under `apps/docs/pages/`.

## Local development

```sh
git clone https://github.com/GabeCurran/junjo
cd junjo
npm install

# Boots Postgres (Docker), runs migrations, seeds a demo dataset, and
# starts the server, dashboard, and docs site in parallel.
npm run dev
```

Pre-flight: Docker Desktop must be running. On first run, the dev script:

- Creates a Postgres container (`junjo-test-pg` on port 5433). Override the port with `JUNJO_DB_PORT=5499 npm run dev` if 5433 is already taken on your host. The `DATABASE_URL` and `TEST_DATABASE_URL` lines in `.env` are reconciled against the current `JUNJO_DB_PORT` on every dev run, so manual edits to those two lines will be overwritten.
- Auto-generates `.env` (root) and `apps/dashboard/.env.local` with sane dev defaults if either is missing, including a freshly minted admin token and the demo game's API key.
- Seeds a representative demo dataset that exercises every dashboard surface.

Once the dev servers are up:

- **Dashboard**: http://localhost:3000 (basic-auth user `admin`, password `admin`)
- **Docs site**: http://localhost:3001
- **API**: http://localhost:8787

Integrating against the API from another local project (port 3000 already in use, dashboard not needed)? Use `npm run dev:server-only` to skip the dashboard and docs and boot just Postgres + the API server.

The seed prints the game ID and API key to the terminal; the same values are written into the env files automatically.

## Repository layout

```
packages/
  server/       Hono HTTP API + Prisma schema + webhook worker
  sdk/          @junjo/sdk, typed TypeScript client
  react/        @junjo/react, React hooks
  sdk-roblox/   junjo-roblox, Luau client
  shared/       @junjo/shared, shared types
apps/
  dashboard/    Next.js admin dashboard (proprietary)
  docs/         Nextra documentation site
tools/
  screenshots/  Puppeteer screenshot crawler for visual QA
  diagrams/     Mermaid renderer
```

## License

MIT for the OSS packages (`packages/*`). The dashboard at `apps/dashboard` is proprietary (see `apps/dashboard/LICENSE`).
