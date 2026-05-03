# 06 - Security audit (V1)

Snapshot of Junjo's V1 security posture as of 2026-05-03 (Phase 14.13). The audit covers three layers: dependency advisories, the OWASP top 10 against the V1 surface, and the auth code paths (per-game API key, server-wide admin token, JWT adapter, dashboard basic auth, webhook HMAC). Only one finding produced a code change in the same commit (the webhook URL SSRF guard); the rest are existing controls confirmed by walking the code.

This doc is the threat model. The settings to enforce it live in code; the settings to relax it (for self-host development) live in env vars on `packages/server/src/env.ts`.

## Scope

- **In scope:** the OSS server (`packages/server`), the public SDK (`packages/sdk`), the React adapter (`packages/react`), the Luau SDK (`packages/sdk-roblox`), the Junjo dashboard (`apps/dashboard`), and the docs site (`apps/docs`).
- **Out of scope:** the Roblox client side of `sdk-roblox` (Roblox sandbox is its own threat model; we assume `HttpService` and `GetSecret` behave as documented). The cloud deployment platform (Fly / Render / etc.) and its IAM are operator concerns.

## Dependency advisories

Findings from `npm audit` at the repo root, 2026-05-03:

| Package | Severity | Direct? | Effect | Triage |
|---------|----------|---------|--------|--------|
| `vite` (≤6.4.1) | moderate | no (via vitest) | Path traversal in optimized-deps `.map` handling, dev-server bind | dev only - vitest test runner. Production server uses Hono + Node, no vite. Fix needs `vitest@4` major bump (forbidden by hard rule 8). Accepted. |
| `esbuild` (≤0.24.2) | moderate | no (via vite) | Dev server accepts cross-origin requests | same as vite. Accepted. |
| `vitest` (3.0.0-beta.4 and earlier) | moderate | yes | rolls up vite + esbuild | same. Accepted. |
| `postcss` (<8.5.10) | moderate | no (via next) | XSS via unescaped `</style>` in stringify output | dev only - docs site build. The advisory affects code that processes attacker-controlled CSS during a build; our build inputs are repo-internal MDX. Accepted. |
| `next` (3.4.x line) | moderate | yes | rolls up postcss | docs site only. The dashboard uses Next 15 (clean). Accepted. |
| `nextra` / `nextra-theme-docs` / `@theguild/remark-mermaid` / `mermaid` / `uuid` (<14) | moderate | yes / no | rolls up the chain above | docs build only. No fix available without major bumps that aren't published yet. Accepted. |

**Summary:** zero advisories on the production runtime path (`hono`, `@prisma/client`, `pino`, `jose`, `zod`). All 12 moderate findings are confined to the dev tool chain (test runners, docs build). None can be fixed without a major version bump, which is forbidden by hard rule 8 of the autonomous loop. Re-audit at the next major-version refresh window.

## OWASP top 10 (2021) walkthrough

### A01 - Broken access control

- **Tenant isolation.** Every per-game route resolves the resource via `prisma.<table>.findFirst({ where: { id, gameId } })` (or `findUnique` against a `(gameId, foreignKey)` composite key). A valid API key for game A presented against `/v1/groups/<group-of-game-B>` returns 404, not 403, so the existence of cross-tenant resources is not leaked. Spot-checked in `packages/server/src/routes/groups.ts`, `audit.ts`, `webhooks.ts`, `routes/members.ts`. Status: implemented.
- **Admin endpoints.** Cross-game / dashboard endpoints sit under `/v1/admin/*` and `/v1/users/:junjoUserId/games`. They require the server-wide `JUNJO_ADMIN_TOKEN`. The token is compared in constant time (`packages/server/src/middleware/adminAuth.ts`); when unset, every admin route returns 401, which is the right default for self-host setups that never want them exposed.
- **Permission resolution.** `can() / check()` resolves with member overrides taking precedence over role-derived grants (`packages/server/src/permissionCache.ts`). Misconfiguration risk (a developer accidentally granting blanket permissions) is the dev's responsibility, not Junjo's; the resolver does what it's told.

### A02 - Cryptographic failures

