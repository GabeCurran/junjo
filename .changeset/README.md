# Changesets

Run `npm run changeset` to record a release-note for the change you just made. Pick the affected packages and bump level (patch/minor/major), write a short user-facing note, commit the resulting `.md` file alongside the code change. CI runs `changeset version` + `changeset publish` on merge to `main`.

`apps/*` and `examples/*` are ignored — they're not published to npm.
