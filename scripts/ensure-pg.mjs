#!/usr/bin/env node
// Ensures the local junjo-test-pg Postgres container is running and
// migrated before `npm run dev` spawns the dev processes. Mirrors the
// loop orchestrator's `Start-TestDatabase` (.loop/run.ps1) so the dev
// flow gets the same DB bootstrap the loop relies on.
//
// Behavior:
//   - Container missing -> `docker run -d` postgres:17 with the standard
//     dev creds (postgres/junjo @ localhost:5433/junjo_test).
//   - Container exists  -> `docker restart` for a clean dev session
//     (data persists in the container's volume; just bounces postgres).
//   - Then waits for pg_isready and runs `prisma migrate deploy`.
//
// Cross-platform: works on Windows + macOS + Linux because it shells out
// only to `docker` and `npx` which are present in any dev's PATH if they
// already use the loop or the Junjo dev workflow.

import { spawnSync } from "node:child_process";

const CONTAINER = "junjo-test-pg";
const DB_USER = "postgres";
const DB_PASS = "junjo";
const DB_NAME = "junjo_test";
const DB_PORT = "5433";
const DATABASE_URL = `postgres://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}`;

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
  const r = run("docker", [
    "ps",
    "--format",
    "{{.Names}}",
    "--filter",
    `name=^${CONTAINER}$`,
  ]);
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

function applyMigrations() {
  log("applying prisma migrations...");
  const r = run("npx", ["prisma", "migrate", "deploy"], {
    cwd: "packages/server",
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) fail(`prisma migrate deploy failed (exit ${r.status})`);
  log("migrations applied; spawning dev servers...");
}

ensureDocker();
bootContainer();
waitReady();
applyMigrations();
