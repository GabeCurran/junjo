// One-shot refactor: hoist per-describe `PrismaClient` instantiation to a
// single module-level instance per test file (Phase 14.0).
//
// For each input file:
//   1. Insert `let prisma: PrismaClient;` after the `const TEST_DATABASE_URL = ...` line.
//   2. Insert top-level `beforeAll` (connect) and `afterAll` (disconnect) just below,
//      both gated on TEST_DATABASE_URL.
//   3. Strip every per-describe `let prisma: PrismaClient;` declaration.
//   4. Strip every `prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });`
//      assignment inside describe blocks.
//   5. Strip every per-describe `afterAll(async () => { await prisma.$disconnect(); });` block
//      (the only non-trivial bit; matches the canonical 3-line shape with optional indent).
//
// Files that already match (single `new PrismaClient` outside a describe block)
// pass through untouched.
//
// Run: `node scripts/refactor-test-prisma.mjs`. Idempotent: re-running on an
// already-refactored file is a no-op.

import fs from "node:fs";

const FILES = [
  "packages/server/src/routes/groups.test.ts",
  "packages/server/src/routes/admin.test.ts",
  "packages/server/src/routes/roles.test.ts",
  "packages/server/src/routes/admin.rowActions.test.ts",
  "packages/server/src/routes/invitations.test.ts",
  "packages/server/src/routes/admin.roles.test.ts",
  "packages/server/src/routes/admin.permissions.test.ts",
  "packages/server/src/routes/members.test.ts",
];

function refactor(src) {
  let out = src;

  // Idempotency check: if there's a top-level `let prisma` already, skip.
  if (/^let prisma: PrismaClient;$/m.test(out)) {
    return out;
  }

  // Strip first, inject second. Order matters: the injected module-level
  // beforeAll body contains `prisma = new PrismaClient(...)` with two-space
  // indent, which would itself be eaten by the strip step if it ran after.

  // (1) Strip per-describe `let prisma: PrismaClient;` lines (any indent).
  out = out.replace(/^[ \t]+let prisma: PrismaClient;\n/gm, "");

  // (2) Strip per-describe `prisma = new PrismaClient(...)` assignments.
  out = out.replace(
    /^[ \t]+prisma = new PrismaClient\(\{ datasources: \{ db: \{ url: TEST_DATABASE_URL \} \} \}\);\n/gm,
    "",
  );

  // (3) Strip per-describe `afterAll(async () => { await prisma.$disconnect(); });`
  // blocks (handles optional indent). Drop a trailing blank line if present so
  // the file stays free of double-blanks.
  out = out.replace(
    /^[ \t]+afterAll\(async \(\) => \{\n[ \t]+await prisma\.\$disconnect\(\);\n[ \t]+\}\);\n(\n)?/gm,
    "",
  );

  // (4) Inject module-level state right after the TEST_DATABASE_URL block.
  // Walk forward through blank lines and additional top-level consts; stop at
  // the first non-(blank / top-level const) line so adjacent `ADMIN_TOKEN`
  // declarations stay above the new state.
  const lines = out.split("\n");
  let testDbIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;")) {
      testDbIdx = i;
      break;
    }
  }
  if (testDbIdx === -1) throw new Error("could not find TEST_DATABASE_URL line");
  let insertAfter = testDbIdx;
  for (let i = testDbIdx + 1; i < lines.length; i += 1) {
    const ln = lines[i];
    if (ln === "") continue;
    if (/^const [A-Za-z_][A-Za-z0-9_]* ?(:|=)/.test(ln)) {
      insertAfter = i;
      continue;
    }
    break;
  }
  const inject = [
    "",
    "let prisma: PrismaClient;",
    "",
    "beforeAll(() => {",
    "  if (!TEST_DATABASE_URL) return;",
    "  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });",
    "});",
    "",
    "afterAll(async () => {",
    "  if (!TEST_DATABASE_URL) return;",
    "  await prisma.$disconnect();",
    "});",
  ];
  lines.splice(insertAfter + 1, 0, ...inject);
  out = lines.join("\n");

  return out;
}

let totalChanged = 0;
for (const f of FILES) {
  const before = fs.readFileSync(f, "utf8");
  const after = refactor(before);
  if (before === after) {
    console.log(`unchanged: ${f}`);
    continue;
  }
  fs.writeFileSync(f, after, "utf8");
  totalChanged += 1;
  console.log(`refactored: ${f}`);
}
console.log(`\n${totalChanged} file(s) refactored.`);
