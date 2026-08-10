import { createHmac } from "node:crypto";
import { type LookupAddress, lookup as dnsLookup } from "node:dns";
import type { PrismaClient } from "@prisma/client";
import { Agent, type RequestInit as UndiciRequestInit, fetch as undiciFetch } from "undici";
import { formatJunjoEventForDiscord } from "./discordFormatter.js";
import { isPublicUnicastAddress } from "./ipGuard.js";
import { logger } from "./logger.js";
import { formatJunjoEventForSlack } from "./slackFormatter.js";

// After a retriable attempt N fails, wait `WEBHOOK_BACKOFF_MS[N - 1]`
// before scheduling attempt N+1. With MAX_ATTEMPTS = 6, indices 0..4 are
// consumed (after attempts 1..5); the trailing 24h entry is unreachable
// because attempt 6 is always terminal.
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
// After this many consecutive failed delivery attempts (network error,
// timeout, 5xx, or retriable 4xx) with no successful delivery in
// between, the endpoint is auto-disabled (`disabledAt = now()`). Picked
// to (a) tolerate transient outages -- a few minutes of upstream
// flapping won't trip it given the worker poll interval and the per-
// delivery retry budget -- and (b) catch permanently-dead URLs in
// well under an hour at the typical event cadence so they stop
// spamming logs. Re-enable manually via the existing PATCH route.
export const WEBHOOK_AUTO_DISABLE_THRESHOLD = 25;

// Matches a typical container orchestrator's terminationGracePeriod
// (Docker / Kubernetes / Nomad SIGKILL 30s after SIGTERM); a higher
// drain ceiling would just be killed mid-drain anyway.
export const WEBHOOK_WORKER_DRAIN_MS = 30_000;

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

// Log-safe rendering of an endpoint URL. For discord / slack targets the
// URL path IS the delivery credential (the webhook token lives in the
// path), so only the origin (scheme + host, no path or query) is ever
// logged. A URL that fails to parse renders as a fixed placeholder rather
// than falling back to the raw string, so a malformed value cannot leak
// its path either.
function endpointOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(unparseable url)";
  }
}

export interface WorkerOptions {
  fetch?: WebhookFetch;
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
  // Returning true breaks the batch loop early so graceful shutdown can
  // drain the in-flight `deliverOne` without picking up the rest of the
  // batch. Checked at the top of each iteration; a currently-executing
  // `deliverOne` always finishes (Promises cannot be cancelled).
  shouldStop?: () => boolean;
}

export type DeliveryOutcome =
  | { status: "delivered"; httpStatus: number }
  | { status: "pending"; httpStatus: number | null; nextAttemptAt: Date }
  | { status: "failed"; httpStatus: number | null }
  | { status: "missing" };

// HMAC-SHA256 of `<timestamp>.<body>` with the endpoint's secret. The
// `v1=` scheme prefix lets future signing schemes coexist (Stripe-style).
// Receivers recompute and constant-time-compare; see `webhooks.verify`.
export function signWebhookBody(secret: string, body: string, timestamp: string): string {
  const message = `${timestamp}.${body}`;
  const sig = createHmac("sha256", secret).update(message).digest("hex");
  return `${WEBHOOK_SIGNATURE_SCHEME}=${sig}`;
}

// Delivery-time SSRF backstop (TOCTOU close). `dns.lookup`-shaped function
// wired into the dispatcher's socket connect: it resolves every address for
// the target host and rejects the connection if ANY resolved address is not
// public unicast (private / loopback / link-local / metadata / reserved).
// Because undici connects to the exact address(es) validated here, there is
// no window for a second resolution to swap in a private IP. A rejection
// surfaces as a network error that flows through the normal retry /
// auto-disable policy. The hostname is included in the error but never the
// URL path (which is the delivery credential).
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export function safeWebhookLookup(
  hostname: string,
  options: { family?: number; hints?: number; all?: boolean; verbatim?: boolean } | LookupCallback,
  callback?: LookupCallback,
): void {
  const opts = typeof options === "function" ? {} : options;
  const cb = (typeof options === "function" ? options : callback) as LookupCallback;
  const wantAll = opts.all === true;
  dnsLookup(
    hostname,
    { family: opts.family ?? 0, hints: opts.hints, all: true, verbatim: opts.verbatim ?? true },
    (err, addresses) => {
      if (err) {
        cb(err, "", 0);
        return;
      }
      for (const entry of addresses) {
        if (!isPublicUnicastAddress(entry.address)) {
          cb(new Error(`webhook target host ${hostname} resolved to a non-public address`), "", 0);
          return;
        }
      }
      if (wantAll) {
        cb(null, addresses);
      } else {
        const first = addresses[0];
        if (first === undefined) {
          cb(new Error(`webhook target host ${hostname} did not resolve`), "", 0);
          return;
        }
        cb(null, first.address, first.family);
      }
    },
  );
}

