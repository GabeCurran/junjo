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

export type CrawlConfig = {
  area: string;
  baseUrl?: string;
  basicAuth?: { username: string; password: string };
  viewports: Viewport[];
  routes: RouteSpec[];
  devServer?: DevServer;
};

export type CapturedScreenshot = {
  area: string;
  routeSlug: string;
  routePath: string;
  routeDescription: string;
  viewport: string;
  filePath: string;
};
