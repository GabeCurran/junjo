export type CliArgs = {
  file?: string;
  sourceDir?: string;
  outDir?: string;
  format?: "png" | "svg";
};

export class ArgsError extends Error {}

const KNOWN_FLAGS = new Set(["file", "source-dir", "out-dir", "format"]);

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
    if (!KNOWN_FLAGS.has(key)) {
      throw new ArgsError(`unknown flag: --${key}`);
    }
    opts[key] = value;
  }
  const result: CliArgs = {};
  if (opts.file) result.file = opts.file;
  if (opts["source-dir"]) result.sourceDir = opts["source-dir"];
  if (opts["out-dir"]) result.outDir = opts["out-dir"];
  if (opts.format) {
    if (opts.format !== "png" && opts.format !== "svg") {
      throw new ArgsError(`--format must be 'png' or 'svg', got: ${opts.format}`);
    }
    result.format = opts.format;
  }
  return result;
}
