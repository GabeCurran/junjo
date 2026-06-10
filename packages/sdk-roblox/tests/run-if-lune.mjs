// npm "test" entry for the Roblox SDK workspace. The Luau tests run on
// lune (a standalone Luau runtime: https://github.com/lune-org/lune),
// which most local dev machines will not have installed. Detect it and
// skip with a clear message instead of failing, so the root
// `npm run test --workspaces --if-present` stays green without lune.
// CI installs a pinned lune and runs the suite for real (see
// .github/workflows/roblox-release.yml).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run from the package root regardless of the caller's cwd; the Luau
// runner resolves `src/` and `package.json` relative to it.
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const useShell = process.platform === "win32";

const probe = spawnSync("lune", ["--version"], { shell: useShell });
if (probe.error || probe.status !== 0) {
  console.log(
    "sdk-roblox: skipping Luau tests (lune not found on PATH). " +
      "Install lune to run them locally: https://github.com/lune-org/lune",
  );
  process.exit(0);
}

const run = spawnSync("lune", ["run", "tests/run.luau"], {
  cwd: packageRoot,
  shell: useShell,
  stdio: "inherit",
});
process.exit(run.status ?? 1);
