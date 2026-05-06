// Puppeteer install behavior. We do NOT auto-download chromium during npm
// install for two reasons: (1) the workspace is rarely used (loop iteration
// budget should not pay a 280MB download every fresh clone); (2) Playwright
// already ships its own chromium for the Phase 14.12 dashboard E2E suite,
// and a second chromium would just sit on disk.
//
// Run `npx puppeteer browsers install chrome` from this workspace before
// the first `npm run screenshots`. The crawler surfaces a clear error if
// chromium can't be resolved.
module.exports = {
  skipDownload: true,
};
