# Publishing Junjo to npm

The publishable packages are scoped under `@junjo.io` (the org name
matches the junjo.io domain; dotted scopes are valid, like @socket.io):

- `@junjo.io/sdk`
- `@junjo.io/react`
- `@junjo.io/shared` (internal types dependency of the other two)

Everything else in the monorepo is `private: true` and will never publish.

Published versions: `@junjo.io/sdk` 0.1.3, `@junjo.io/react` 0.1.2,
`@junjo.io/shared` 0.1.2 (0.1.0 of all three first shipped 2026-08-04).

The next release is already staged as four pending changesets under
`.changeset/`:

- `@junjo.io/sdk` (minor): typed transport errors (`network_error`,
  `timeout`, `cancelled`), per-request `signal` / `timeoutMs`,
  `Retry-After` surfacing, `verifyToken` / `keyInfo`, `subscribe` `onClose`,
  new `listAll` iterators, `onUnknownType: "raw"`, and the breaking
  `webhooks.endpoints.list` pagination change.
- `@junjo.io/shared` (minor): the friends contract types, the canonical
  `JUNJO_ERROR_CODES` union, removal of the dead `WebhookDelivery` type,
  and corrected `exports` / `engines`.
- `@junjo.io/react` (minor): new hooks (`useRoles`, `useBans`, `useGroups`),
  shared refcounted live subscriptions, and server-side member / invitation
  filtering.
- `@junjo.io/react` (patch): resolve the workspace copy of `@junjo.io/sdk`
  instead of a stale registry version, plus explicit branded-id casts.

React carries two changesets (a minor and a patch), so it is not one file
per package. Read them before versioning; they carry the behavior-change
notes that belong in the release notes. `npm run version-packages`
(changeset version) consumes all four and bumps the three package.json
files together (react's two changesets collapse into a single minor bump).

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

Release flow: bump the versions in the three package.json files (keep the
internal @junjo.io/* deps pinned to the new version), commit, push, then
run the "Publish" workflow from the Actions tab (or `gh workflow run
publish.yml`). Already-published versions are skipped, so re-runs are
safe.
