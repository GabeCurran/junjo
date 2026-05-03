# @junjo/screenshots

Puppeteer-driven UI screenshot catalog for Junjo. Captures the dashboard
and docs sites at desktop + mobile viewports, full-page, and writes a
markdown INDEX file alongside the PNGs so the catalog is browsable in
the file tree.

This workspace is part of Phase 15 of the V1 roadmap. Phase 15.1
(this commit) ships the crawler infrastructure. Phase 15.2 adds the
dashboard route config; Phase 15.3 adds the docs route config.

## Layout

```
tools/screenshots/
  src/
    crawl.ts           CLI entry: parse args, load config, run runner
    runner.ts          Puppeteer driver (launch, viewport, screenshot, INDEX)
    config-loader.ts   Loads tools/screenshots/src/configs/<target>.ts
    dev-server.ts      Spawns next dev for the dashboard / docs targets
    args.ts            CLI argument parser
    route-filter.ts    --route=<slug> filtering
    index-md.ts        Renders the per-area INDEX.md table
    types.ts           CrawlConfig, RouteSpec, Viewport
    configs/           (Phase 15.2 / 15.3 land target configs here)
  output/              Generated PNGs and INDEX.md (gitignored)
  README.md
  package.json
  tsconfig.json
  .puppeteerrc.cjs     Skips chromium auto-download on npm install
```

## First-time setup

Puppeteer's chromium download is disabled (see `.puppeteerrc.cjs`) so a
fresh `npm install` does not pay a 280MB cost for a workspace most
contributors never run. Before the first `npm run screenshots`, install
chromium explicitly from this workspace:

```sh
cd tools/screenshots
npx puppeteer browsers install chrome
```

Or set `PUPPETEER_EXECUTABLE_PATH` to point at a chromium you already
have (Playwright ships its own copy under
`node_modules/playwright/.local-browsers/`).

## Usage

```sh
# Capture every route for the dashboard (Phase 15.2 config required)
npm run screenshots:dashboard

# Capture every route for the docs site (Phase 15.3 config required)
npm run screenshots:docs

# Equivalent long form
npm run screenshots -- --target=dashboard
npm run screenshots -- --target=docs

# Capture a single route only (used by the agent's visual feedback loop)
npm run screenshots -- --target=dashboard --route=group-detail-members

# Override the base URL (skip the bundled dev-server boot)
npm run screenshots -- --target=dashboard --base=http://localhost:13030

# Override the output directory
npm run screenshots -- --target=dashboard --out-dir=/tmp/screenshots
```

## Output

For each `--target`, the crawler writes:

```
tools/screenshots/output/<area>/
  <route-slug>.<viewport>.png   one per (route, viewport) pair
  INDEX.md                       sorted markdown table linking each PNG
```

PNGs are gitignored (large binaries, regeneratable). The committed
artifact for the catalog is the route config itself plus this README;
the PNGs live only in a contributor's local checkout.

## How configs work (for Phase 15.2 / 15.3)

A config is a TypeScript file at `src/configs/<target>.ts` exporting a
`CrawlConfig` as default. Sketch:

```ts
import type { CrawlConfig } from "../types.ts";

const config: CrawlConfig = {
  area: "dashboard",
  basicAuth: { username: "admin", password: "admin-screenshots" },
  viewports: [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 375, height: 812, isMobile: true },
  ],
  routes: [
    { slug: "home", path: "/", description: "Dashboard home" },
    {
      slug: "groups-list",
      path: "/games/g_demo/groups",
      description: "Groups table",
      waitFor: "table",
    },
  ],
  devServer: {
    command: "npm run dev -- --port 13030 --hostname 127.0.0.1",
    cwd: "../../apps/dashboard",
    port: 13030,
    readyPath: "/api/health",
  },
};

export default config;
```

The crawler:

1. Loads the config for `--target`.
2. If the config has `devServer` and no `--base` flag was passed, spawns
   the dev server and waits for `readyPath` to return < 500.
3. Launches headless chromium, captures each (route, viewport) pair as a
   full-page PNG, writes the INDEX.md alongside.
4. Tears down the dev server if it was spawned.

## Visual feedback loop (Phase 15.4)

Future iteration: the loop's agent (which has vision) will use the
`--route=<slug>` flag to capture a single page after a UI change, then
read the PNG back via the Read tool to validate look + layout. The
single-route filter keeps the cycle tight (one capture takes a few
seconds, vs. the full ~30-screenshot crawl).

## Why Puppeteer and not Playwright

Playwright is already wired in for the dashboard E2E suite (Phase 14.12)
and that's the right tool for behavioral end-to-end tests. Screenshot
capture for a static catalog is a different mental model (visual
snapshot, not a behavioral assertion), and Puppeteer is the lighter
weight choice for that one job. See `docs/05-decisions.md` for the
full rationale.
