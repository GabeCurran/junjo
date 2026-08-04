# Example: Three.js webgame

Minimal Three.js scene + `@junjo.io/sdk` integration. Shows the "create guild, invite member, check permission" flow from a browser.

Because this runs in a browser, the client is constructed in proxy mode (`new Junjo({ proxy: true, baseUrl: "/api/junjo" })`) with a small dev proxy that injects the per-game `jk_` API key server-side. The key is a full-control secret and must never be embedded in the bundle or exposed via `VITE_` / `NEXT_PUBLIC_` env vars; see the [React provider docs](https://docs.junjo.io/react/provider) for the proxy contract.

Real example code lands once the SDK has real implementations.
