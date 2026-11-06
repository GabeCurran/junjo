import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Context, MiddlewareHandler } from "hono";
import { Errors } from "./errors.js";
import { logger } from "./logger.js";
import { currentRequestContext } from "./requestContext.js";

declare module "hono" {
  interface ContextVariableMap {
    // Set by the app's not-found handler: no route matched the request.
    routeUnmatched?: boolean;
  }
}

export const IDEMPOTENCY_RETENTION_HOURS = 24;
// An in-progress record older than this belongs to a request whose
// process died before it could finish or clean up; a retry claims it.
export const IDEMPOTENCY_ABANDON_MS = 5 * 60 * 1000;
export const IDEMPOTENCY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const RETENTION_MS = IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000;

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
const METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Response headers a replay repeats. Everything else is per-response.
const REPLAYED_HEADERS = ["content-type", "etag"] as const;

interface StoredRecord {
  fingerprint: string;
  state: string;
  responseStatus: number | null;
  responseBody: string | null;
  responseHeaders: unknown;
  createdAt: Date;
}

export interface IdempotencyOptions {
  // Clock for record ages; tests freeze it.
  now?: () => number;
}

// SHA-256 over the method, the path with its query string and the raw
// body bytes, each separated so no two distinct requests share an input.
async function fingerprintOf(c: Context): Promise<string> {
  const url = new URL(c.req.url);
  const body = new Uint8Array(await c.req.arrayBuffer());
  return createHash("sha256")
    .update(`${c.req.method}\n${url.pathname}${url.search}\n`)
    .update(body)
    .digest("hex");
}