// One dispatcher for all real deliveries; its connector runs
// `safeWebhookLookup` on every socket connect. Tests that inject a custom
// `WebhookFetch` never reach this dispatcher.
// undici forwards unknown connect options to the socket connector at
// runtime, which is how the custom lookup takes effect, but the lookup
// property is not in undici's exported connect option type, so the object
// is asserted to that option type. safeWebhookLookup implements the
// dns.lookup runtime contract undici invokes it under.
const webhookDispatcher = new Agent({
  connect: { lookup: safeWebhookLookup } as unknown as Agent.Options["connect"],
});

const defaultWebhookFetch: WebhookFetch = async (url, init) => {
  // redirect: "manual" so a 3xx does not silently follow to a different
  // host after the lexical URL guard already vetted the original target
  // (the blind-SSRF guard runs against the pre-redirect URL only). A
  // redirect surfaces as a non-2xx status that flows through the normal
  // retry / auto-disable policy instead of an un-guarded hop.
  const res = await undiciFetch(url, {
    ...(init as UndiciRequestInit),
    redirect: "manual",
    dispatcher: webhookDispatcher,
  });
  res.body?.cancel().catch(() => {});
  return { ok: res.ok, status: res.status };
};

function backoffMs(nextAttempt: number): number {
  const idx = Math.max(0, Math.min(nextAttempt - 1, WEBHOOK_BACKOFF_MS.length - 1));
  return WEBHOOK_BACKOFF_MS[idx] ?? WEBHOOK_BACKOFF_MS[WEBHOOK_BACKOFF_MS.length - 1] ?? 0;
}

// 4xx is permanent except 408 / 429 (transient); 5xx and non-HTTP errors
// (network, abort) retry up to MAX_ATTEMPTS.
function isPermanentFailure(httpStatus: number | null): boolean {
  if (httpStatus === null) return false;
  if (httpStatus === 408 || httpStatus === 429) return false;
  return httpStatus >= 400 && httpStatus < 500;
}

// Idempotent at the row level: a delivery already in a terminal state is
// left untouched. The poller filters to `pending` rows so this is defensive.
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

  // discord / slack target-shaped payloads omit the HMAC headers; those
  // targets authenticate via URL token, not signed headers, and they
  // ignore unknown headers. The "junjo" format keeps the canonical
  // signed-header set that `webhooks.verify` requires.
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
    // Log only the error message, never the raw error object: a fetch /
    // undici failure can carry the full request URL (whose path is the
    // delivery credential) on nested properties. The endpoint is
    // identified by id + origin instead.
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        deliveryId: delivery.id,
        endpointId: delivery.endpoint.id,
        endpointOrigin: endpointOrigin(delivery.endpoint.url),
      },
      "webhook delivery failed (network/abort)",
    );
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

  // Decide the endpoint-side counter update in lockstep with the
  // delivery row update so a crash between the two leaves no drift.
  // - Successful attempt: reset counter (transient outages ride through
  //   without inching toward auto-disable).
  // - Unsuccessful attempt (network error, timeout, 5xx, or retriable
  //   4xx -- retriable in the sense that the worker would re-attempt;
  //   a permanently-failed 4xx still increments because from the
  //   endpoint's point of view it's a botched delivery).
  const newConsecutive = httpOk ? 0 : delivery.endpoint.consecutiveFailures + 1;
  const shouldAutoDisable =
    !httpOk &&
    delivery.endpoint.disabledAt === null &&
    newConsecutive >= WEBHOOK_AUTO_DISABLE_THRESHOLD;

  await prisma.$transaction([
    prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: nextStatus,
        attemptCount,
        lastAttemptAt: nowDate,
        responseStatus: httpStatus,
        nextAttemptAt: nextStatus === "pending" ? nextAttemptAt : null,
      },
    }),
    prisma.webhookEndpoint.update({
      where: { id: delivery.endpoint.id },
      data: {
        consecutiveFailures: newConsecutive,
        ...(shouldAutoDisable ? { disabledAt: nowDate } : {}),
      },
    }),
  ]);

  if (shouldAutoDisable) {
    logger.warn(
      {
        endpointId: delivery.endpoint.id,
        endpointOrigin: endpointOrigin(delivery.endpoint.url),
        consecutiveFailures: newConsecutive,
        lastResponseStatus: httpStatus,
      },
      `auto-disabled webhook endpoint after ${newConsecutive} consecutive failures`,
    );
  }

  if (nextStatus === "delivered") {
    return { status: "delivered", httpStatus: httpStatus ?? 0 };
  }
  if (nextStatus === "pending") {
    return { status: "pending", httpStatus, nextAttemptAt: nextAttemptAt as Date };
  }
  return { status: "failed", httpStatus };
}

