export type CliArgs = {
  target: string;
  base?: string;
  route?: string;
  viewport?: string;
  outDir?: string;
};

export class ArgsError extends Error {}

export function parseArgs(argv: readonly string[]): CliArgs {
  const opts: Record<string, string> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) {
      throw new ArgsError(`unexpected positional argument: ${raw}`);
    }
    const eq = raw.indexOf("=");
    if (eq === -1) {
      throw new ArgsError(`expected --key=value form, got: ${raw}`);
    }
    const key = raw.slice(2, eq);
    const value = raw.slice(eq + 1);
    if (!key) {
      throw new ArgsError(`empty flag name in: ${raw}`);
    }
    opts[key] = value;
  }
  const target = opts.target;
  if (!target) {
    throw new ArgsError("missing required --target=<name>");
  }
  const result: CliArgs = { target };
  if (opts.base) result.base = opts.base;
  if (opts.route) result.route = opts.route;
  if (opts.viewport) result.viewport = opts.viewport;
  if (opts["out-dir"]) result.outDir = opts["out-dir"];
  return result;
}
