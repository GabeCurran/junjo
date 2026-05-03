import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArgsError, parseArgs } from "./args.ts";
import { discoverSources } from "./discover-sources.ts";
import { type RenderTask, buildRenderPlan } from "./render-plan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, "..");
const DEFAULT_SOURCE_DIR = resolve(workspaceRoot, "source");
const DEFAULT_OUT_DIR = resolve(workspaceRoot, "output");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = args.sourceDir ? resolve(args.sourceDir) : DEFAULT_SOURCE_DIR;
  const outDir = args.outDir ? resolve(args.outDir) : DEFAULT_OUT_DIR;
  const format = args.format ?? "png";

  const sources = discoverSources(sourceDir);
  if (sources.length === 0) {
    console.log(`no .mmd sources found in ${sourceDir}`);
    return;
  }

  const tasks = buildRenderPlan({ sources, outDir, format, filterSlug: args.file });
  mkdirSync(outDir, { recursive: true });

  console.log(`rendering ${tasks.length} diagram(s) to ${outDir}`);
  for (const task of tasks) {
    await renderOne(task);
    console.log(`  ${task.slug} -> ${task.output}`);
  }
}

function renderOne(task: RenderTask): Promise<void> {
  // `npx mmdc` resolves the binary from the nearest `node_modules/.bin/mmdc`,
  // which with npm workspaces lives at the repo root. Using `npx` (rather
  // than spawning `mmdc` directly) avoids depending on a globally-installed
  // mmdc and works the same way on Windows + POSIX.
  return new Promise((resolveP, rejectP) => {
    const child = spawn("npx", ["mmdc", "-i", task.source, "-o", task.output], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", rejectP);
    child.on("exit", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`mmdc exited with code ${code} for ${task.slug}`));
    });
  });
}

main().catch((err) => {
  if (err instanceof ArgsError) {
    console.error(`error: ${err.message}`);
    console.error("");
    console.error("usage: npm run diagrams [-- --file=<slug>] [-- --format=svg]");
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
