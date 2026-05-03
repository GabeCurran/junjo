export type Viewport = {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
};

export type RouteSpec = {
  slug: string;
  path: string;
  description: string;
  waitFor?: string;
};

export type DevServer = {
  command: string;
  cwd: string;
  port: number;
  readyPath?: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
};

export type PrepareResult = {
  routes: RouteSpec[];
};

export type CrawlConfig = {
  area: string;
  baseUrl?: string;
  basicAuth?: { username: string; password: string };
  viewports: Viewport[];
  routes?: RouteSpec[];
  devServer?: DevServer;
  // When present, called after the dev server is up but before any
  // capture begins. Returns the routes to crawl, replacing `routes`.
  // Lets a config seed its backing data (calling out to the Junjo API,
  // a fixtures script, etc.) and produce route paths that include
  // freshly-resolved IDs.
  prepare?: () => Promise<PrepareResult>;
};

export type CapturedScreenshot = {
  area: string;
  routeSlug: string;
  routePath: string;
  routeDescription: string;
  viewport: string;
  filePath: string;
};
