# @junjo/diagrams

Mermaid diagram source files plus a thin renderer that produces PNG or SVG
previews. The committed artifact is the `.mmd` source under `source/` plus
the Mermaid code fence embedded in the relevant Nextra MDX page; the rendered
images under `output/` are gitignored and exist only for the loop agent's
visual iteration cycle (write `.mmd` source, render, read PNG, judge layout,
iterate).

This workspace is part of Phase 16 of the V1 roadmap. Phase 16.1 ships the
renderer + tests with no diagrams yet. Phases 16.2 through 16.5 add the
actual `.mmd` files (system architecture, permission resolution, webhook
delivery, auth flow). Phase 16.6 wires a sync gate that asserts every
committed `.mmd` source matches the version embedded in the corresponding
MDX page.

## Layout

```
tools/diagrams/
  source/
    .gitkeep              placeholder; replaced by .mmd files in 16.2+
    *.mmd                 committed Mermaid source (one diagram per file)
  output/                 rendered PNG / SVG previews (gitignored)
  src/
    render.ts             CLI entry: parse args, discover sources, run mmdc
    args.ts               CLI argument parser
    discover-sources.ts   FS walk over source/*.mmd
    render-plan.ts        builds the {source -> output} task list
  README.md
  package.json
  tsconfig.json
  .puppeteerrc.cjs        skips chromium auto-download on npm install
```

## First-time setup

`@mermaid-js/mermaid-cli` (`mmdc`) drives Puppeteer to render diagrams via
headless chromium. The chromium auto-download is disabled (see
`.puppeteerrc.cjs`) so a fresh `npm install` does not pay the 280MB cost
for a workspace most contributors never run. Before the first
`npm run diagrams`, install chromium explicitly from this workspace:

```sh
cd tools/diagrams
npx puppeteer browsers install chrome
```

Or set `PUPPETEER_EXECUTABLE_PATH` to point at a chromium you already have
(Playwright ships its own copy under
`node_modules/playwright/.local-browsers/`).

## Usage

```sh
# Render every .mmd under source/ to PNG under output/
npm run diagrams

# Render a single source by slug (filename without the .mmd extension)
npm run diagrams -- --file=system-architecture

# Emit SVG instead of PNG
npm run diagrams -- --format=svg

# Override the source or output directory
npm run diagrams -- --source-dir=/tmp/src --out-dir=/tmp/out
```

The CLI exits non-zero on a mmdc render error or an unknown filter slug.
All other flags follow the same `--key=value` shape used by
`tools/screenshots`.

## Style conventions

Every `.mmd` source starts with a theme directive so the diagrams render
consistently:

```mermaid
%%{init: {'theme': 'neutral'}}%%
flowchart LR
  ...
```

Use `flowchart` over the older `graph` keyword. Keep node labels concise.
Cross-diagram visual style (colors, fonts, edge styles) follows Mermaid's
`neutral` theme defaults; do not override per-diagram unless there is a
specific reason and the override is documented.

## Embedding in the docs site

Each diagram has two homes:

1. The committed `.mmd` source in `tools/diagrams/source/<slug>.mmd`.
2. A Mermaid code fence in the relevant MDX page under `apps/docs/pages/`.

Nextra v3 renders Mermaid client-side from `mermaid` code fences. The
two copies must stay byte-identical (same theme directive, same diagram
body). Phase 16.6 ships a `tools/diagrams/check-sync.ts` script that
diffs source vs embedded and exits non-zero on drift; that script runs
inside `verify.ps1` once it lands.

## Agent visual iteration loop

When the loop agent edits a diagram in Phase 16.2 through 16.5:

1. Edit `tools/diagrams/source/<slug>.mmd`.
2. Run `npm run diagrams -- --file=<slug>` to render just the changed diagram.
3. Read the resulting PNG via the Read tool to validate layout, label
   placement, edge crossings, and overall clarity.
4. Iterate until the diagram is readable at the desktop default zoom.
5. Sync the updated source into the relevant MDX page in the same commit.

The single-file filter keeps the cycle tight (one `mmdc` invocation takes
a few seconds versus rendering every diagram in `source/`).

## Why mermaid-cli instead of rendering at docs build time only

Nextra renders Mermaid in the browser, so production docs do not need
`mmdc`. The agent does, because it needs PNG output to feed back through
the Read tool for visual review. Without `mmdc` the agent would have to
trust that the Mermaid syntax is correct without seeing the rendered
diagram, which defeats the purpose of an agent-driven diagram workflow.
