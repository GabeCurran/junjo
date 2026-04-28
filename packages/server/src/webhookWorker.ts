import { createHmac } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { formatJunjoEventForDiscord } from "./discordFormatter.js";
import { formatJunjoEventForSlack } from "./slackFormatter.js";

// Backoff schedule between attempts. After attempt N fails (and the
// failure is retriable), wait `WEBHOOK_BACKOFF_MS[N - 1]` before
// scheduling attempt N+1. With WEBHOOK_MAX_ATTEMPTS = 6, indices 0..4
// are consumed (after attempts 1..5). The trailing 24h entry mirrors
// the figure in the V1 roadmap but is never actually used: attempt 6
// is terminal whether it succeeds or fails.
export const WEBHOOK_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  8 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
export const WEBHOOK_WORKER_INTERVAL_MS = 5_000;
export const WEBHOOK_WORKER_BATCH_SIZE = 50;
export const WEBHOOK_SIGNATURE_SCHEME = "v1";

export interface WebhookFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface WebhookFetchResult {
  ok: boolean;
  status: number;
}

export type WebhookFetch = (url: string, init: WebhookFetchInit) => Promise<WebhookFetchResult>;

export interface WorkerOptions {
  fetch?: WebhookFetch;
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
}

export type DeliveryOutcome =
  | { status: "delivered"; httpStatus: number }
  | { status: "pending"; httpStatus: number | null; nextAttemptAt: Date }
  | { status: "failed"; httpStatus: number | null }
  | { status: "missing" };

// HMAC-SHA256 of `<timestamp>.<body>` using the endpoint's secret. The
// `v1=` scheme prefix lets future signing schemes coexist (Stripe-style).
// Receivers (Phase 5.4 `webhooks.verify`) recompute this and compare in
// constant time.
export function signWebhookBody(secret: string, body: string, timestamp: string): string {
  const message = `${timestamp}.${body}`;
  const sig = createHmac("sha256", secret).update(message).digest("hex");
  return `${WEBHOOK_SIGNATURE_SCHEME}=${sig}`;
}

const defaultWebhookFetch: WebhookFetch = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  res.body?.cancel().catch(() => {});
  return { ok: res.ok, status: res.status };
};

function backoffMs(nextAttempt: number): number {
  const idx = Math.max(0, Math.min(nextAttempt - 1, WEBHOOK_BACKOFF_MS.length - 1));
  return WEBHOOK_BACKOFF_MS[idx] ?? WEBHOOK_BACKOFF_MS[WEBHOOK_BACKOFF_MS.length - 1] ?? 0;
}

// 4xx responses are non-retriable except for the small set of
// transient codes (request timeout, too many requests). Anything 5xx
// or non-HTTP (network error, abort) IS retriable up to MAX_ATTEMPTS.
function isPermanentFailure(httpStatus: number | null): boolean {
  if (httpStatus === null) return false;
  if (httpStatus === 408 || httpStatus === 429) return false;
  return httpStatus >= 400 && httpStatus < 500;
}

