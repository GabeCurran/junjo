// Style lint: forbid em-dashes, en-dashes, and emoji characters in tracked
// source files. Two reasons: (1) em-dash mojibake in PowerShell 5.1 has
// already burned us once; (2) Gabe's preference is plain ASCII in code/docs.
//
// Run: node scripts/check-style.mjs
// Exits 0 on clean, 1 on any violation.

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const FORBIDDEN = [
  { name: "em-dash (U+2014)", regex: /—/g, fix: "use '-' or rephrase" },
  { name: "en-dash (U+2013)", regex: /–/g, fix: "use '-' or rephrase" },
  // Emoji blocks. Cast a wide net; if a legitimate need arises, escape as \uXXXX.
  {
    name: "emoji",
    regex:
      /[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}]/gu,
    fix: "remove or escape as \\u{XXXX} inside a string literal",
  },
];

// Skip these tracked paths entirely.
const SKIP_FILES = new Set(["scripts/check-style.mjs", "package-lock.json"]);

// Skip these extensions (binary or auto-generated).
const SKIP_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".zip",
  ".gz",
  ".rbxm",
  ".rbxmx",
]);

function listTrackedFiles() {
  const out = execSync("git ls-files", { encoding: "utf8" });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isText(path) {
  if (SKIP_FILES.has(path)) return false;
  if (SKIP_EXTS.has(extname(path).toLowerCase())) return false;
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
  } catch {
    return false;
  }
  return true;
}

function checkFile(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const violations = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { name, regex, fix } of FORBIDDEN) {
      regex.lastIndex = 0;
      let m = regex.exec(line);
      while (m !== null) {
        violations.push({
          file: path,
          line: i + 1,
          col: m.index + 1,
          name,
          char: m[0],
          codepoint: `U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
          fix,
        });
        m = regex.exec(line);
      }
    }
  }
  return violations;
}

const files = listTrackedFiles().filter(isText);
const allViolations = [];
for (const f of files) {
  const v = checkFile(f);
  allViolations.push(...v);
}

if (allViolations.length === 0) {
  console.log(`style: clean (${files.length} files scanned)`);
  process.exit(0);
}

console.error("Style violations found:");
console.error("");
for (const v of allViolations) {
  console.error(`  ${v.file}:${v.line}:${v.col}  ${v.name} ${v.codepoint}  ->  ${v.fix}`);
}
console.error("");
console.error(
  `${allViolations.length} violation(s) across ${new Set(allViolations.map((v) => v.file)).size} file(s).`,
);
process.exit(1);
