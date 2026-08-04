# Publishing Junjo to npm

The publishable packages are scoped under `@junjo.io` (the org name
matches the junjo.io domain; dotted scopes are valid, like @socket.io):

- `@junjo.io/sdk`
- `@junjo.io/react`
- `@junjo.io/shared` (internal types dependency of the other two)

Everything else in the monorepo is `private: true` and will never publish.
0.1.0 of all three shipped 2026-08-04.

## Publishing by hand

The npm account uses passkey 2FA, so publishes need a browser approval.
Run this in a REAL terminal (not a non-interactive shell - npm refuses
the browser flow there and demands a TOTP code that does not exist):

```
npm run build
npm publish --workspace "@junjo.io/shared" --access public
npm publish --workspace "@junjo.io/sdk" --access public
npm publish --workspace "@junjo.io/react" --access public
```

Quote the scoped names in PowerShell (bare @ is a parse error). After one
browser approval there is a short same-IP grace window where further
publishes go through without a prompt. Note: `npm run release` (changeset
publish) does NOT work with passkey 2FA - it forces the OTP path.

Registry reads can lag several minutes behind a publish: `npm view` may
404 while a republish attempt says the version already exists. Wait it
out before assuming failure.

## Verify

```
npm view @junjo.io/sdk
npm view @junjo.io/react
npm view @junjo.io/shared
```

Then a clean-room smoke test:

```
mkdir /tmp/junjo-smoke && cd /tmp/junjo-smoke && npm init -y && npm install @junjo.io/sdk
```

## Releases via GitHub Actions (preferred)

`.github/workflows/publish.yml` is a manual `workflow_dispatch` that runs
build + test and publishes any workspace version not yet on the registry,
with provenance. Auth is npm TRUSTED PUBLISHING (OIDC) - no token secret.

One-time setup, once per package, on npmjs.com:

1. Open the package page > Settings (e.g.
   https://www.npmjs.com/package/@junjo.io/sdk/access)
2. Under "Trusted Publisher" choose GitHub Actions and enter:
   - Organization or user: GabeCurran
   - Repository: junjo
   - Workflow filename: publish.yml
   - Environment: (leave blank)
3. Repeat for @junjo.io/react and @junjo.io/shared.

Release flow: bump the versions in the three package.json files (keep the
internal @junjo.io/* deps pinned to the new version), commit, push, then
run the "Publish" workflow from the Actions tab (or `gh workflow run
publish.yml`). Already-published versions are skipped, so re-runs are
safe.
