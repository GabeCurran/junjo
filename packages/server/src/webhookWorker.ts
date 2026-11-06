import { createHmac } from "node:crypto";
import { type LookupAddress, lookup as dnsLookup } from "node:dns";
import { Prisma, type PrismaClient } from "@prisma/client";
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
// Endpoints served at once within one tick. Each endpoint still has at
// most one request in flight.
export const WEBHOOK_WORKER_CONCURRENCY = 8;
// How long a claimed delivery stays reserved for the worker that claimed
// it. It must exceed the longest a tick can hold a claim: one endpoint's
// share of a batch sent back to back, each request capped at
// WEBHOOK_REQUEST_TIMEOUT_MS.
export const WEBHOOK_CLAIM_LEASE_MS = 15 * 60_000;
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
  // Endpoints served at once within one tick.
  concurrency?: number;
  // How long a claim reserves a delivery; see WEBHOOK_CLAIM_LEASE_MS.
  leaseMs?: number;
  // Called after every finished delivery attempt.
  onDelivery?: () => void;
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

// A claimed delivery: its row and the endpoint it goes to.
export interface ClaimedDelivery {
  id: string;
  endpointId: string;
}

// Claims up to `batchSize` due deliveries for this worker and returns
// them oldest due first. The claim moves each row's `nextAttemptAt`
// forward by `leaseMs` in the same statement that selects it, and rows
// another worker holds locked are skipped, so two workers (or two ticks)
// never claim the same row while its lease runs. If the worker dies
// mid-delivery, the row becomes due again once the lease ends.
// Deliveries whose endpoint is disabled are not claimed, so a disable
// stops firing immediately even for rows queued before it landed.
export async function claimDueDeliveries(
  prisma: PrismaClient,
  now: Date,
  batchSize: number = WEBHOOK_WORKER_BATCH_SIZE,
  leaseMs: number = WEBHOOK_CLAIM_LEASE_MS,
): Promise<ClaimedDelivery[]> {
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const rows = await prisma.$queryRaw<{ id: string; endpointId: string; dueAt: Date }[]>(
    Prisma.sql`
      WITH due AS (
        SELECT d.id, d."nextAttemptAt"
        FROM "WebhookDelivery" d
        JOIN "WebhookEndpoint" e ON e.id = d."webhookEndpointId"
        WHERE d.status = 'pending'
          AND d."nextAttemptAt" <= ${now}
          AND e."disabledAt" IS NULL
        ORDER BY d."nextAttemptAt" ASC, d.id ASC
        LIMIT ${batchSize}
        FOR UPDATE OF d SKIP LOCKED
      )
      UPDATE "WebhookDelivery" w
      SET "nextAttemptAt" = ${leaseUntil}
      FROM due
      WHERE w.id = due.id
      RETURNING w.id, w."webhookEndpointId" AS "endpointId", due."nextAttemptAt" AS "dueAt"
    `,
  );
  rows.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || (a.id < b.id ? -1 : 1));
  return rows.map((r) => ({ id: r.id, endpointId: r.endpointId }));
}

// Ends the lease on claimed deliveries this worker will not attempt, so
// the next tick can pick them up without waiting for the lease to run out.
async function releaseClaims(prisma: PrismaClient, ids: readonly string[], at: Date) {
  if (ids.length === 0) return;
  await prisma.webhookDelivery.updateMany({
    where: { id: { in: [...ids] }, status: "pending" },
    data: { nextAttemptAt: at },
  });
}

export interface WorkerTickResult {
  delivered: number;
  pending: number;
  failed: number;
}