// Loads one delivery row, signs + POSTs the payload, and transitions
// the row's status based on the response. Idempotent at the row level:
// a delivery whose status is already terminal (`delivered` or `failed`)
// is left untouched. The poller filters to `pending` rows so this
// guard is defensive.
export async function deliverOne(
  prisma: PrismaClient,
  deliveryId: string,
  fetcher: WebhookFetch = defaultWebhookFetch,
  now: () => Date = () => new Date(),
): Promise<DeliveryOutcome> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (!delivery) return { status: "missing" };
  if (delivery.status !== "pending") {
    return delivery.status === "delivered"
      ? { status: "delivered", httpStatus: delivery.responseStatus ?? 0 }
      : { status: "failed", httpStatus: delivery.responseStatus };
  }

  const ts = now().toISOString();
  const payload = delivery.payload as Record<string, unknown> | null;
  const eventId = typeof payload?.id === "string" ? payload.id : "";
  const eventType = typeof payload?.type === "string" ? payload.type : "";

  // Format-specific wire shape. "discord" and "slack" produce
  // target-shaped payloads and omit the HMAC headers (those targets
  // authenticate via URL token, not signed headers - and they ignore
  // unknown headers anyway, so sending the `x-junjo-*` set would be
  // both useless and noisy). "junjo" stays on the raw JunjoEvent JSON
  // with the canonical signed-header set; receivers running
  // `junjo.webhooks.verify` need every header in this map.
  let body: string;
  let headers: Record<string, string>;
  if (delivery.endpoint.format === "discord") {
    body = JSON.stringify(formatJunjoEventForDiscord(payload ?? {}));
    headers = { "content-type": "application/json" };
  } else if (delivery.endpoint.format === "slack") {
    body = JSON.stringify(formatJunjoEventForSlack(payload ?? {}));
    headers = { "content-type": "application/json" };
  } else {
    body = JSON.stringify(delivery.payload);
    const signature = signWebhookBody(delivery.endpoint.secret, body, ts);
    headers = {
      "content-type": "application/json",
      "x-junjo-event-id": eventId,
      "x-junjo-event": eventType,
      "x-junjo-delivery-id": delivery.id,
      "x-junjo-timestamp": ts,
      "x-junjo-signature": signature,
    };
  }

  let httpStatus: number | null = null;
  let httpOk = false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetcher(delivery.endpoint.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    httpStatus = res.status;
    httpOk = res.ok;
  } catch (err) {
    httpStatus = null;
    httpOk = false;
    console.error(`[junjo-server] webhook delivery ${delivery.id} failed (network/abort)`, err);
  } finally {
    clearTimeout(timer);
  }

  const attemptCount = delivery.attemptCount + 1;
  const nowDate = now();

  let nextStatus: "delivered" | "pending" | "failed";
  let nextAttemptAt: Date | null = null;

  if (httpOk) {
    nextStatus = "delivered";
  } else if (isPermanentFailure(httpStatus)) {
    nextStatus = "failed";
  } else if (attemptCount >= WEBHOOK_MAX_ATTEMPTS) {
    nextStatus = "failed";
  } else {
    nextStatus = "pending";
    nextAttemptAt = new Date(nowDate.getTime() + backoffMs(attemptCount));
  }

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: nextStatus,
      attemptCount,
      lastAttemptAt: nowDate,
      responseStatus: httpStatus,
      nextAttemptAt: nextStatus === "pending" ? nextAttemptAt : null,
    },
  });

  if (nextStatus === "delivered") {
    return { status: "delivered", httpStatus: httpStatus ?? 0 };
  }
  if (nextStatus === "pending") {
    return { status: "pending", httpStatus, nextAttemptAt: nextAttemptAt as Date };
  }
  return { status: "failed", httpStatus };
}

// Returns the ids of pending deliveries whose `nextAttemptAt` is at or
// before `now`, ordered oldest-due first. Capped at `batchSize` so a
// single tick cannot starve other server work.
export async function pollDueDeliveries(
  prisma: PrismaClient,
  now: Date,
  batchSize: number = WEBHOOK_WORKER_BATCH_SIZE,
): Promise<string[]> {
  const rows = await prisma.webhookDelivery.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: batchSize,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export interface WorkerTickResult {
  delivered: number;
  pending: number;
  failed: number;
}

// One full worker tick: poll due deliveries, then process each one
// sequentially. Sequential processing is deliberate: a single worker
// process gives us per-endpoint ordering for free without holding a
// Postgres advisory lock across a slow HTTP call. When this worker
// scales out to multiple processes, switch to `pg_try_advisory_lock`
// keyed on `webhookEndpointId`.
export async function runWorkerOnce(
  prisma: PrismaClient,
  opts: WorkerOptions = {},
): Promise<WorkerTickResult> {
  const fetcher = opts.fetch ?? defaultWebhookFetch;
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? WEBHOOK_WORKER_BATCH_SIZE;

  const ids = await pollDueDeliveries(prisma, now(), batchSize);
  const result: WorkerTickResult = { delivered: 0, pending: 0, failed: 0 };
  for (const id of ids) {
    const outcome = await deliverOne(prisma, id, fetcher, now);
    if (outcome.status === "delivered") result.delivered++;
    else if (outcome.status === "failed") result.failed++;
    else if (outcome.status === "pending") result.pending++;
  }
  return result;
}

export interface WorkerHandle {
  stop(): void;
}

// Schedules `runWorkerOnce` on a `setInterval`. The handle is `unref`'d
// so the timer never keeps the process alive on its own. Production
// boots one worker per server process from `index.ts`; tests call
// `runWorkerOnce` directly with a fixed `now` and never start a timer.
export function startWebhookWorker(prisma: PrismaClient, opts: WorkerOptions = {}): WorkerHandle {
  const intervalMs = opts.intervalMs ?? WEBHOOK_WORKER_INTERVAL_MS;

  const tick = async () => {
    try {
      await runWorkerOnce(prisma, opts);
    } catch (err) {
      console.error("[junjo-server] webhook worker tick failed", err);
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return { stop: () => clearInterval(handle) };
}
