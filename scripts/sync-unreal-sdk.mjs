// Vendor sync for the Unreal plugin: mirror the canonical C++ SDK
// sources (packages/sdk-cpp) into the JunjoIO module's vendor tree.
// The vendored files must stay byte-identical to their canonical
// sources; any change lands in packages/sdk-cpp first and is then
// re-synced here.
//
// Vendor list:
//   - include/junjo/*  except curl_transport.hpp (curl is not used in
//     the Unreal plugin; the engine's HTTP module is the transport)
//   - src/*            except curl_transport.cpp
//   - the pinned nlohmann/json.hpp single header, sourced from the
//     sdk-cpp FetchContent checkout under build/_deps
//
// Default mode copies the list into the plugin and deletes stale
// vendored files that no longer have a canonical source. --check mode
// compares byte-for-byte and exits 1 listing any drifted, missing, or
// stale file; it never writes.
//
// The nlohmann canonical source only exists after a sdk-cpp CMake
// configure has run. When build/_deps is absent, both modes skip the
// json.hpp entry with a warning instead of failing, so the gate stays
// usable on a fresh checkout.
//
// Run: node scripts/sync-unreal-sdk.mjs [--check]
// Exits 0 on clean, 1 on any drift (--check) or copy failure.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = join(repoRoot, "packages", "sdk-cpp");
const vendorRoot = join(
  repoRoot,
  "packages",
  "sdk-unreal",
  "JunjoIO",
  "Source",
  "JunjoIO",
  "Private",
  "vendor",
);
const nlohmannCanonical = join(
  sdkRoot,
  "build",
  "_deps",
  "nlohmann_json-src",
  "single_include",
  "nlohmann",
  "json.hpp",
);

const checkMode = process.argv.includes("--check");

function rel(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

// Recursively lists every file under `dir` as a dir-relative path, so
// a subdirectory added to a canonical source tree is vendored instead
// of being silently dropped from the mirror.
function listFiles(dir) {
  const files = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : join(rel, entry.name);
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  };
  walk("");
  return files.sort();
}

// The mirrored file set: canonical absolute path -> vendored absolute
// path. curl transport files are excluded by name; everything else in
// the two canonical directories is vendored.
function buildFileMap() {
  const map = new Map();
  const includeDir = join(sdkRoot, "include", "junjo");
  for (const name of listFiles(includeDir)) {
    if (name === "curl_transport.hpp") continue;
    map.set(join(includeDir, name), join(vendorRoot, "junjo", "include", "junjo", name));
  }
  const srcDir = join(sdkRoot, "src");
  for (const name of listFiles(srcDir)) {
    if (name === "curl_transport.cpp") continue;
    map.set(join(srcDir, name), join(vendorRoot, "junjo", "src", name));
  }
  return map;
}

// Vendored files under vendor/junjo with no canonical counterpart.
// The nlohmann directory is governed separately (its canonical source
// may legitimately be absent), so it is not swept here.
function findStaleFiles(fileMap) {
  const expected = new Set(fileMap.values());
  const stale = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!expected.has(path)) stale.push(path);
    }
  };
  walk(join(vendorRoot, "junjo"));
  return stale;
}

function sameBytes(a, b) {
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.size !== sb.size) return false;
  return readFileSync(a).equals(readFileSync(b));
}

const fileMap = buildFileMap();
const nlohmannVendored = join(vendorRoot, "nlohmann", "json.hpp");
const nlohmannPresent = existsSync(nlohmannCanonical);
if (nlohmannPresent) {
  fileMap.set(nlohmannCanonical, nlohmannVendored);
} else {
  console.warn(
    `warning: ${rel(nlohmannCanonical)} not found (sdk-cpp has not been configured); skipping the nlohmann/json.hpp entry`,
  );
}

if (checkMode) {
  const problems = [];
  for (const [canonical, vendored] of fileMap) {
    if (!existsSync(vendored)) {
      problems.push({ file: vendored, reason: "missing from vendor tree" });
    } else if (!sameBytes(canonical, vendored)) {
      problems.push({ file: vendored, reason: `differs from ${rel(canonical)}` });
    }
  }
  for (const stale of findStaleFiles(fileMap)) {
    problems.push({ file: stale, reason: "stale: no canonical source in packages/sdk-cpp" });
  }
  if (problems.length === 0) {
    console.log(`unreal vendor sync: clean (${fileMap.size} files compared)`);
    process.exit(0);
  }
  console.error("Unreal vendor drift found:");
  console.error("");
  for (const p of problems) {
    console.error(`  ${rel(p.file)}  ->  ${p.reason}`);
  }
  console.error("");
  console.error(`${problems.length} file(s) out of sync. Run: node scripts/sync-unreal-sdk.mjs`);
  process.exit(1);
}

let copied = 0;
for (const [canonical, vendored] of fileMap) {
  mkdirSync(dirname(vendored), { recursive: true });
  copyFileSync(canonical, vendored);
  copied += 1;
}
let removed = 0;
for (const stale of findStaleFiles(fileMap)) {
  rmSync(stale);
  removed += 1;
}
const removedNote = removed > 0 ? `, ${removed} stale file(s) removed` : "";
console.log(`unreal vendor sync: ${copied} files copied${removedNote}`);
