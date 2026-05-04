import { type ChildProcess, spawn } from "node:child_process";
import type { DevServer } from "./types.ts";

export type RunningServer = {
  baseUrl: string;
  stop: () => Promise<void>;
};

export async function startDevServer(spec: DevServer): Promise<RunningServer> {
  const baseUrl = `http://127.0.0.1:${spec.port}`;
  const readyUrl = `${baseUrl}${spec.readyPath ?? "/"}`;

  // If a dev server is already serving this port (e.g., started by the
  // orchestrator or by the dev workflow), reuse it and return a no-op
  // stop. Eliminates the per-iteration cold-start cost when iterating
  // visually inside the agent loop.
  if (await isAlreadyServing(readyUrl)) {
    return {
      baseUrl,
      stop: async () => {
        // intentional no-op: we did not start it, we do not stop it
      },
    };
  }

  const child = spawn(spec.command, [], {
    cwd: spec.cwd,
    shell: true,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const startupTimeout = spec.startupTimeoutMs ?? 60_000;
  const exited = waitForExit(child);
  try {
    await Promise.race([
      waitForReady(readyUrl, startupTimeout),
      exited.then((code) => {
        throw new Error(`dev server exited early (code ${code ?? "null"})`);
      }),
    ]);
  } catch (err) {
    await stopChild(child);
    throw err;
  }
  return {
    baseUrl,
    stop: () => stopChild(child),
  };
}

async function isAlreadyServing(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(2_000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(
    `dev server did not become ready at ${url} within ${timeoutMs}ms: ${String(lastErr)}`,
  );
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
