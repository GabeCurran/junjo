# Junjo.io hardening program: final report

This report closes a multi-phase program that audited and hardened the
Junjo.io platform and built out its SDK family. It records what shipped,
how it was verified, what is deliberately deferred, and the decisions
that are yours to make before a public launch.

Scope of the program in the repository history: 60 commits from the
pre-program head (`dcc7f02`) through the program's close, across 361
files. No code was pushed to origin and nothing was published during the
program; every commit is local for your review.

## What the platform is

Junjo is a groups, ranks, and permissions backend for games: a
per-game REST API over `/v1` (Hono on Node, Prisma and Postgres),
server-sent event streams, and webhook delivery, with client SDKs in
five ecosystems. The server is the source of truth; every SDK mirrors
its wire contracts.

## Phases

**Phase 0, audit.** Full system audit and capability baseline. Findings
fed every later phase.

**Phase 1, server and shared hardening.** The largest correctness pass.
A transactional outbox for events and webhook deliveries (staged inside
each mutation transaction, published after commit), race-safe unique and
serialization handling, a parent-cycle guard under SERIALIZABLE
isolation, a redesigned dual-bucket rate limiter that now wraps the
entire `/v1` surface including admin and invitation preview and keys on a
spoof-proof source, request-id validation and generic 500s to close
injection and disclosure surfaces, and the friends domain with strict
schemas. Shared branded types and a typed error envelope.

**Phase 2, TypeScript SDK.** Typed transport errors with dedicated codes,
abort and timeout coverage through body reads, Retry-After surfacing, the
`verifyToken` and `keyInfo` split, webhook verification with a
`verifyWithMeta` variant, and full JSDoc.

**Phase 3, React.** A refcounted subscription hub so hooks sharing a
group reuse one SSE stream, generation-guarded async hooks, server-side
filters, cursor pagination on member lists, and new `useRoles`,
`useBans`, and `useGroups` hooks.

**Phase 4, Roblox SDK.** A full overhaul and the rebrand to the Junjo.io
SDK for Roblox: near-parity REST surface, an opt-in retry policy tuned
for HttpService budgets, correct handling of the platform's empty-body
and Secret quirks, and a version-locked release workflow.

**Phase 5, documentation, diagrams, and developer experience.** The docs
site, nine byte-locked Mermaid diagrams, a repo-wide style gate (dash and
emoji bans, fence-aware prose checks), and the unified verify gate.

**Phase 6, C++ SDK.** A C++20 client (CMake package `JunjoIO`, target
`JunjoIO::SDK`, namespace `junjo`): a `Result`-based never-throw
contract, cancellation tokens, a caller-owned-executor async facade, an
SSE subscription with a carefully reasoned teardown, a pluggable
transport with a bundled libcurl default (dependencies pinned by SHA-256
content hash), and a clean-room HMAC-SHA256 for webhook verification. The
suite is 254 doctest cases (255 CTest registrations), green in Debug and
Release, with an installed-package consumer proven in CI.

**Phase 7, Unreal Engine.** A source plugin (`JunjoIO`) built on the C++
core: an engine-HTTP transport verified against the real UE 5.8 headers,
a game-instance subsystem with a Blueprint and delegate async surface,
five Blueprint async-action nodes, live event streams delivered on the
game thread, and native `junjo::` access across module boundaries. The
plugin compiles on Win64 (MSVC) and Linux (clang), its dedicated-server
target builds inside Epic's source-engine container, and a containerized
server made authenticated API calls against a live backend with a
negative control to prove the traffic was real.

**Phase 10, final pass.** This report, a code-verified cross-SDK feature
matrix, a site-wide documentation coherence pass, and final security,
engineering, and adversarial reviews with their fixes.

Phases 8 (Java SDK) and 9 (Paper integration) were cut from this pass by
your direction. They are deferred, not abandoned; the natural next pass
picks them up.

## Verification

Every phase gated before it closed. The final sweep, all green:

- Style gate clean across 687 files; Biome clean; typecheck clean.
- TypeScript and server suites: 280 shared, 502 SDK, 1641 server, 36
  React, 42 Roblox-adjacent.
- Roblox Luau suite: 143 via lune.
- C++ suite: 262 cases, Debug and Release.
- Unreal plugin: compiles on Win64 and Linux; dedicated server built and
  smoke-tested with live authenticated traffic in a container.
- Docs build: all pages; nine diagrams byte-locked; vendored Unreal
  mirror byte-locked (46 files).

