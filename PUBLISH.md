# Publishing Junjo to npm

The publishable packages are scoped under `@junjo.io` (the org name
matches the junjo.io domain; dotted scopes are valid, like @socket.io):

- `@junjo.io/sdk`
- `@junjo.io/react`
- `@junjo.io/shared` (internal types dependency of the other two)

Everything else in the monorepo is `private: true` and will never publish.

Published versions: all three at 0.3.0 (0.1.0 first shipped 2026-08-04,
0.2.0 on 2026-08-10, 0.3.0 on 2026-08-16). Per-release notes live in each
package's `CHANGELOG.md`.

A release starts from the changesets pending under `.changeset/`. There is
no fixed one-file-per-package rule: a package can carry several (a minor
and a patch collapse into one minor bump), and a single changeset can name
several packages. Read them before versioning, since they carry the
behavior-change notes that become the release notes. `npm run
version-packages` (changeset version) consumes every pending changeset,
bumps the three package.json files together, and writes the CHANGELOGs.

`changeset version` reformats the package.json files it rewrites, which
trips the biome pre-commit hook. Run `npx biome check --write` on the three
package.json files after versioning, and check the command's exit code
rather than its trailing output: a clean biome run prints nothing useful on
the last line, so `| tail -1` makes a failure look like a pass.

Invariant that has broken before: `@junjo.io/react`'s dependency pin on
`@junjo.io/sdk` must match the workspace sdk version. When it does not,
installs resolve a stale registry sdk instead of the workspace copy.
After any sdk bump, confirm `packages/react/package.json` pins the same
version before publishing.

## Publishing by hand

The npm account uses passkey 2FA, so publishes need a browser approval.
Run this in a REAL terminal (not a non-interactive shell, where npm
refuses the browser flow and demands a TOTP code that does not exist):

```
npm run build
npm publish --workspace "@junjo.io/shared" --access public
npm publish --workspace "@junjo.io/sdk" --access public
npm publish --workspace "@junjo.io/react" --access public
```

Quote the scoped names in PowerShell (bare @ is a parse error). After one
browser approval there is a short same-IP grace window where further
publishes go through without a prompt. Note: `npm run release` (changeset
publish) does NOT work with passkey 2FA; it forces the OTP path.

Registry reads can lag several minutes behind a publish: `npm view` may
404 while a republish attempt says the version already exists. Wait it
out before assuming failure.

## Verify

```
npm view @junjo.io/sdk
npm view @junjo.io/react
npm view @junjo.io/shared
```

Then a clean-room smoke test (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\junjo-smoke" | Out-Null
Set-Location "$env:TEMP\junjo-smoke"
npm init -y
npm install "@junjo.io/sdk"
```

## Releases via GitHub Actions (preferred)

`.github/workflows/publish.yml` is a manual `workflow_dispatch` that runs
build + test and publishes any workspace version not yet on the registry,
with provenance. Auth is npm TRUSTED PUBLISHING (OIDC), so no token secret.

One-time setup, once per package, on npmjs.com:

1. Open the package page > Settings (e.g.
   https://www.npmjs.com/package/@junjo.io/sdk/access)
2. Under "Trusted Publisher" choose GitHub Actions and enter:
   - Organization or user: GabeCurran
   - Repository: junjo
   - Workflow filename: publish.yml
   - Environment: (leave blank)
3. Repeat for @junjo.io/react and @junjo.io/shared.

Release flow: `npm run version-packages`, re-format the package.json files
(see above), confirm the internal @junjo.io/* deps pin the new version,
commit, push, then run the "Publish" workflow from the Actions tab (or
`gh workflow run publish.yml --ref main`). Already-published versions are
skipped, so re-runs are safe. The run takes roughly 3 minutes; it builds
and tests before publishing, so a red test blocks the release.

This is the only path that works from a non-interactive shell. Being
logged in locally (`npm whoami` answering) is not enough: passkey 2FA
needs a browser, so a headless `npm publish` asks for a TOTP that does not
exist. 0.3.0 went out this way; 0.2.0 was published by hand and is the one
release without a provenance attestation.
