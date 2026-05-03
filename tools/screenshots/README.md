# @junjo/screenshots

Puppeteer-driven UI screenshot catalog for Junjo. Captures the dashboard
and docs sites at desktop + mobile viewports, full-page, and writes a
markdown INDEX file alongside the PNGs so the catalog is browsable in
the file tree.

This workspace is part of Phase 15 of the V1 roadmap. Phase 15.1
shipped the crawler infrastructure. Phase 15.2 added the dashboard
route config + fixture seeder. Phase 15.3 adds the docs route config
(an FS walk of `apps/docs/pages/**/*.mdx`).

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
    types.ts                  CrawlConfig, RouteSpec, Viewport
    resolve-routes.ts         Picks between static `routes` and `prepare()`
    seed-fixtures.ts          HTTP-based idempotent fixture seeder (dashboard)
    discover-docs-routes.ts   FS walk over apps/docs/pages/**/*.mdx
    configs/
      dashboard.ts     Phase 15.2 (dev server + seed + route list)
      docs.ts          Phase 15.3 (dev server + dynamic FS-walk routes)
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

# Capture a single viewport only (mobile-only audit cycle, see "Mobile viewport audit" below)
npm run screenshots -- --target=dashboard --viewport=mobile

# Combine route + viewport for the tightest cycle
npm run screenshots -- --target=docs --route=sdk-groups --viewport=mobile

# Override the base URL (skip the bundled dev-server boot)
npm run screenshots -- --target=dashboard --base=http://localhost:13030

# Override the output directory
npm run screenshots -- --target=dashboard --out-dir=/tmp/screenshots
```

The `--route` and `--viewport` flags both rewrite `INDEX.md` to cover only
the current crawl. This is fine for ad-hoc audit and feedback cycles; rerun
without filters to restore the full catalog index.

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

## How configs work

A config is a TypeScript file at `src/configs/<target>.ts` exporting a
`CrawlConfig` as default. Two flavors:

**Static routes** (the docs config, Phase 15.3):

The docs config has no live-server dependencies. Its routes come from
walking `apps/docs/pages/**/*.mdx` at config-load time via
`discoverDocsRoutes()`; adding a new MDX page automatically extends
the catalog with no code change in this workspace. Underscore-prefixed
files / directories (`_meta.ts`, `_app.tsx`, `_drafts/`, ...) are
skipped per Nextra convention; `index.mdx` files map to the section
root path (`pages/sdk/index.mdx` -> `/sdk`); routes are sorted by path
for deterministic ordering.

```ts
import { discoverDocsRoutes } from "../discover-docs-routes.ts";
import type { CrawlConfig } from "../types.ts";

const config: CrawlConfig = {
  area: "docs",
  viewports: [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 375, height: 812, deviceScaleFactor: 2, isMobile: true },
  ],
  routes: discoverDocsRoutes(absolutePathToAppsDocsPages),
  devServer: {
    command: "npm run dev -w @junjo/docs -- --port 13131 --hostname 127.0.0.1",
    cwd: repoRoot,
    port: 13131,
    readyPath: "/",
  },
};

export default config;
```

**Dynamic routes via `prepare()`** (the dashboard config, Phase 15.2):

The dashboard's URLs include freshly-resolved IDs (`/games/<gameId>`,
`/games/<gameId>/groups/<groupId>?tab=...`) so the routes cannot be
written as static literals. Instead, the config's `prepare()` hook
calls the fixture seeder, which idempotently populates a "Screenshot
Demo" game on the live Junjo server and returns the resolved IDs;
those IDs feed `buildDashboardRoutes()` which returns the route list
the crawler iterates over.

The crawler:

1. Loads the config for `--target`.
2. If the config has `devServer` and no `--base` flag was passed,
   spawns the dev server and waits for `readyPath` to return < 500.
3. If the config has `prepare()`, calls it; otherwise uses
   `config.routes`.
4. Launches headless chromium, captures each (route, viewport) pair
   as a full-page PNG, writes the INDEX.md alongside.
5. Tears down the dev server if it was spawned.

## Dashboard catalog (Phase 15.2)

The dashboard target needs a live Junjo server reachable at
`JUNJO_BASE_URL` plus a server-side admin token (`JUNJO_ADMIN_TOKEN`)
so the seeder can create the "Screenshot Demo" game and ephemerally
issue an API key for it. The dashboard's own basic-auth credentials
match the dashboard env var convention. The full env-var matrix for
`npm run screenshots:dashboard`:

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `JUNJO_BASE_URL` | no | `http://127.0.0.1:8787` | Junjo server origin (seeder + dashboard talk to this) |
| `JUNJO_ADMIN_TOKEN` | yes | - | Admin token; seeder bounces off the cross-game admin endpoints with it |
| `JUNJO_ADMIN_API_KEY` | for the dashboard | empty string | Per-game key the dashboard reads at boot for env validation; any valid key works (the seeder issues its own ephemeral key for writes) |
| `DASHBOARD_ADMIN_USER` | no | `admin` | Basic-auth user the crawler authenticates as |
| `DASHBOARD_ADMIN_PASSWORD` | no | `admin-screenshots` | Basic-auth password (must match what the dashboard expects) |
| `SCREENSHOTS_DASHBOARD_PORT` | no | `13130` | Port `next dev` is bound to during the crawl |