Two independent final reviews (a security review and an engineering and
adversarial review) found no critical or high security issues. The
credential, authorization, tenant-isolation, injection, and crypto cores
were judged well built and consistent across all five SDKs. The
engineering review verified 23 of 24 spot-checked feature-matrix cells,
all version numbers, and wire-contract parity, and found commit hygiene
clean. Every legitimate finding was fixed; the fixes are in the same
batch as this report.

## Cross-SDK asymmetries worth knowing

Two gaps the reviews flagged were closed before publish: the C++ SDK
gained `bulk_invite` and `invite_by_link` (reaching the Unreal native
surface too), and the Roblox error object gained `requestId` and
`retryAfterSeconds`. What remains is deliberate:

- The Roblox SDK is the only one with an automatic retry policy, an
  opt-in idiom tuned for HttpService budgets. The other SDKs never retry
  automatically by design.
- The Unreal Blueprint surface is a declared subset (the representative
  gameplay path); everything else is reachable through the native
  client. Per-group ban and unban and member reads are the most
  gameplay-shaped candidates for the next Blueprint slice.
- Webhook unknown-event-type handling differs by design: the TypeScript
  SDK rejects by default with a `"raw"` opt-in, the C++ SDK verifies
  verbatim always. Documented per SDK.
- The Express-style webhook receiving middleware is TypeScript-only (it
  is a Node framework helper); every SDK that can receive webhooks has
  the verification and signing primitives.
- Platform limits, not gaps: Roblox has no SSE (HttpService cannot
  stream) and no webhook receiving (a Roblox server cannot accept HTTP).

## Residual risks

The three the reviews raised have been addressed:

1. **`TRUST_PROXY`.** Resolved. It was unset on the production API service
   (`junjo-server`), so per-source rate limiting had collapsed to one
   shared bucket. It is now set to `true`, so the limiter keys on the
   real client hop behind Railway's edge.
2. **Single-process ceiling.** Out of scope by decision. The in-memory
   rate limiter and SSE event hub only matter when more than one API
   instance runs; production is a single instance today, and this is a
   server-side scale concern with no effect on the SDKs or their
   consumers. Revisit only when the API scales out; webhook delivery is
   durable either way (transactionally staged on the mutation routes).
3. **Web-facing hardening.** Closed. Webhook delivery now validates and
   pins the resolved IP at connect time, rejecting every reserved range
   including cloud metadata, so the DNS-rebind window is closed; it
   already refused redirects and never returns the response body to the
   tenant. The `rojo` and `lune` binaries that build the Roblox release
   artifact are now verified by pinned SHA-256 in CI.

## Decisions for you

- **npm publish** is ready. The name is secured, the packaging bug the
  review found is already fixed in the tree, and the only steps left are
  the version bump and the publish itself, which needs your interactive
  2FA passkey (it cannot run headless).
- **Changesets**: four are staged (sdk, shared, and react minors plus a
  react patch), which take those packages to 0.2.0. Review before
  bumping. The C++ and Roblox SDKs have not shipped a release, so their
  new surface lands in a first release with no version churn.
- **Roblox release**: the first `roblox-v0.1.0` tag is your call; the
  workflow and version lockstep are ready.
- **Railway for the Unreal server**: `railway up` cannot carry a UE
  server (a 300 MB compressed-context cap); deploy a prebuilt image by
  registry reference instead. The runtime image is proven locally; the
  end-to-end Railway deploy awaits your choice of registry (an ephemeral
  registry for a one-off proof, or your own private registry).
- **Quick manual checks**: the Roblox Studio Secret prefix path is a
  five-minute in-Studio verification; the C++ shared-library warning
  suppression (C4251) and the UE 5.4 floor compile are small follow-ups
  if you want those claims hardened.
- **Deferred SDKs**: Java (`io.junjo:sdk`) and Paper (`io.junjo:paper`)
  whenever you want the next pass.

## Deferred and backlog

Shared cross-SDK test fixtures (the HMAC vectors are currently
hand-duplicated but in sync), a `before`-aware pagination helper for the
C++ audit listing, Unreal structs for invitations, ban output, and friend
requests, and webhook secret rotation. Two `TODO`s remain repo-wide, both
deliberate: the C++ timestamp chrono decision and curl handle pooling.

The program stops here, as specified. The Unreal MMORPG was explicitly
out of scope and was not begun.