// Capped at `batchSize` so a single tick cannot starve other server work.
// Skips deliveries whose endpoint is disabled -- both the auto-disable
// path and operator-driven disables stop firing immediately even for
// rows that had already been queued before the disable landed.
export async function pollDueDeliveries(
  prisma: PrismaClient,
  now: Date,
  batchSize: number = WEBHOOK_WORKER_BATCH_SIZE,
): Promise<string[]> {
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      status: "pending",
      nextAttemptAt: { lte: now },
      endpoint: { disabledAt: null },
    },
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

// Sequential processing is deliberate: a single worker process gives us
// per-endpoint ordering for free without holding a Postgres advisory
// lock across a slow HTTP call. Multi-process scale-out should switch to
// `pg_try_advisory_lock` keyed on `webhookEndpointId`.
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
    if (opts.shouldStop?.()) break;
    const outcome = await deliverOne(prisma, id, fetcher, now);
    if (outcome.status === "delivered") result.delivered++;
    else if (outcome.status === "failed") result.failed++;
    else if (outcome.status === "pending") result.pending++;
  }
  return result;
}

export interface WorkerHandle {
  // Idempotent. Capped at `drainMs` (default 30s) so a hung receiver
  // cannot block process exit indefinitely.
  stop(opts?: { drainMs?: number }): Promise<void>;
  // Initialized to `now()` at construction so a freshly started worker
  // reports healthy until the stale threshold elapses; a worker stuck on
  // its first tick goes stale just like one that stopped firing later.
  getLastHeartbeat(): Date;
}

// Timer is `unref`'d so the worker never keeps the process alive on its
// own; tests skip `startWebhookWorker` and call `runWorkerOnce` directly
// with a fixed `now`.
export function startWebhookWorker(prisma: PrismaClient, opts: WorkerOptions = {}): WorkerHandle {
  const intervalMs = opts.intervalMs ?? WEBHOOK_WORKER_INTERVAL_MS;
  const now = opts.now ?? (() => new Date());
  let lastHeartbeat = now();
  let stopping = false;
  // `setInterval` does not serialize callbacks, so a slow tick can overlap
  // the next one. Tracking every in-flight tick lets `stop()` drain all of
  // them rather than only the most recent.
  const inFlight = new Set<Promise<void>>();

  const tick = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    const p = (async () => {
      try {
        await runWorkerOnce(prisma, { ...opts, shouldStop: () => stopping });
      } catch (err) {
        logger.error({ err }, "webhook worker tick failed");
      } finally {
        lastHeartbeat = now();
      }
    })();
    inFlight.add(p);
    p.finally(() => {
      inFlight.delete(p);
    }).catch(() => {});
    return p;
  };

  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle.unref === "function") handle.unref();

  return {
    stop: async ({ drainMs = WEBHOOK_WORKER_DRAIN_MS }: { drainMs?: number } = {}) => {
      stopping = true;
      clearInterval(handle);
      if (inFlight.size === 0) return;
      const drained = Promise.allSettled(inFlight).then(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ceiling = new Promise<void>((resolve) => {
        timer = setTimeout(() => resolve(), drainMs);
        if (typeof timer.unref === "function") timer.unref();
      });
      try {
        await Promise.race([drained, ceiling]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    getLastHeartbeat: () => lastHeartbeat,
  };
}
