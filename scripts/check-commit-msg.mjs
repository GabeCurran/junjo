// commit-msg hook: reject commits whose message violates project rules.
//
// Wired up via simple-git-hooks (see package.json). Git invokes this with
// the path to the staged commit message file as argv[2]; we read, scan,
// exit 0 on clean, exit 1 with a clear explanation on violation.
//
// Run manually:  node scripts/check-commit-msg.mjs <path-to-msg-file>

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("check-commit-msg: no message-file path supplied");
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(path, "utf8");
} catch (err) {
  console.error(`check-commit-msg: could not read ${path}: ${err.message}`);
  process.exit(1);
}

// Comment lines (git's # prefix) get stripped before the message is
// stored, so don't enforce against them. Also ignore the trailing
// blank line git always appends.
const msg = raw
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .join("\n");

const FORBIDDEN = [
  {
    name: "Co-Authored-By trailer",
    regex: /^co-authored-by:/im,
    fix: "Drop the trailer. Gabe's OSS contributions could be voided by AI-attribution. See memory feedback_no_coauthor_commits.md.",
  },
  {
    name: "em dash (U+2014)",
    regex: /—/,
    fix: "Use a hyphen (-), pair of hyphens (--), comma, or rephrase. See memory feedback_no_em_dashes.md.",
  },
  {
    name: "en dash (U+2013)",
    regex: /–/,
    fix: "Use a hyphen (-) instead.",
  },
];

const violations = [];
for (const rule of FORBIDDEN) {
  if (rule.regex.test(msg)) {
    violations.push(rule);
  }
}

if (violations.length === 0) {
  process.exit(0);
}

console.error("");
console.error("commit-msg hook: commit message rejected");
console.error("=========================================");
for (const v of violations) {
  console.error(`  X ${v.name}`);
  console.error(`    ${v.fix}`);
}
console.error("");
console.error("Message that was rejected:");
console.error("---");
console.error(msg.trim());
console.error("---");
console.error("");
console.error("Fix the message and re-run the commit. Use --no-verify only if you");
console.error("are absolutely sure; Gabe's preference is that this never happen.");
process.exit(1);