function replay(record: StoredRecord): Response {
  const headers = new Headers();
  const stored = (record.responseHeaders ?? {}) as Record<string, unknown>;
  for (const name of REPLAYED_HEADERS) {
    const value = stored[name];
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("Idempotent-Replayed", "true");
  const status = record.responseStatus ?? 200;
  // Null-body statuses must not carry a body, even an empty string.
  const body = status === 204 || status === 304 ? null : (record.responseBody ?? "");
  return new Response(body, { status, headers });
}

// Applies `Idempotency-Key` to mutating requests made with a per-game
// API key. Mount after the API key middleware: the record is scoped to
// the authenticated key, so requests without one pass through.
//
// The first request claims the key as in progress, runs, and stores its
// final status, body and replayed headers when the status is below 500;
// a 5xx or an escaping exception deletes the claim so a retry runs
// again. The record is written after the handler's transaction commits,
// so a crash between the two lets a retry run the write a second time;
// conditional writes (`If-Match`) are the guard against that.
export function idempotencyMiddleware(
  prisma: PrismaClient,
  opts: IdempotencyOptions = {},
): MiddlewareHandler {
  const now = opts.now ?? Date.now;
  return async (c, next) => {
    if (!METHODS.has(c.req.method)) return next();
    const key = c.req.header("idempotency-key");
    if (key === undefined) return next();
    if (!KEY_PATTERN.test(key)) {
      throw Errors.badRequest(
        "Idempotency-Key must be 1 to 255 printable ASCII characters with no spaces",
      );
    }
    const apiKeyId = currentRequestContext()?.apiKeyId ?? null;
    if (!apiKeyId) return next();

    const fingerprint = await fingerprintOf(c);
    const claimedAt = await claim(prisma, apiKeyId, key, fingerprint, now(), c);
    if (claimedAt instanceof Response) return claimedAt;

    let stored = false;
    try {
      await next();
      const res = c.res;
      // A request no route matched never reached a handler, so its 404
      // is not an outcome worth replaying; releasing the claim keeps the
      // key usable once the caller fixes the path.
      if (res.status < 500 && c.get("routeUnmatched") !== true) {
        const headers: Record<string, string> = {};
        for (const name of REPLAYED_HEADERS) {
          const value = res.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        const body = await res.clone().text();
        // The write has committed. If the record cannot be saved, the
        // claim stays in progress (retries answer 409 until it is
        // reclaimed as abandoned) rather than being released, which would
        // let a retry run the write again; the caller still gets the
        // real response.
        stored = true;
        await prisma.idempotencyRecord
          .updateMany({
            where: { apiKeyId, key, createdAt: claimedAt, state: "in_progress" },
            data: {
              state: "completed",
              responseStatus: res.status,
              responseBody: body,
              responseHeaders: headers,
              completedAt: new Date(now()),
            },
          })
          .catch((err) => logger.error({ err }, "failed to store idempotency record"));
      }
    } finally {
      if (!stored) {
        await prisma.idempotencyRecord
          .deleteMany({ where: { apiKeyId, key, createdAt: claimedAt, state: "in_progress" } })
          .catch((err) => logger.error({ err }, "failed to release idempotency key"));
      }
    }
  };
}

// Claims (apiKeyId, key) for this request. Returns the claim time on
// success, or the response to send instead of running the handler: a
// replay, or an error thrown as a JunjoError. Expired and abandoned
// records are replaced with a conditional update on their `createdAt`,
// so of two retries racing for one stale record exactly one wins; the
// loser re-reads and sees the winner's in-progress claim.
async function claim(
  prisma: PrismaClient,
  apiKeyId: string,
  key: string,
  fingerprint: string,
  at: number,
  c: Context,
): Promise<Date | Response> {
  const claimedAt = new Date(at);
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await prisma.idempotencyRecord.createMany({
      data: { apiKeyId, key, fingerprint, state: "in_progress", createdAt: claimedAt },
      skipDuplicates: true,
    });
    if (inserted.count === 1) return claimedAt;

    const existing = await prisma.idempotencyRecord.findUnique({
      where: { apiKeyId_key: { apiKeyId, key } },
      select: {
        fingerprint: true,
        state: true,
        responseStatus: true,
        responseBody: true,
        responseHeaders: true,
        createdAt: true,
      },
    });
    if (!existing) continue;

    const age = at - existing.createdAt.getTime();
    const stale =
      age >= RETENTION_MS || (existing.state === "in_progress" && age >= IDEMPOTENCY_ABANDON_MS);
    if (stale) {
      const taken = await prisma.idempotencyRecord.updateMany({
        where: { apiKeyId, key, createdAt: existing.createdAt, state: existing.state },
        data: {
          fingerprint,
          state: "in_progress",
          responseStatus: null,
          responseBody: null,
          responseHeaders: Prisma.DbNull,
          createdAt: claimedAt,
          completedAt: null,
        },
      });
      if (taken.count === 1) return claimedAt;
      continue;
    }

    if (existing.fingerprint !== fingerprint) throw Errors.idempotencyKeyReused();
    if (existing.state !== "completed") {
      c.header("Retry-After", "1");
      throw Errors.idempotencyKeyInProgress();
    }
    return replay(existing);
  }
  c.header("Retry-After", "1");
  throw Errors.idempotencyKeyInProgress();
}

// Deletes records older than the retention window. Returns the number
// removed. The table holds at most a day of keyed writes, so one
// statement per sweep stays small.
export async function sweepIdempotencyRecords(
  prisma: PrismaClient,
  opts: { now?: () => number } = {},
): Promise<number> {
  const cutoff = new Date((opts.now ?? Date.now)() - RETENTION_MS);
  const removed = await prisma.idempotencyRecord.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return removed.count;
}

export function startIdempotencySweeper(
  prisma: PrismaClient,
  opts: { intervalMs?: number } = {},
): { stop(): void } {
  const tick = async () => {
    try {
      const removed = await sweepIdempotencyRecords(prisma);
      if (removed > 0) logger.info({ removed }, "removed expired idempotency records");
    } catch (err) {
      logger.error({ err }, "idempotency record sweep failed");
    }
  };
  const handle = setInterval(() => void tick(), opts.intervalMs ?? IDEMPOTENCY_SWEEP_INTERVAL_MS);
  if (typeof handle.unref === "function") handle.unref();
  return { stop: () => clearInterval(handle) };
}
