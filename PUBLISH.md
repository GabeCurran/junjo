# Publishing

Three packages publish to npm under the `@junjo.io` scope:

- `@junjo.io/sdk`
- `@junjo.io/react`
- `@junjo.io/shared` (shared types, a dependency of the other two)

Everything else in the monorepo is `private: true`. Release notes live in
each package's `CHANGELOG.md`.

## Release

1. `npm run version-packages` consumes the pending changesets under
   `.changeset/`, bumps the three `package.json` files, and writes the
   changelogs.
2. Run `npx biome check --write` over those three files. Changeset
   rewrites them in its own format.
3. Check that `packages/react/package.json` pins the new sdk version. A
   stale pin makes installs resolve the registry sdk instead of the
   workspace copy.
4. Commit and push.
5. `gh workflow run publish.yml --ref main`, or run Publish from the
   Actions tab.

The workflow builds and tests before publishing, takes about three
minutes, and skips versions already on the registry, so re-runs are safe.
Auth is npm trusted publishing over OIDC, so there is no token secret.

## Verify

```
npm view @junjo.io/sdk
npm view @junjo.io/react
npm view @junjo.io/shared
```

Clean-room install:

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\junjo-smoke" | Out-Null
Set-Location "$env:TEMP\junjo-smoke"
npm init -y
npm install "@junjo.io/sdk"
```

Registry reads lag a few minutes behind a publish, so `npm view` can 404
while a republish reports the version already exists.

## Publishing by hand

Needs a real terminal, since the account's passkey 2FA opens a browser
approval that a non-interactive shell cannot complete. One approval
covers the publishes that follow it for a short window.

```
npm run build
npm publish --workspace "@junjo.io/shared" --access public
npm publish --workspace "@junjo.io/sdk" --access public
npm publish --workspace "@junjo.io/react" --access public
```

Quote the scoped names in PowerShell. `npm run release` (changeset
publish) forces the OTP path and does not work with passkey 2FA.

## Trusted publisher setup

Once per package, on its npmjs.com Settings page:

- Publisher: GitHub Actions
- Organization or user: GabeCurran
- Repository: junjo
- Workflow: `publish.yml`
- Environment: blank