Bring up the Junjo server (`npm run dev -w @junjo/server`) with the
admin token configured, then:

```sh
npm run screenshots:dashboard
```

The seeder's idempotency rules: a "Screenshot Demo" game is reused if
already present; the three demo groups (`Wolves of Ironvale`, `Storm
Riders`, `Ironvale Alliance`) are created only if missing; each demo
member is invited + accepted only if not already in the group; the
parent / rival relationships are set only if not already present.
Re-running the seeder is cheap and safe.

## Docs catalog (Phase 15.3)

The docs target needs no auth and no backing server beyond `next dev`
booting against `apps/docs/`. Run:

```sh
npm run screenshots:docs
```

The crawler boots `next dev -w @junjo/docs` on
`SCREENSHOTS_DOCS_PORT` (default `13131`), then walks every
`.mdx` page under `apps/docs/pages/` and captures each at desktop +
mobile. The route count tracks the docs surface: at the time Phase
15.3 landed there were 38 MDX pages, so the crawl produces ~76 PNGs.
First-page capture pays the `next dev` JIT compilation cost (~2-5s);
subsequent captures are fast.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SCREENSHOTS_DOCS_PORT` | no | `13131` | Port `next dev` is bound to during the crawl |

## Visual feedback loop (Phase 15.4)

The loop's agent has vision: it can read PNGs as images via the Read
tool and judge layout, contrast, cropping, and overflow directly. When
working on user-facing UI (Phase 11 dashboard, Phase 12 analytics, Phase
13 docs), the agent uses the single-route filter to capture just the
page it changed and reads the result back before committing.

### Workflow

1. Make the UI change (component, route, MDX page).
2. Capture the affected route only:

   ```sh
   npm run screenshots -- --target=dashboard --route=<slug>
   npm run screenshots -- --target=docs --route=<slug>
   ```

3. Read both viewports back (the Read tool renders PNGs inline):

   - `tools/screenshots/output/<area>/<slug>.desktop.png`
   - `tools/screenshots/output/<area>/<slug>.mobile.png`

4. Inspect for: cropped content, broken layouts, illegible text,
   contrast failures, mobile-viewport overflow, missing or empty states.

5. Iterate on the code, recapture, re-read. The single-route filter
   keeps each cycle to a few seconds vs. the ~30-screenshot full crawl.

### Where slugs come from

**Dashboard slugs** are static literals in
`src/seed-fixtures.ts::buildDashboardRoutes()`. Current set: `home`,
`games`, `audit`, `permissions`, `analytics`, `game-detail`,
`groups-list`, `group-members`, `group-roles`, `group-permissions`,
`group-audit`, `group-relationships`, `group-sub-groups`, `game-audit`,
`permission-check`, `game-analytics`.

**Docs slugs** derive from MDX file paths via
`src/discover-docs-routes.ts`. Path segments are joined with hyphens:
`apps/docs/pages/sdk/groups.mdx` becomes the slug `sdk-groups`;
`apps/docs/pages/auth/clerk.mdx` becomes `auth-clerk`;
`apps/docs/pages/index.mdx` becomes `home`.

The crawler validates `--route=<slug>` against the resolved route list
and fails fast with an enumerated list of known slugs if no match is
found, so a quick way to list available slugs is to pass an obviously
wrong one and read the error message.

### When to use it

Use it for any iteration that ships rendered output: dashboard
components, analytics charts, docs page formatting, layout shells,
themed UI primitives. Skip it for non-visual work (server routes, SDK
APIs that don't render, prose-only docs edits that don't touch markdown
formatting structure).

### Pre-requisites

The first invocation of the day pays the puppeteer chromium download
cost (one-time, ~280MB; see "First-time setup" above). The dashboard
target additionally needs a running Junjo server and the env vars
listed in "Dashboard catalog" above. The docs target needs nothing
beyond a working repo install.

### Loop prompt-template integration

Hard rule 9 of `.loop/prompt-template.md` forbids the agent from
editing the harness directly. The snippet below is the canonical
prompt-template addition; Gabe pastes it manually into the
"Architectural conventions" area of `.loop/prompt-template.md` (above
"Hard rules - non-negotiable") to wire the workflow into every loop
iteration. Until that paste lands, the agent uses the workflow on its
own initiative when it judges a UI change worth visual validation.

> ### Visual feedback loop (UI work only)
>
> When implementing Phase 11 / 12 / 13 work that produces rendered
> output, after a substantial UI change run:
>
> ```sh
> npm run screenshots -- --target=dashboard --route=<slug>
> ```
>
> (or `--target=docs` for `apps/docs/pages/**.mdx` changes). Then read
> the resulting PNGs at
> `tools/screenshots/output/<area>/<slug>.{desktop,mobile}.png` via the
> Read tool. If anything looks off (cropped content, broken layout,
> illegible text, mobile overflow), iterate before committing. Slugs
> for the dashboard target are listed in
> `tools/screenshots/src/seed-fixtures.ts::buildDashboardRoutes()`;
> slugs for the docs target are derived from MDX file paths
> (segments joined with hyphens; `index.mdx` becomes `home`). See
> `tools/screenshots/README.md` "Visual feedback loop" for the full
> protocol, env-var pre-requisites, and inspection checklist.

## Mobile viewport audit (Phase 15.5)

The catalog captures every route at desktop (1440x900) and mobile (375x812
with a 2x scale factor and `isMobile: true`) so layout regressions on small
screens get visible signal. A "mobile audit" is the periodic pass where a
human (or the loop's vision-capable agent) walks every mobile PNG and
records issues. It is separate from the per-iteration visual feedback loop
above: the feedback loop catches mobile breakage on routes the iteration
touched; the audit catches breakage everywhere else.

### When to run an audit

- Before publishing a marketing-visible release (the dashboard demo or the
  docs site landing).
- After a layout-shell change in the dashboard (`apps/dashboard/app/layout.tsx`,
  the sidebar, the topbar, breadcrumbs).
- After a Tailwind / shadcn / Tremor major-version upgrade.
- Quarterly as a cadence even when nothing obvious has changed; mobile
  regressions creep in from CSS-resolver order changes, third-party bumps,
  and content edits that exceed unstated width assumptions.

### How to run an audit

1. Start the Junjo server (dashboard target only; the docs target needs no
   backend). Set the dashboard env vars per "Dashboard catalog" above.
2. Capture mobile-only for both targets:

   ```sh
   npm run screenshots -- --target=dashboard --viewport=mobile
   npm run screenshots -- --target=docs --viewport=mobile
   ```

   The `--viewport=mobile` filter halves the crawl time vs. capturing both
   viewports (the audit only cares about mobile output).
3. Walk the resulting PNGs route by route. The output sits at
   `tools/screenshots/output/<area>/<slug>.mobile.png` and the
   `INDEX.md` for the area lists every capture in one place.

### Inspection checklist

For each PNG:

- **Horizontal overflow.** Anything wider than 375 CSS px forces a
  horizontal scrollbar; tables, code blocks, and pre-formatted content are
  the usual offenders.
- **Cropped content.** Cards, dialogs, and chart legends that get clipped
  by the viewport edge.
- **Illegible text.** Font sizes below ~14px, low-contrast secondary text,
  text that wraps mid-word because of fixed widths.
- **Touch targets.** Interactive elements smaller than ~44px square; in
  particular icon-only buttons in the sidebar / topbar / table rows.
- **Navigation reachability.** The sidebar collapses on mobile; confirm
  the trigger is visible and tappable, and that the nav links are
  reachable from the collapsed state.
- **Empty / error states.** Fixture-seeded data covers the happy path; if
  a route has an empty state worth screenshotting, capture it manually
  and add it to the audit notes (the catalog does not seed every state).
- **Modal and dialog placement.** Dialogs that exceed viewport height get
  cut off without scroll context; verify the close affordance is reachable.
- **Chart rendering** (analytics routes only). Tremor charts have minimum
  width assumptions; under 375px some collapse to unreadable shapes.

### Recording findings

Each audit produces an issue list, not a checklist of "passed routes". Open
a GitHub issue per finding (or a single audit-issue with a checkbox list
for batch fixes), tag it `mobile`, and reference the offending PNG by its
relative path so the next audit can confirm the fix:

```
Route: /games/<gameId>/groups/<groupId>?tab=permissions
PNG: tools/screenshots/output/dashboard/group-permissions.mobile.png
Issue: permission matrix overflows horizontally; column headers clip at
  the right edge starting around the 4th permission key.
```

The audit does not alter the catalog itself (PNGs are gitignored). Findings
go to issues; fixes happen in the relevant package; the next audit
confirms regression.

### Why this is documentation, not a vitest gate

The crawl needs a live dev server (and for the dashboard target, a live
Junjo server with seeded fixtures). The loop's `verify.ps1` cannot
reliably boot either, so the audit is a human-in-the-loop ritual rather
than an automated check. The infrastructure is here; the cadence is on
whoever owns the release.

## Why Puppeteer and not Playwright

Playwright is already wired in for the dashboard E2E suite (Phase 14.12)
and that's the right tool for behavioral end-to-end tests. Screenshot
capture for a static catalog is a different mental model (visual
snapshot, not a behavioral assertion), and Puppeteer is the lighter
weight choice for that one job. See `docs/05-decisions.md` for the
full rationale.
