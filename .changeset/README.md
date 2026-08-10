# Changesets

Run `npm run changeset` to record a release-note for the change you just made. Pick the affected packages and bump level (patch/minor/major), write a short user-facing note, commit the resulting `.md` file alongside the code change. There is no auto-publish on merge: releasing is a manual step. `npm run version-packages` (`changeset version`) consumes the pending changesets and bumps the package versions, and `.github/workflows/publish.yml` is a manual `workflow_dispatch` that publishes each package with a hand-rolled per-package loop (`changeset publish` cannot be used because the npm account's passkey 2FA forces an OTP path; see `PUBLISH.md`).

`apps/*` and `examples/*` are ignored; they're not published to npm.
