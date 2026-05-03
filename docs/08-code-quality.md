# Junjo V1 code quality audit

This is the pre-launch code quality review of Junjo V1, completed under Phase 14.15. It documents the lint rules, TypeScript strictness flags, and code style conventions that govern the codebase, what was tightened in this same phase, and what was deferred (with reasons).

The companion documents are:

- `docs/05-decisions.md` - the design decision log; this audit drops one entry there.
- `docs/06-security.md` - the V1 security posture (Phase 14.13).
- `docs/07-api-review.md` - the V1 API consistency audit (Phase 14.14).
- `docs/03-architecture.md` - the system-level architecture.

## Scope

Every TypeScript source file under `packages/{shared,sdk,react,server}/src/**`, `apps/{dashboard,docs}/**`, and `examples/**`. The audit covered:

- Lint configuration (`biome.json`, plus the custom `scripts/check-style.mjs` enforced by `verify.ps1`).
- TypeScript strictness flags (`tsconfig.base.json` plus the four package tsconfigs and the two app tsconfigs that intentionally don't extend the base).
- Test discipline (`*.test.ts` co-location, vitest configuration, presence of `--passWithNoTests`).
- File-level conventions (license headers, ESM-only `"type": "module"`, package export shape, branded id usage at API boundaries).
- The use of escape hatches: `// biome-ignore`, `as any`, `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, non-null assertions (`!`), `// TODO` / `// FIXME` / `// HACK` markers.

The framing question for each finding was: "if a contributor introduces a regression in this dimension tomorrow, will the existing gate catch it?" If the answer is no, the gate gets tightened or the finding goes on the deferred list with a reason.

## Methodology

1. Read `biome.json` and `tsconfig.base.json`; cross-reference each package's tsconfig to find drift from the base.
2. Walk every `.ts` / `.tsx` file under `packages/{shared,sdk,react,server}/src/**` and `apps/{dashboard,docs}/**` for the escape-hatch patterns above; tabulate counts and verify each occurrence is justified by an inline comment.
3. Run `npx biome lint .` with `--diagnostic-level=info` to expose any silent-warn diagnostics; flag any not visible to the verify gate.
4. Run `npx tsc --noEmit` in each package with three additional flags one at a time (`--noUnusedLocals`, `--noUnusedParameters`, `--noImplicitReturns`); collect any new errors as candidates for tightening.
5. Categorize findings by severity:
   - **Severe** - existing escape hatches that hide real bugs, or settings that diverge across packages in a way that defeats the gate.
   - **Moderate** - low-cost tightening that catches future-class regressions cheaply.
   - **Minor** - document or accept.

## What is consistent (preserve these)

These conventions are uniform across the codebase and worth defending in code review going forward.

| Convention | Status |
|--|--|
| `"type": "module"` on every workspace | All four publishable packages plus the two apps. ESM-first. |
| `strict: true` + `noUncheckedIndexedAccess: true` | All four package tsconfigs (via `tsconfig.base.json`) and both app tsconfigs (set directly). |
| `verbatimModuleSyntax: true` | Set in `tsconfig.base.json`; enforces `import type` for type-only imports. |
| Co-located tests (`src/**/*.test.ts`) | Every test file lives next to the source it covers; no `tests/` or `__tests__/` directories. |
| `vitest run --passWithNoTests` | Every package's `test` script is uniform; the verify gate runs `npm test` at the workspace root. |
| Style lint (`scripts/check-style.mjs`) | Forbids em-dashes (U+2014), en-dashes (U+2013), and emoji codepoints across all tracked text files. Wired into `verify.ps1` as the first gate. |
| Branded id types at API boundaries | `GroupId` / `UserId` / `GameId` / etc. cast via `as GroupId` from raw strings in route handlers; the SDK consumes the branded types. |
| No raw `console.log` in `packages/server/src/**` | All log lines route through `packages/server/src/logger.ts` (Phase 14.2). |
| No `// TODO` / `// FIXME` / `// HACK` markers | Zero occurrences across `packages/**` and `apps/**`. |
| Every `// biome-ignore` carries a reason after the colon | All 11 occurrences (8 in adapter tests for runtime-bad-value coverage, 2 in `testdb.test.ts` for env unset, 1 in `mobile-nav.tsx` for a deliberately incomplete dep array) have a reason string. |
| Every `as any` is paired with a `// biome-ignore` | Verified via grep; no orphan `as any` casts. |

## Findings

### Severe (fixed in this phase)

**14.15-S1. `tsconfig.base.json` did not enable `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns`.**

The base tsconfig set `strict: true` plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, but stopped short of the dead-code and implicit-return flags. The verify gate could not catch unused locals or parameters; biome's `noUnusedVariables` recommended-set rule overlaps but does not catch unused parameters when `--noUnusedParameters` does (function parameters that get destructured but never read).

The audit found three concrete dead-code violations that the existing gate had been missing:

- `packages/server/src/routes/admin.roles.test.ts:91` - a `const member = await prisma.role.create(...)` whose binding was never referenced (the test only asserted the role's *name* in the sorted output, not the local binding).
- `packages/server/src/routes/groups.ts:23` - an unused `toPublicMember` import in the events module.
- `packages/sdk/src/subscribe.test.ts:2` - an unused `GameId` type import.

**Fix shipped.** All three dead-code occurrences removed. `tsconfig.base.json` now sets `noUnusedLocals: true`, `noUnusedParameters: true`, `noImplicitReturns: true`. `apps/dashboard/tsconfig.json` and `apps/docs/tsconfig.json` (which don't extend the base because of the Next.js plugin requirement) had the same three flags added directly so the strictness is uniform across all six TypeScript-checked workspaces.

The verify gate (`npm run typecheck`) now catches future regressions of all three classes immediately.

### Moderate (fixed in this phase)

**14.15-M1. `biome.json` had `noNonNullAssertion: "warn"` instead of `"error"`.**

Biome's default warn-level rules do not fail `biome check` (the verify gate only fails on errors). A warn-level rule is effectively a no-op for the gate. The audit found zero existing non-null assertions in the codebase (verified by grep across all `.ts` / `.tsx` under `packages/` and `apps/`), so upgrading `warn` to `error` is purely future-defense: the next time someone reaches for `something!.field` instead of an explicit narrowing or default, the gate trips.

**Fix shipped.** `biome.json` sets `noNonNullAssertion: "error"`. No code changes required; the rule had nothing to flag.

### Minor (documented and accepted)

**14.15-D1. `apps/dashboard/tsconfig.json` and `apps/docs/tsconfig.json` do not `extends: tsconfig.base.json`.**

The Next.js TypeScript plugin (`{ "name": "next" }`) requires fields that conflict with the base config's `module: "ESNext"` + `moduleResolution: "bundler"` + `verbatimModuleSyntax: true` defaults; in particular `verbatimModuleSyntax` collides with the way Next handles `_app.tsx` and Server Component imports. The two app tsconfigs intentionally duplicate the strictness flags (`strict`, `noUncheckedIndexedAccess`, and as of this phase `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns`) instead of inheriting them.

The trade-off: any future tightening in `tsconfig.base.json` must be mirrored manually into both app tsconfigs. The audit accepts this duplication (Next.js plugin compatibility outranks DRY here) and documents it so morning-Gabe and any future contributor know the duplication is deliberate, not drift.

**14.15-D2. `exactOptionalPropertyTypes: false` and `noPropertyAccessFromIndexSignature: false`.**

Both flags are set explicitly in `tsconfig.base.json`. Tightening either would force a wide refactor of optional-field call sites and dynamic property access throughout the codebase (notably in `routes/admin.ts`'s analytics queries that build dynamic Prisma where-clauses, and in `packages/sdk/src/http.ts`'s header object construction). The cost is high; the benefit is theoretical (type-safety improvements that current tests + branded-id discipline already cover in practice).

Deferred to V2 with the audit on record. If a future major refactor of the affected modules naturally touches the call sites, the flag flip is a fine ride-along.

**14.15-D3. The 8 `as any` casts in adapter tests.**

All 8 occurrences live in `packages/sdk/src/adapters/{clerk,jwt,supabase}.test.ts` and exist deliberately to test how the adapters handle bad runtime values: `verifyToken(undefined as any)`, `clerkAdapter({ verifyToken: "not a function" as any })`, `jwtAdapter({ algorithm: "RS512" as any })`. Each is paired with a `// biome-ignore lint/suspicious/noExplicitAny` comment explaining "testing a bad runtime value." The casts are the only way to reach the runtime guard branches in the adapter implementations; without them, TypeScript would reject the test inputs at compile time and the guard branches would be untestable.

Accepted as-is. The pattern is documented in the comments and is the canonical way to test runtime-defensive code.

**14.15-D4. The 2 `// biome-ignore lint/performance/noDelete` annotations in `packages/server/src/testdb.test.ts`.**

`testdb.test.ts` exercises `process.env.TEST_DATABASE_URL` resolution; the test must distinguish "env var unset" from "env var set to empty string" and from "env var set to the literal string `undefined`." Assigning `undefined` to a `process.env` slot coerces to the string `"undefined"`. `delete process.env.TEST_DATABASE_URL` is the only way to actually unset the slot. Biome's `noDelete` performance rule flags it; the ignore comments explain why the rule is the wrong fit here.

Accepted. The annotations are correct.

**14.15-D5. The 1 `// biome-ignore lint/correctness/useExhaustiveDependencies` in `apps/dashboard/components/dashboard/mobile-nav.tsx`.**

The effect intentionally re-runs when `pathname` changes but does not consume `pathname` inside the body (the body closes the mobile drawer; `pathname` is purely the trigger). Biome's exhaustive-deps rule wants every dep referenced in the body. The annotation explains the trigger-not-consumed pattern.

Accepted. The annotation is precise.

**14.15-D6. `verbatimModuleSyntax` is enabled in the base tsconfig but the apps don't inherit it.**

See D1. The Next.js plugin doesn't tolerate `verbatimModuleSyntax: true` in its current 14.x line; the apps elide the flag deliberately. The packages still enforce it (so the public TypeScript surface that ships to users requires `import type` discipline), and the apps are runtime-only consumers where the lack of strict type-import enforcement has no public-surface impact.

Documented and accepted.

## Re-audit cadence

This audit is a frozen-in-time artifact. Trigger a re-audit if any of the following happen:

- A new TypeScript flag is added to `tsconfig.base.json` (the apps' duplicates need to be checked for drift in lockstep).
- The Biome version is bumped to 2.x; the rule names and severity defaults change in major lines.
- A new package is added to the workspace; verify it extends `tsconfig.base.json` (or, if it can't, that it duplicates the strictness flags explicitly).
- The verify gate is restructured; confirm `npm run typecheck` and `biome check` both still run as separate steps.

The audit doc itself does not auto-update; the Phase 14.15 sub-task is one-and-done. If V1 GA reveals a class of bug the audit missed, that's a Phase 14.x' (post-GA hardening) trigger.

## Bottom line

V1 ships with `strict: true` + `noUncheckedIndexedAccess: true` everywhere, dead-code detection on, non-null assertions blocked, em-dashes / en-dashes / emoji blocked, and zero `TODO` / `FIXME` / `HACK` markers in `packages/**` or `apps/**`. The 11 escape-hatch annotations are all justified, all paired with a reason, and all in the smallest possible scope. The two-flag deferral (`exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`) is on record with rationale.

The remaining V1 code-quality risk is the manual duplication of strictness flags between `tsconfig.base.json` and the two app tsconfigs; the audit doc captures the trade-off and the future-tightening checklist so the duplication doesn't silently drift.