// Deliveries are grouped by endpoint. Each endpoint's deliveries are sent
// one at a time in due order, so an endpoint never has more than one
// request in flight and keeps its delivery order; up to `concurrency`
// endpoints are served at once. After a retriable failure the rest of
// that endpoint's claims in this tick are released untried, so a dead or
// slow receiver costs at most one request timeout per tick and never
// holds up deliveries to other endpoints.
export async function runWorkerOnce(
  prisma: PrismaClient,
  opts: WorkerOptions = {},
): Promise<WorkerTickResult> {
  const fetcher = opts.fetch ?? defaultWebhookFetch;
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? WEBHOOK_WORKER_BATCH_SIZE;
  const concurrency = Math.max(1, opts.concurrency ?? WEBHOOK_WORKER_CONCURRENCY);

  const claimed = await claimDueDeliveries(prisma, now(), batchSize, opts.leaseMs);
  const lanes = new Map<string, string[]>();
  for (const row of claimed) {
    const lane = lanes.get(row.endpointId);
    if (lane) lane.push(row.id);
    else lanes.set(row.endpointId, [row.id]);
  }

  const result: WorkerTickResult = { delivered: 0, pending: 0, failed: 0 };
  const unattempted: string[] = [];
  const queue = [...lanes.values()];

  const runLane = async (ids: string[]) => {
    for (let i = 0; i < ids.length; i++) {
      if (opts.shouldStop?.()) {
        unattempted.push(...ids.slice(i));
        return;
      }
      const outcome = await deliverOne(prisma, ids[i] as string, fetcher, now);
      opts.onDelivery?.();
      if (outcome.status === "delivered") result.delivered++;
      else if (outcome.status === "failed") result.failed++;
      else if (outcome.status === "pending") {
        result.pending++;
        unattempted.push(...ids.slice(i + 1));
        return;
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let lane = queue.shift(); lane !== undefined; lane = queue.shift()) {
      if (opts.shouldStop?.()) {
        unattempted.push(...lane);
        continue;
      }
      await runLane(lane);
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    await releaseClaims(prisma, unattempted, now()).catch((err) =>
      logger.error({ err }, "failed to release webhook delivery claims"),
    );
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
  // Refreshed after every finished tick and every finished delivery.
  getLastHeartbeat(): Date;
}

// Timer is `unref`'d so the worker never keeps the process alive on its
// own; tests skip `startWebhookWorker` and call `runWorkerOnce` directly
// with a fixed `now`. A timer firing while a tick is still running is
// skipped, so ticks never overlap.
export function startWebhookWorker(prisma: PrismaClient, opts: WorkerOptions = {}): WorkerHandle {
  const intervalMs = opts.intervalMs ?? WEBHOOK_WORKER_INTERVAL_MS;
  const now = opts.now ?? (() => new Date());
  let lastHeartbeat = now();
  let stopping = false;
  let running: Promise<void> | null = null;

  const tick = (): void => {
    if (stopping || running) return;
    running = (async () => {
      try {
        await runWorkerOnce(prisma, {
          ...opts,
          shouldStop: () => stopping,
          onDelivery: () => {
            lastHeartbeat = now();
            opts.onDelivery?.();
          },
        });
      } catch (err) {
        logger.error({ err }, "webhook worker tick failed");
      } finally {
        lastHeartbeat = now();
        running = null;
      }
    })();
  };

  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === "function") handle.unref();

  return {
    stop: async ({ drainMs = WEBHOOK_WORKER_DRAIN_MS }: { drainMs?: number } = {}) => {
      stopping = true;
      clearInterval(handle);
      const current = running;
      if (!current) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ceiling = new Promise<void>((resolve) => {
        timer = setTimeout(() => resolve(), drainMs);
        if (typeof timer.unref === "function") timer.unref();
      });
      try {
        await Promise.race([current, ceiling]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    getLastHeartbeat: () => lastHeartbeat,
  };
}

// =====================================================================
// Delivery retention
// =====================================================================

export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
export const WEBHOOK_DELIVERY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DELIVERY_SWEEP_BATCH = 5_000;

// Deletes delivered and failed deliveries created more than
// `retentionDays` ago, in bounded batches. Pending deliveries are kept
// whatever their age. Returns the number of rows removed.
export async function sweepWebhookDeliveries(
  prisma: PrismaClient,
  opts: { retentionDays?: number; now?: Date } = {},
): Promise<number> {
  const days = opts.retentionDays ?? WEBHOOK_DELIVERY_RETENTION_DAYS;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000);
  let total = 0;
  for (;;) {
    const removed = await prisma.$executeRaw`
      DELETE FROM "WebhookDelivery" WHERE ctid IN (
        SELECT ctid FROM "WebhookDelivery"
        WHERE status IN ('delivered', 'failed') AND "createdAt" < ${cutoff}
        LIMIT ${DELIVERY_SWEEP_BATCH}
      )
    `;
    total += removed;
    if (removed < DELIVERY_SWEEP_BATCH) return total;
  }
}

export function startWebhookDeliverySweeper(
  prisma: PrismaClient,
  opts: { intervalMs?: number; retentionDays?: number } = {},
): { stop(): void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const removed = await sweepWebhookDeliveries(prisma, { retentionDays: opts.retentionDays });
      if (removed > 0) logger.info({ removed }, "removed expired webhook deliveries");
    } catch (err) {
      logger.error({ err }, "webhook delivery sweep failed");
    } finally {
      running = false;
    }
  };
  const handle = setInterval(
    () => void tick(),
    opts.intervalMs ?? WEBHOOK_DELIVERY_SWEEP_INTERVAL_MS,
  );
  if (typeof handle.unref === "function") handle.unref();
  return { stop: () => clearInterval(handle) };
}
