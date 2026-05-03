import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CrawlConfig } from "./types.ts";

export type LoadedConfig = {
  config: CrawlConfig;
  sourcePath: string;
};

export async function loadConfig(target: string, configsDir?: string): Promise<LoadedConfig> {
  const dir = configsDir ?? defaultConfigsDir();
  const candidate = join(dir, `${target}.ts`);
  if (!existsSync(candidate)) {
    const known = listConfigs(dir);
    throw new Error(
      `no screenshot config for target "${target}". expected ${candidate}. known targets: ${known.join(", ") || "(none)"}`,
    );
  }
  const mod = (await import(pathToFileURL(candidate).href)) as { default?: CrawlConfig };
  if (!mod.default) {
    throw new Error(`config ${candidate} must export a default CrawlConfig`);
  }
  return { config: mod.default, sourcePath: candidate };
}

function defaultConfigsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "configs");
}

export function listConfigs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3))
    .sort();
}
