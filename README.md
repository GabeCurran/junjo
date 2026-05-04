# Junjo

A drop-in social-organization layer for multiplayer games. Guilds, clans, factions, parties, and the role/permission model around them. Plugs into your existing auth; never replaces it.

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

## Documentation

User and developer docs live at **`apps/docs`** (Nextra). Run `npm run dev` and open `http://localhost:3001`, or browse the source under `apps/docs/pages/`.

## Local development

```sh
git clone https://github.com/GabeCurran/junjo
cd junjo
npm install

# Boots Postgres (Docker), runs migrations, seeds a demo dataset,
# then runs server (:8787) + dashboard (:3000) + docs (:3001) in parallel:
npm run dev
```

Pre-flight: Docker Desktop must be running. The dev script auto-creates a Postgres container (`junjo-test-pg` on port 5433) and seeds it with demo data. See the printed game ID and API key in the bootstrap output.

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
