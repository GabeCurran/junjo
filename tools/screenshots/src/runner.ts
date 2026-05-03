import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import puppeteer, { type Browser } from "puppeteer";
import { renderIndexMd } from "./index-md.ts";
import type { CapturedScreenshot, CrawlConfig, RouteSpec, Viewport } from "./types.ts";

export type RunOptions = {
  config: CrawlConfig;
  routes: readonly RouteSpec[];
  outDir: string;
  baseUrl: string;
};

export async function runCrawl(opts: RunOptions): Promise<CapturedScreenshot[]> {
  const browser = await puppeteer.launch({ headless: true });
  const captures: CapturedScreenshot[] = [];
  try {
    for (const route of opts.routes) {
      for (const viewport of opts.config.viewports) {
        const c = await captureOne({
          browser,
          baseUrl: opts.baseUrl,
          route,
          viewport,
          area: opts.config.area,
          outDir: opts.outDir,
          basicAuth: opts.config.basicAuth,
        });
        captures.push(c);
      }
    }
    await writeIndex(opts.config.area, opts.outDir, captures);
  } finally {
    await browser.close();
  }
  return captures;
}

type CaptureArgs = {
  browser: Browser;
  baseUrl: string;
  route: RouteSpec;
  viewport: Viewport;
  area: string;
  outDir: string;
  basicAuth?: { username: string; password: string };
};

async function captureOne(args: CaptureArgs): Promise<CapturedScreenshot> {
  const page = await args.browser.newPage();
  try {
    await page.setViewport({
      width: args.viewport.width,
      height: args.viewport.height,
      deviceScaleFactor: args.viewport.deviceScaleFactor ?? 1,
      isMobile: args.viewport.isMobile ?? false,
    });
    if (args.basicAuth) {
      await page.authenticate(args.basicAuth);
    }
    const url = joinUrl(args.baseUrl, args.route.path);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    if (args.route.waitFor) {
      await page.waitForSelector(args.route.waitFor, { timeout: 10_000 });
    }
    const filePath = join(args.outDir, `${args.route.slug}.${args.viewport.name}.png`);
    await mkdir(dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath as `${string}.png`, fullPage: true });
    return {
      area: args.area,
      routeSlug: args.route.slug,
      routePath: args.route.path,
      routeDescription: args.route.description,
      viewport: args.viewport.name,
      filePath,
    };
  } finally {
    await page.close();
  }
}

async function writeIndex(
  area: string,
  outDir: string,
  captures: CapturedScreenshot[],
): Promise<void> {
  const md = renderIndexMd(area, captures);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "INDEX.md"), md, "utf8");
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}
