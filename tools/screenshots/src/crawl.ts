import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArgsError, parseArgs } from "./args.ts";
import { loadConfig } from "./config-loader.ts";
import { startDevServer } from "./dev-server.ts";
import { resolveRoutes } from "./resolve-routes.ts";
import { filterRoutes } from "./route-filter.ts";
import { runCrawl } from "./runner.ts";

async function main(argv: readonly string[]): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgsError) {
      printUsage(err.message);
      process.exit(2);
    }
    throw err;
  }

  const { config } = await loadConfig(args.target);
  const outDir = args.outDir ?? defaultOutDir(args.target);

  let baseUrl = args.base ?? config.baseUrl;
  let stop: (() => Promise<void>) | undefined;
  if (!baseUrl && config.devServer) {
    const running = await startDevServer(config.devServer);
    baseUrl = running.baseUrl;
    stop = running.stop;
  }
  if (!baseUrl) {
    throw new Error(
      `no baseUrl resolved for target "${args.target}": pass --base=<url>, set config.baseUrl, or define config.devServer`,
    );
  }

  try {
    const baseRoutes = await resolveRoutes(config);
    const routes = filterRoutes(baseRoutes, args.route);
    const captures = await runCrawl({ config, routes, outDir, baseUrl });
    process.stdout.write(`captured ${captures.length.toString()} screenshot(s) to ${outDir}\n`);
  } finally {
    if (stop) await stop();
  }
}

function printUsage(error: string): void {
  process.stderr.write(`error: ${error}\n\n`);
  process.stderr.write(
    "usage: tsx src/crawl.ts --target=<name> [--base=<url>] [--route=<slug>] [--out-dir=<path>]\n",
  );
}

function defaultOutDir(area: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "output", area);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
