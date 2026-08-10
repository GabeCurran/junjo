// Style lint: forbid em-dashes, en-dashes, and emoji characters in tracked
// source files. Em-dash mojibake breaks under PowerShell 5.1 console
// encoding, and the project standard is plain ASCII in code and docs.
//
// Scoped rule for .mdx files: the sequence " -- " (space, two hyphens,
// space) is forbidden outside fenced code blocks. The docs site typographs
// it into a dash glyph at render time, which reintroduces the dashes the
// rules above forbid. Fenced code blocks are exempt (shell `--` argument
// separators, Lua comments, mermaid edge syntax), and inline code spans
// (backtick-delimited, incl. multi-backtick forms) are stripped from a
// line before it is scanned. Fence tracking is line-based and remembers
// the opening fence's character and length, so a ~~~ line inside a
// ```-fence (or ``` inside a ````-fence) does not mis-toggle. Known
// limitation: indented code blocks and indented fences are not modeled;
// any leading-whitespace ``` / ~~~ run toggles fence state.
//
// Scoped rule for .md and .mdx files: a spaced single hyphen splicing
// two clauses mid-sentence ("this - that") is forbidden in prose. It is
// a dash-style separator in disguise; use a comma, colon, semicolon,
// parentheses, or split the sentence. The scan shares the fence model
// and inline-code stripping above, and additionally exempts:
//   - list markers (lines starting with optional whitespace then "- ")
//   - table rows (any line containing "|" after inline code is stripped)
//   - numeric ranges and arithmetic ("1 - 100"): the rule only fires
//     when a letter sits on both sides of the hyphen (an optional
//     closing quote/paren/backtick may trail the left letter, and an
//     opening one may precede the right letter)
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
// `check-commit-msg.mjs` is skipped because its job is to reject these
// characters in commit messages, which forces it to embed them in its
// regex literals.
const SKIP_FILES = new Set([
  "scripts/check-style.mjs",
  "scripts/check-commit-msg.mjs",
  "package-lock.json",
]);

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

// .mdx-only rule: " -- " outside fenced code blocks renders as a dash
// glyph on the docs site. Fence-aware line scan; a line that opens or
// closes a fence is itself exempt, and inline code spans are stripped
// before the scan (see the header comment for the fence model).
const MDX_SEPARATOR = {
  name: 'spaced double hyphen " -- " (MDX prose)',
  fix: "use a colon, semicolon, parentheses, or split the sentence",
};

// .md/.mdx rule: a spaced single hyphen splicing clauses mid-sentence.
// Fires only with a letter on each side of the hyphen so numeric ranges
// and arithmetic ("1 - 100") stay legal; list markers and table rows are
// exempted at the line level in checkProseSeparators.
const HYPHEN_SEPARATOR = {
  name: 'spaced single hyphen " - " clause separator (md/mdx prose)',
  fix: "use a comma, colon, semicolon, parentheses, or split the sentence",
};
const HYPHEN_SEPARATOR_RE = /[A-Za-z][)"'`]? - ["'`(]?[A-Za-z]/g;

// Replace inline code spans with same-length filler so commands like
// `npm run x -- --flag` are not scanned, while reported columns stay
// aligned with the source line. A span opens with a run of backticks
// and closes with a run of the same length; the (?!`) keeps a longer
// closing run from terminating a shorter opener mid-run. The filler
// contains no spaces or hyphens, so stripping cannot manufacture a
// " -- " that was not in the prose.
function stripInlineCode(line) {
  return line.replace(/(`+)(.*?)\1(?!`)/g, (m) => "x".repeat(m.length));
}

function checkProseSeparators(path, lines, { doubleHyphen }) {
  const violations = [];
  // Non-null while inside a fenced code block: the opening fence's
  // character ("`" or "~") and run length.
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const run = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence !== null) {
      if (run !== null && run[1][0] === fence.char && run[1].length >= fence.len) {
        fence = null; // closing fence: same char, at least as long
      }
      continue;
    }
    if (run !== null) {
      fence = { char: run[1][0], len: run[1].length };
      continue;
    }
    const scannable = stripInlineCode(line);
    if (doubleHyphen) {
      let idx = scannable.indexOf(" -- ");
      while (idx !== -1) {
        violations.push({
          file: path,
          line: i + 1,
          col: idx + 1,
          name: MDX_SEPARATOR.name,
          char: "--",
          codepoint: "U+002D U+002D",
          fix: MDX_SEPARATOR.fix,
        });
        idx = scannable.indexOf(" -- ", idx + 1);
      }
    }
    // Spaced single hyphen: skip list markers and table rows outright.
    if (/^\s*- /.test(line)) continue;
    if (scannable.includes("|")) continue;
    HYPHEN_SEPARATOR_RE.lastIndex = 0;
    let m = HYPHEN_SEPARATOR_RE.exec(scannable);
    while (m !== null) {
      violations.push({
        file: path,
        line: i + 1,
        col: m.index + 1,
        name: HYPHEN_SEPARATOR.name,
        char: "-",
        codepoint: "U+002D",
        fix: HYPHEN_SEPARATOR.fix,
      });
      m = HYPHEN_SEPARATOR_RE.exec(scannable);
    }
  }
  return violations;
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
  const ext = extname(path).toLowerCase();
  if (ext === ".mdx" || ext === ".md") {
    violations.push(...checkProseSeparators(path, lines, { doubleHyphen: ext === ".mdx" }));
  }
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
