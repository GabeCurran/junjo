// `@mermaid-js/mermaid-cli` depends on Puppeteer to render diagrams via
// headless chromium. We do NOT auto-download chromium during npm install for
// the same two reasons documented in `tools/screenshots/.puppeteerrc.cjs`:
// (1) the workspace is rarely run; paying a 280MB chromium download on every
// fresh clone is unfair to contributors who never invoke it. (2) The same
// machine almost certainly has Playwright's chromium already from Phase 14.12;
// duplicating it is waste.
//
// Run `npx puppeteer browsers install chrome` from this workspace before the
// first `npm run diagrams`, or set `PUPPETEER_EXECUTABLE_PATH` to point at an
// existing chromium binary (Playwright's lives under
// `node_modules/playwright/.local-browsers/`).
module.exports = {
  skipDownload: true,
};
