// @ts-check
// Junjo proxy + static server for the guild-panel example.
//
// This process is the trusted zone: it holds the per-game jk_ key, forwards
// only an allowlisted set of routes, and pins every user identity, body
// user ids and the groups-list `viewer` query param alike, to the session
// (hardcoded here) before forwarding. The browser holds no credential.
// See https://docs.junjo.io/browser for the pattern this implements.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Junjo, JunjoError } from "@junjo.io/sdk";
import { Hono } from "hono";

const JUNJO_API_URL = (process.env.JUNJO_API_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const JUNJO_API_KEY = process.env.JUNJO_API_KEY;
const PORT = Number(process.env.PORT ?? 8788);

// A real app derives this from its session (cookie or JWT). The whole point
// of the proxy is that the browser never chooses its own user id.
const SESSION_USER_ID = "demo-player-1";

if (JUNJO_API_KEY === undefined || JUNJO_API_KEY === "") {
  console.error("JUNJO_API_KEY is not set.");
  console.error('Seed one (npm run db:seed -w @junjo/server -- --name "Demo") and export it.');
  process.exit(1);
}

/**
 * Allowlisted routes. Anything else is refused, so the browser cannot reach
 * kick/ban/role routes through this key. `pin` names the body field that is
 * overwritten with the session user id before forwarding; `pinQuery` does
 * the same for a query parameter (any client-supplied value is dropped).
 * Without the `viewer` pin, omitting the param on GET /v1/groups would
 * return the key holder's privileged directory, secret groups included.
 * @type {{ method: string; pattern: RegExp; pin?: string; pinQuery?: string }[]}
 */
const ALLOWED = [
  { method: "GET", pattern: /^\/v1\/whoami$/ },
  { method: "GET", pattern: /^\/v1\/groups$/, pinQuery: "viewer" },
  { method: "POST", pattern: /^\/v1\/groups$/, pin: "creatorUserId" },
  { method: "POST", pattern: /^\/v1\/groups\/[^/]+\/join$/, pin: "userId" },
];

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// The browser loads the SDK from the installed package through /vendor/sdk/
// and the import map in index.html; no bundler involved.
const sdkDistDir = dirname(require.resolve("@junjo.io/sdk"));

/**
 * @param {string} absPath
 * @param {string} contentType
 */
async function file(absPath, contentType) {
  const content = await readFile(absPath, "utf8");
  return new Response(content, { status: 200, headers: { "content-type": contentType } });
}

const app = new Hono();

app.all("/api/junjo/*", async (c) => {
  const path = c.req.path.slice("/api/junjo".length);
  const rule = ALLOWED.find((r) => r.method === c.req.method && r.pattern.test(path));
  if (!rule) {
    // Same envelope shape as the real server, so the browser SDK throws a
    // normal JunjoError instead of choking on an unexpected body.
    return c.json(
      { code: "not_found", status: 404, message: "route not forwarded by this proxy" },
      404,
    );
  }

  /** @type {Record<string, string>} */
  const headers = { authorization: `Bearer ${JUNJO_API_KEY}` };
  /** @type {string | undefined} */
  let body;
  if (rule.pin !== undefined) {
    const parsed = await c.req.json().catch(() => ({}));
    parsed[rule.pin] = SESSION_USER_ID; // identity pinning: ignore what the browser sent
    headers["content-type"] = "application/json";
    body = JSON.stringify(parsed);
  }

  const url = new URL(c.req.url);
  if (rule.pinQuery !== undefined) {
    // Identity pinning for query params: drop whatever the browser sent
    // (set() replaces every existing value) and use the session's.
    url.searchParams.set(rule.pinQuery, SESSION_USER_ID);
  }
  const search = url.search;
  let upstream;
  try {
    upstream = await fetch(`${JUNJO_API_URL}${path}${search}`, {
      method: c.req.method,
      headers,
      body,
    });
  } catch {
    return c.json({ code: "internal", status: 502, message: "Junjo API unreachable" }, 502);
  }
  // Pass the status and body through untouched; mirror the headers the SDK
  // reads (retry-after becomes err.retryAfterSeconds on 429).
  const out = new Headers();
  for (const name of ["content-type", "retry-after", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return new Response(await upstream.text(), { status: upstream.status, headers: out });
});

app.get("/", () => file(join(here, "public", "index.html"), "text/html; charset=utf-8"));
app.get("/main.js", () => file(join(here, "public", "main.js"), "text/javascript; charset=utf-8"));

app.get("/vendor/sdk/:name", async (c) => {
  const name = c.req.param("name");
  // The dist entry imports sibling chunk files, so serve the package's dist
  // directory, restricted to plain .js filenames.
  if (!/^[\w.-]+\.js$/.test(name)) return c.notFound();
  try {
    return await file(join(sdkDistDir, name), "text/javascript; charset=utf-8");
  } catch {
    return c.notFound();
  }
});

// The proxy uses the SDK for its own server-side call: a boot-time key check.
// Browser traffic above is forwarded as raw HTTP so the client SDK's paths
// and headers pass through unmodified.
const junjo = new Junjo({ apiKey: JUNJO_API_KEY, baseUrl: JUNJO_API_URL });
try {
  const info = await junjo.keyInfo();
  console.log(`junjo: key OK (game ${info.gameId})`);
} catch (err) {
  if (err instanceof JunjoError) {
    console.warn(`junjo: keyInfo failed (${err.code}): ${err.message}`);
    console.warn("Starting anyway; the UI will surface errors.");
  } else {
    throw err;
  }
}

serve({ fetch: app.fetch, port: PORT });
console.log(`guild panel: http://localhost:${PORT} (proxying ${JUNJO_API_URL})`);
