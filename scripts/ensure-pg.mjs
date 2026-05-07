#!/usr/bin/env node
// Ensures the local junjo-test-pg Postgres container is running and
// migrated before `npm run dev` spawns the dev processes. Also bootstraps
// the dev env files (root `.env` + `apps/dashboard/.env.local`) on first
// run so a fresh clone goes from `npm install` to a working dashboard
// without manual env setup.
//
// Behavior:
//   - Container missing -> `docker run -d` postgres:17 with the standard
//     dev creds (postgres/junjo @ localhost:5433/junjo_test).
//   - Container exists  -> `docker restart` for a clean dev session
//     (data persists in the container's volume; just bounces postgres).
//   - Then waits for pg_isready, ensures env files exist, runs
//     `prisma migrate deploy`, runs `db:seed:demo`, parses the seeded
//     API key out of the seed output, and persists it into both env files.
//
// Cross-platform: shells out to `docker`, `npx`, and `npm`.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CONTAINER = "junjo-test-pg";
const DB_USER = "postgres";
const DB_PASS = "junjo";
const DB_NAME = "junjo_test";
// Override via JUNJO_DB_PORT when 5433 collides with another local
// Postgres on the host (common for devs running multiple projects).
const DB_PORT = process.env.JUNJO_DB_PORT ?? "5433";
const DATABASE_URL = `postgres://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}`;

const ROOT_ENV = ".env";
const DASHBOARD_ENV = "apps/dashboard/.env.local";
const API_KEY_PLACEHOLDER = "jk_pending.pending";

function log(msg) {
  process.stdout.write(`[pg] ${msg}\n`);
}

function fail(msg, code = 1) {
  process.stderr.write(`[pg] ABORT: ${msg}\n`);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: false, ...opts });
}

function ensureDocker() {
  const r = run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (r.error || r.status !== 0) {
    fail("docker is not available; start Docker Desktop and try again");
  }
}

function dockerExists() {
  const r = run("docker", [
    "ps",
    "-a",
    "--format",
    "{{.Names}}",
    "--filter",
    `name=^${CONTAINER}$`,
  ]);
  return r.status === 0 && r.stdout.trim() === CONTAINER;
}

function dockerRunning() {
  const r = run("docker", ["ps", "--format", "{{.Names}}", "--filter", `name=^${CONTAINER}$`]);
  return r.status === 0 && r.stdout.trim() === CONTAINER;
}

function bootContainer() {
  if (dockerExists()) {
    log("restarting junjo-test-pg (data preserved; postgres process bounces)...");
    const r = run("docker", ["restart", CONTAINER], { stdio: "inherit" });
    if (r.status !== 0) fail(`docker restart failed (exit ${r.status})`);
  } else {
    log(`creating junjo-test-pg (postgres:17 on :${DB_PORT})...`);
    const r = run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        CONTAINER,
        "-e",
        `POSTGRES_USER=${DB_USER}`,
        "-e",
        `POSTGRES_PASSWORD=${DB_PASS}`,
        "-e",
        `POSTGRES_DB=${DB_NAME}`,
        "-p",
        `${DB_PORT}:5432`,
        "postgres:17",
      ],
      { stdio: "inherit" },
    );
    if (r.status !== 0) fail(`docker run failed (exit ${r.status})`);
  }
}