- **API key secrets** are stored as `scrypt$<salt>$<hash>` (`packages/server/src/apiKey.ts`). Verification uses `crypto.timingSafeEqual`. Wire format is `{prefix}.{secret}` so the prefix is the cheap lookup index and the secret is the expensive verify. A DB leak alone cannot act as the developer.
- **Webhook signatures** are HMAC-SHA256 over `{timestamp}.{body}` with the per-endpoint secret, hex-encoded, prefixed `v1=` (`packages/server/src/webhookWorker.ts`). Receivers verify constant-time (`packages/sdk/src/webhooks.ts`), enforce a 5-min default tolerance window, and reject missing / invalid timestamps. Stripe-style; standard.
- **Webhook secrets at rest.** Stored plaintext in `WebhookEndpoint.secret`. The worker needs to recover the secret to compute the HMAC before each delivery; reversible storage is unavoidable. Mitigation: the secret is returned to the dashboard exactly once on `POST /v1/webhooks` and never again on list / update. Future enhancement: encrypt-at-rest with a KEK env var so a partial leak (DB dump but env vars intact) does not expose all secrets. Tracked in V2 ideas.
- **JWT verification** delegates to `jose` with the algorithm pinned per `jwtAdapter` instance (`packages/sdk/src/adapters/jwt.ts`). HS256 / RS256 / ES256 supported; `none` is impossible to configure through the public API. `iss` and `aud` are validated when set, and `clockToleranceSeconds` defaults to 0 (strict).
- **TLS.** The server speaks plain HTTP and expects a reverse proxy to terminate TLS, documented in `apps/docs/pages/self-host.mdx`. Out of scope for the application layer.

### A03 - Injection

- **SQL.** All database access goes through Prisma (parameterized). No `$queryRawUnsafe` calls except in test fixture truncations against literal table names. Status: clean.
- **Command / shell.** No `child_process.exec` calls in the production server runtime.
- **JSON / log.** User-supplied payloads (`group.metadata`, `audit.payload`) are stored as `Json` and round-tripped opaquely; no eval, no template-string concatenation into a query.

### A04 - Insecure design

