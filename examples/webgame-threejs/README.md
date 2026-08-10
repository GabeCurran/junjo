# Example: browser guild panel behind a proxy

A minimal plain-browser example of `@junjo.io/sdk` in proxy mode: a static page that lists, creates, and joins guilds, plus a small Hono proxy that holds the per-game `jk_` key server-side. No framework, no bundler, no build step. (The directory name is historical; there is no Three.js here.)

What it demonstrates:

- The browser client constructed with `new Junjo({ proxy: true, baseUrl: "/api/junjo" })`, sending no credential.
- A proxy (`server.mjs`) that forwards an allowlisted route set only (`GET /v1/whoami`, `GET /v1/groups`, `POST /v1/groups`, `POST /v1/groups/:id/join`) and pins every user id to the session before forwarding. A hardcoded `demo-player-1` stands in for real session auth.
- Error handling that branches on `err.code`, including `retryAfterSeconds` on 429.
- Loading the SDK in the browser without a bundler: the proxy serves the installed package's ESM files under `/vendor/sdk/` and the page maps the bare specifier via an import map.

## Run it

From the repo root, against a local dev server:

```sh
npm install
npm run build -w "@junjo.io/shared" -w "@junjo.io/sdk"   # dist/ is gitignored; the proxy serves the SDK's built files to the browser (shared must build first)
npm run dev:server-only                                  # boots Postgres, writes .env, migrates, seeds a demo game, API on :8787
```

`npm run dev:server-only` (or the full `npm run dev`) bootstraps everything: it starts the `junjo-test-pg` container, creates the root `.env`, applies migrations, and seeds a demo game, so no separate migrate or seed step is needed. The seed output prints a fresh API key (`full: jk_...`), also persisted into `.env` as `JUNJO_ADMIN_API_KEY`. Then, in another terminal:

```sh
JUNJO_API_KEY=jk_... node examples/webgame-threejs/server.mjs
```

PowerShell:

```powershell
$env:JUNJO_API_KEY = "jk_..."; node examples/webgame-threejs/server.mjs
```

Open http://localhost:8788. `JUNJO_API_URL` (default `http://localhost:8787`) points the proxy at a different server; `PORT` (default `8788`) moves the example.

## Security notes

- The `jk_` key exists only in `server.mjs`'s environment. The page and `main.js` never see it; view-source proves it.
- The proxy is the authorization layer: the allowlist keeps the browser away from kick/ban/role routes, and the pinned user id keeps it from acting as someone else. A real app replaces the hardcoded id with its session lookup.
- Pinning covers query strings too: on `GET /v1/groups` the proxy strips any client-supplied `viewer` and always sets its own, so the browser sees the session user's directory view (secret groups hidden) rather than the key holder's privileged admin view.
- Everything is same-origin (static files and proxy on one port), so no CORS configuration is involved.
- Background: [security model](https://docs.junjo.io/security-model) and the [browser guide](https://docs.junjo.io/browser).