function waitReady(maxSeconds = 30) {
  log("waiting for postgres to accept connections...");
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    const r = run("docker", ["exec", CONTAINER, "pg_isready", "-U", DB_USER, "-d", DB_NAME]);
    if (r.status === 0) {
      log("ready");
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  fail(`postgres did not become ready within ${maxSeconds}s`);
}

function generateAdminToken() {
  return `jadm_${randomBytes(32).toString("base64url")}`;
}

function readEnvValue(path, key) {
  if (!existsSync(path)) return null;
  const body = readFileSync(path, "utf8");
  const m = body.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

// Replace `${key}=...` on its own line, or append `${key}=value` when
// absent (gated by `appendIfMissing`). No-op when the file doesn't
// exist or when the value already matches. Used to reconcile env-file
// state against runtime constants on every dev run, instead of only
// writing on first-run boot.
//
// Repro the bug this guards against (DATABASE_URL drift):
//   JUNJO_DB_PORT=5434 npm run dev:server-only   # .env now points at 5434
//   JUNJO_DB_PORT=5435 npm run dev:server-only   # .env reconciles to 5435
function persistEnvLine(path, key, value, { appendIfMissing = true } = {}) {
  if (!existsSync(path)) return false;
  const body = readFileSync(path, "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  let updated;
  if (re.test(body)) {
    updated = body.replace(re, `${key}=${value}`);
  } else if (appendIfMissing) {
    updated = `${body}${body.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
  } else {
    return false;
  }
  if (updated === body) return false;
  writeFileSync(path, updated, "utf8");
  log(`reconciled ${key} -> ${path}`);
  return true;
}

function ensureEnvFiles() {
  // Reuse an existing JUNJO_ADMIN_TOKEN if either env file already has
  // one, so re-running `npm run dev` doesn't invalidate auth across a
  // server / dashboard pair that's already in sync.
  const existingToken =
    readEnvValue(ROOT_ENV, "JUNJO_ADMIN_TOKEN") ??
    readEnvValue(DASHBOARD_ENV, "JUNJO_ADMIN_TOKEN") ??
    generateAdminToken();

  if (!existsSync(ROOT_ENV)) {
    log(`creating ${ROOT_ENV} (dev defaults)...`);
    writeFileSync(
      ROOT_ENV,
      [
        "# Auto-generated by `npm run dev`. Edit freely; deleted fields",
        "# get regenerated on the next dev run. Gitignored.",
        "",
        `DATABASE_URL=${DATABASE_URL}`,
        `TEST_DATABASE_URL=${DATABASE_URL}`,
        `JUNJO_ADMIN_TOKEN=${existingToken}`,
        `JUNJO_ADMIN_API_KEY=${API_KEY_PLACEHOLDER}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  if (!existsSync(DASHBOARD_ENV)) {
    log(`creating ${DASHBOARD_ENV} (dev defaults; basic-auth admin/admin)...`);
    writeFileSync(
      DASHBOARD_ENV,
      [
        "# Auto-generated by `npm run dev`. Gitignored.",
        "",
        "JUNJO_BASE_URL=http://localhost:8787",
        `JUNJO_ADMIN_API_KEY=${API_KEY_PLACEHOLDER}`,
        `JUNJO_ADMIN_TOKEN=${existingToken}`,
        "DASHBOARD_ADMIN_USER=admin",
        "DASHBOARD_ADMIN_PASSWORD=admin",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  // Reconcile DATABASE_URL / TEST_DATABASE_URL against the current
  // DB_PORT on every run. The first-run write above is unconditional,
  // but on subsequent runs an env override (e.g. JUNJO_DB_PORT=5434)
  // would otherwise leave a stale URL behind and the server would
  // connect to whatever else is on 5433. Dashboard env doesn't carry
  // a DATABASE_URL today, so it's left untouched (`appendIfMissing:
  // false`); flipping that to true on a future schema change is safe.
  persistEnvLine(ROOT_ENV, "DATABASE_URL", DATABASE_URL);
  persistEnvLine(ROOT_ENV, "TEST_DATABASE_URL", DATABASE_URL);
  persistEnvLine(DASHBOARD_ENV, "DATABASE_URL", DATABASE_URL, { appendIfMissing: false });
  persistEnvLine(DASHBOARD_ENV, "TEST_DATABASE_URL", DATABASE_URL, { appendIfMissing: false });
}

function applyMigrations() {
  log("applying prisma migrations...");
  const r = run("npx", ["prisma", "migrate", "deploy"], {
    cwd: "packages/server",
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) fail(`prisma migrate deploy failed (exit ${r.status})`);
  log("migrations applied");
}

function seedDemo() {
  log("seeding demo dataset (wipes DB; ~5s)...");
  // Capture stdout so we can parse the freshly-issued API key out of the
  // summary block; tee it back to the operator's terminal so the seed's
  // own output isn't swallowed.
  const r = run("npm", ["run", "db:seed:demo", "-w", "@junjo/server"], {
    env: { ...process.env, DATABASE_URL },
    stdio: ["inherit", "pipe", "inherit"],
    shell: process.platform === "win32",
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) fail(`db:seed:demo failed (exit ${r.status})`);

  const match = r.stdout?.match(/^\s*full:\s+(jk_[\w.-]+)/m);
  if (!match) {
    log("WARN: could not parse API key from seed output; env files keep their existing key");
    return;
  }
  const apiKey = match[1];
  persistEnvLine(ROOT_ENV, "JUNJO_ADMIN_API_KEY", apiKey);
  persistEnvLine(DASHBOARD_ENV, "JUNJO_ADMIN_API_KEY", apiKey);
  log("seed complete; spawning dev servers...");
}

ensureDocker();
bootContainer();
waitReady();
ensureEnvFiles();
applyMigrations();
seedDemo();
