# Publishing Junjo to npm

The publishable packages are scoped under `@junjo-io` (the bare `junjo`
npm name could not be secured; the scope matches the junjo.io domain):

- `@junjo-io/sdk` (0.1.0)
- `@junjo-io/react` (0.1.0)
- `@junjo-io/shared` (0.1.0, internal types dependency of the other two)

Everything else in the monorepo is `private: true` and will never publish.

## One-time setup

1. Create the free npm org. Log in at https://www.npmjs.com, click your
   avatar > "Add Organization", name it exactly `junjo-io`, and pick the
   free "Unlimited public packages" plan. (Scoped public packages are free;
   no paid plan needed.)
2. Log in with the npm CLI on this machine:

   ```
   npm login
   ```

   Follow the browser prompt. Verify with `npm whoami`.

## Publish

From the repo root:

```
npm run release
```

That runs the full monorepo build and then `changeset publish`, which
publishes every non-private package whose version is not yet on the
registry (the three packages above at 0.1.0). All three carry
`publishConfig.access: public`, so no extra flags are needed.

If you prefer to publish by hand instead, the equivalent is:

```
npm run build
npm publish --workspace @junjo-io/shared --access public
npm publish --workspace @junjo-io/sdk --access public
npm publish --workspace @junjo-io/react --access public
```

## Verify

```
npm view @junjo-io/sdk
npm view @junjo-io/react
npm view @junjo-io/shared
```

Each should report version 0.1.0. Then a clean-room smoke test:

```
mkdir /tmp/junjo-smoke && cd /tmp/junjo-smoke && npm init -y && npm install @junjo-io/sdk
```

## Future releases via GitHub Actions (optional)

`.github/workflows/publish.yml` is a manual `workflow_dispatch` that runs
build + test + `changeset publish` with npm provenance. To use it:

1. Create a granular npm access token (npmjs.com > Access Tokens) with
   read/write scoped to the `@junjo-io` packages.
2. Add it as the `NPM_TOKEN` repository secret on GitHub.
3. Trigger the "Publish" workflow from the Actions tab.

Day-to-day version bumps go through changesets: `npm run changeset` to
record a change, `npm run version-packages` to bump, then release.