- **Rate limiting.** Per-API-key token bucket on `/v1/*` routes (`packages/server/src/middleware/rateLimit.ts`), default 600 req/min sustained / 100 burst, configurable via `RATE_LIMIT_PER_MINUTE` and `RATE_LIMIT_BURST`. Buckets keyed on the API key prefix (a cheap string parse) so noisy keys are bounded before paying the scrypt-verify cost. Unparseable headers share one `anon` bucket so junk traffic cannot blow up the in-memory map. Caveat: in-memory per-process; multi-instance deploys need an external store. Documented as a known limitation.
- **SSRF (webhook delivery).** Discovered in this audit. `POST /v1/webhooks { url }` accepts any http(s) URL the developer registers, and the webhook worker `fetch()`es it on every matching event. A malicious developer with a valid API key could register `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and have the server beacon to internal services. Fixed in this iteration: added `assertSafeWebhookUrl` in `packages/server/src/webhookUrlGuard.ts`; called from both `POST /v1/webhooks` and `PATCH /v1/webhooks/:id` when the URL is changing; rejects loopback, link-local (incl. RFC3927 `169.254/16` and IPv6 `fe80::/10`), RFC1918, RFC6598 CGNAT, IPv6 ULA, and `0.0.0.0`. Operator escape hatch: `WEBHOOK_ALLOW_PRIVATE_HOSTS=true` for self-host development. The check is lexical (no DNS resolution), so DNS rebinding is not blocked; the V1 backstop is operator network policy.

### A05 - Security misconfiguration

- **Default-deny admin.** `JUNJO_ADMIN_TOKEN` unset disables every `/v1/admin/*` route. Self-hosters do not accidentally expose admin endpoints by forgetting an env var.
- **Default-secure webhook URLs.** `WEBHOOK_ALLOW_PRIVATE_HOSTS` defaults to false; operators must opt out, never opt in.
- **Error messages.** `JunjoError` returns `{ code, status, message }`. Codes are stable + documented (`apps/docs/pages/api-reference/errors.mdx`). 500s log the full error server-side and return a fixed `internal error` body. No stack traces leak.
- **Headers.** No `Server` / `X-Powered-By` headers are set explicitly; Hono on Node is silent by default.
- **CORS.** Not configured server-side. SDK calls always traverse a backend (the developer's app), not a browser direct from the player's device, so CORS is intentionally absent. A future cloud deployment may add it for the dashboard.

### A06 - Vulnerable and outdated components

Covered by the dependency advisories table above. All findings are dev-tool only and blocked on a major-version refresh.

### A07 - Identification and authentication failures

- **API keys** are 32 bytes of entropy each (`randomBytes(32).toString("base64url")`), prefixed `jk_<12-byte-base64url>`, hashed with scrypt. Brute force is impractical; the prefix is indexed for O(1) lookup.
- **Admin token** is operator-supplied. The middleware compares constant-time and 401s on absence. The README recommends "a long random string"; we do not enforce a minimum length (a 12-character token would still parse), but exposing a weak admin token is operator misconfiguration.
- **Dashboard auth** is HTTP Basic via Next.js middleware reading `DASHBOARD_ADMIN_USER` / `DASHBOARD_ADMIN_PASSWORD`. Constant-time string compare in the Edge runtime. The README recommends production deployments put the dashboard behind Clerk / Auth0 / a corporate auth proxy. Basic auth in V1 is the right trade for "Gabe runs it locally to operate the cloud"; productionizing dashboard auth is a launch-prep item.
- **JWT adapter** rejects expired tokens, mismatched algorithms, missing `sub`, and (when configured) wrong `iss` / `aud`. Returns `null` rather than throwing on validation failure so the route layer can produce a uniform 401.
- **Rate limit on auth.** Same per-API-key bucket caps brute-force attempts at ~600/min. Acceptable for V1; tighter limits on auth-failure paths can come later if attack telemetry justifies it.

### A08 - Software and data integrity failures

- **Webhook receivers.** HMAC-SHA256 signing with timestamp + 5-min tolerance prevents replay outside the window. The signature scheme is versioned (`v1=`) so a future scheme can coexist without breaking existing receivers.
- **Supply chain.** No CI auto-publish in V1. Releases are operator-driven. `package-lock.json` committed; `npm ci` is the recommended install path in the docs.

### A09 - Security logging and monitoring failures

- **Structured logging** via `pino` at `packages/server/src/logger.ts`. JSON in production, pretty in dev. Default `info`. Auth failures, webhook delivery failures, and worker errors are logged with structured fields.
- **Audit log.** Every state-mutating route writes an `AuditEntry` row (`packages/server/src/routes/groups.ts` and friends). The audit log is queryable per-group via `GET /v1/groups/:id/audit` and game-wide via the admin endpoint. This gives operators after-the-fact attribution for "who kicked whom, when."
- **Rate-limit hits** are logged at warn level with the bucket key; persistent attack patterns surface in logs without bespoke instrumentation.

### A10 - Server-side request forgery (SSRF)

The webhook delivery worker is the one path that takes user-supplied URLs and calls `fetch()` against them. Covered above under A04; mitigated in this iteration.

## Auth hardening confirmations

Walking the auth code paths against this audit's questions:

- **API key middleware** (`packages/server/src/middleware/apiKey.ts`): rejects missing / malformed Authorization, parses prefix + secret, looks up by prefix, checks `revokedAt`, scrypt-verifies the secret. Order is correct (cheap rejections before expensive verify). Status: hardened.
- **Admin token middleware** (`packages/server/src/middleware/adminAuth.ts`): constant-time string compare, length-mismatch path runs a dummy compare to keep the timing path bounded by `max(a.length, b.length)`. Status: hardened.
- **Rate limiter** (`packages/server/src/middleware/rateLimit.ts`): keyed on prefix, anonymous bucket for unparseable headers, returns 429 + `Retry-After`. Status: hardened.
- **Webhook signing** (`packages/server/src/webhookWorker.ts` + `packages/sdk/src/webhooks.ts`): HMAC-SHA256 over `{timestamp}.{body}`, constant-time compare on the receiver, default 5-min tolerance. Status: hardened.
- **External-identity resolution** (`packages/server/src/identity.ts`): race-safe `findOrCreateJunjoUser` via `ON CONFLICT` + re-select on `(gameId, externalUserId)`. No risk of duplicate JunjoUser rows from concurrent first-time requests. Status: hardened.
- **Dashboard middleware** (`apps/dashboard/middleware.ts`): constant-time compare in Edge runtime, basic-auth realm set, refuses requests when env vars not configured. Status: acceptable for V1; production deployments expected to layer external auth in front.

## Known limitations (V1)

These are accepted trade-offs for V1; each has a documented mitigation or a deferred follow-up:

- **In-memory rate limit.** Single-process. Multi-instance deploys need an external store (Redis, etc.). Documented at `packages/server/README.md`.
- **Plaintext webhook secrets at rest.** Required for HMAC signing; the worker needs the plaintext to sign. Mitigation: secret returned exactly once on create, scoped to the calling game by tenant isolation. V2 enhancement: encrypt at rest with KEK.
- **No webhook secret rotation API.** The `update` schema does not allow changing the secret; rotation requires `delete` + `create`. Tracked as a V2 ergonomic improvement.
- **Lexical SSRF check.** DNS rebinding still wins. The V1 backstop is operator network policy (deploy the server in a VPC where outbound traffic to internal ranges is blocked at the network layer).
- **Dashboard basic auth.** Suitable for "Gabe runs it locally" V1, not for a multi-operator production dashboard. Productionization is a launch-prep item.
- **No CSRF protection on the dashboard.** Server Actions in Next.js 15 use opaque action ids that an attacker cannot forge cross-origin (Next's built-in CSRF defense), so we inherit that protection. No additional middleware needed.

## Re-audit cadence

This document is a snapshot. It should be re-walked at:

- Every major dependency refresh (when hard rule 8 is suspended for a planned upgrade).
- Every new SDK surface that takes user-supplied URLs / hostnames / file paths.
- Every new auth adapter (the cookbook page in `apps/docs/pages/auth/` should mention any adapter-specific considerations).
- Before the V1 launch pass, as the final gate alongside dashboard auth productionization.
