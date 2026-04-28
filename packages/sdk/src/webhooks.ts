import type {
  CreateWebhookEndpointInput,
  GameId,
  JunjoEvent,
  JunjoEventType,
  UpdateWebhookEndpointInput,
  WebhookEndpoint,
  WebhookEndpointId,
  WebhookEndpointWithSecret,
  WebhookSignatureHeaders,
} from "@junjo/shared";
import { JunjoError } from "./errors.js";
import { type WireJunjoEvent, deserializeEvent } from "./events.js";
import type { HttpClient } from "./http.js";

// Must match `WEBHOOK_SIGNATURE_SCHEME` and the signing layout in the
// server's `webhookWorker.ts`. Receivers recompute HMAC-SHA256 of
// `<timestamp>.<body>` using the endpoint's secret and constant-time
// compare against the prefixed header value. Web Crypto is used here
// (rather than `node:crypto`) so the SDK stays runtime-portable across
// Node 19+ and modern browsers without picking up `@types/node`.
export const WEBHOOK_SIGNATURE_SCHEME = "v1";
export const WEBHOOK_DEFAULT_TOLERANCE_MS = 5 * 60_000;

const SIGNATURE_HEADER = "x-junjo-signature";
const TIMESTAMP_HEADER = "x-junjo-timestamp";

export interface VerifyOptions {
  // Maximum allowed clock skew between the signing timestamp and `now`,
  // in milliseconds. Defaults to 5 minutes. Set higher only if your
  // receiver and Junjo's clock are known to drift.
  tolerance?: number;
  // Override the wall clock for tests. Defaults to `() => new Date()`.
  now?: () => Date;
}

export type WebhookHeaders =
  | WebhookSignatureHeaders
  | Record<string, string | string[] | undefined>;

export interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Uint8Array | string;
}

export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  send(body?: unknown): void;
  sendStatus(code: number): void;
}

export type ExpressLikeMiddleware = (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next: (err?: unknown) => void,
) => Promise<void>;

function pickHeader(headers: WebhookHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[0];
  }
  return undefined;
}

function bodyToString(body: string | Uint8Array): string {
  if (typeof body === "string") return body;
  return new TextDecoder("utf-8").decode(body);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

// HMAC-SHA256 of `<timestamp>.<body>`, hex, prefixed with the scheme
// version. Mirrors `signWebhookBody` in the server's `webhookWorker.ts`.
export async function signWebhookBody(
  secret: string,
  body: string,
  timestamp: string,
): Promise<string> {
  const sig = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return `${WEBHOOK_SIGNATURE_SCHEME}=${sig}`;
}

// Compare two strings of equal length without short-circuiting on the
// first byte that differs. Web Crypto has no public timingSafeEqual.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Verifies the signature on a webhook delivery and returns the parsed
// JunjoEvent. Throws JunjoError on missing headers, malformed timestamp,
// out-of-tolerance timestamp, signature mismatch, or unparseable body.
export async function verifyWebhook(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  opts: VerifyOptions = {},
): Promise<JunjoEvent> {
  const tolerance = opts.tolerance ?? WEBHOOK_DEFAULT_TOLERANCE_MS;
  const now = opts.now ?? (() => new Date());

  const signatureHeader = pickHeader(headers, SIGNATURE_HEADER);
  if (!signatureHeader) {
    throw new JunjoError(`missing ${SIGNATURE_HEADER} header`, "webhook_signature_missing", 400);
  }

  const timestampHeader = pickHeader(headers, TIMESTAMP_HEADER);
  if (!timestampHeader) {
    throw new JunjoError(`missing ${TIMESTAMP_HEADER} header`, "webhook_timestamp_missing", 400);
  }

  const timestampMs = Date.parse(timestampHeader);
  if (Number.isNaN(timestampMs)) {
    throw new JunjoError(
      `${TIMESTAMP_HEADER} is not a valid ISO 8601 timestamp`,
      "webhook_timestamp_invalid",
      400,
    );
  }

  const skew = Math.abs(now().getTime() - timestampMs);
  if (skew > tolerance) {
    throw new JunjoError(
      `signature timestamp is outside the ${tolerance}ms tolerance window`,
      "webhook_timestamp_out_of_tolerance",
      400,
    );
  }

  const body = bodyToString(rawBody);
  const expected = await signWebhookBody(secret, body, timestampHeader);
  if (!constantTimeEqual(signatureHeader, expected)) {
    throw new JunjoError("webhook signature does not match", "webhook_invalid_signature", 400);
  }

  let parsed: WireJunjoEvent;
  try {
    parsed = JSON.parse(body) as WireJunjoEvent;
  } catch {
    throw new JunjoError("webhook body is not valid JSON", "webhook_invalid_body", 400);
  }

  return deserializeEvent(parsed);
}

function readMiddlewareBody(req: ExpressLikeRequest): string | Uint8Array | null {
  if (req.rawBody !== undefined) return req.rawBody;
  if (typeof req.body === "string") return req.body;
  if (req.body instanceof Uint8Array) return req.body;
  return null;
}

interface WireWebhookEndpoint {
  id: string;
  gameId: string;
  url: string;
  events: string[];
  createdAt: string;
  disabledAt: string | null;
}

interface WireWebhookEndpointWithSecret extends WireWebhookEndpoint {
  secret: string;
}

function deserializeEndpoint(w: WireWebhookEndpoint): WebhookEndpoint {
  return {
    id: w.id as WebhookEndpointId,
    gameId: w.gameId as GameId,
    url: w.url,
    events: w.events as JunjoEventType[],
    createdAt: new Date(w.createdAt),
    disabledAt: w.disabledAt === null ? null : new Date(w.disabledAt),
  };
}

function deserializeEndpointWithSecret(
  w: WireWebhookEndpointWithSecret,
): WebhookEndpointWithSecret {
  return { ...deserializeEndpoint(w), secret: w.secret };
}

// CRUD for webhook endpoints. Reachable as `junjo.webhooks.endpoints`.
// Endpoint configuration is per-game; all routes are scoped by the
// calling API key.
export class WebhookEndpointsApi {
  constructor(private readonly http: HttpClient) {}

  // Creates an endpoint and returns it including the signing secret.
  // The secret is returned exactly once; persist it server-side
  // immediately. Subsequent `list` and `update` calls do not return it.
  async create(input: CreateWebhookEndpointInput): Promise<WebhookEndpointWithSecret> {
    const body: Record<string, unknown> = { url: input.url };
    if (input.events !== undefined) body.events = input.events;
    if (input.secret !== undefined) body.secret = input.secret;
    const wire = await this.http.post<WireWebhookEndpointWithSecret>("/v1/webhooks", body);
    return deserializeEndpointWithSecret(wire);
  }

  // Returns every endpoint configured for the calling game, newest first.
  // No pagination (typical games have a handful; if needed later, this is
  // an additive change to add `?limit&cursor`).
  async list(): Promise<WebhookEndpoint[]> {
    const wire = await this.http.get<{ items: WireWebhookEndpoint[] }>("/v1/webhooks");
    return wire.items.map(deserializeEndpoint);
  }

  // Partial update. At least one field is required. `disabled: true` mutes
  // the endpoint (matching events stop enqueueing); `disabled: false`
  // un-mutes. Returns the post-state endpoint without the secret.
  async update(id: WebhookEndpointId, input: UpdateWebhookEndpointInput): Promise<WebhookEndpoint> {
    const body: Record<string, unknown> = {};
    if (input.url !== undefined) body.url = input.url;
    if (input.events !== undefined) body.events = input.events;
    if (input.disabled !== undefined) body.disabled = input.disabled;
    const wire = await this.http.patch<WireWebhookEndpoint>(
      `/v1/webhooks/${encodeURIComponent(id)}`,
      body,
    );
    return deserializeEndpoint(wire);
  }

  // Hard-deletes the endpoint. Pending deliveries are cascaded by the
  // database. Idempotency on a missing id throws `JunjoError` with
  // `code: "not_found"`.
  async delete(id: WebhookEndpointId): Promise<void> {
    await this.http.delete<void>(`/v1/webhooks/${encodeURIComponent(id)}`);
  }
}

export class WebhooksApi {
  readonly endpoints: WebhookEndpointsApi;

  constructor(http: HttpClient) {
    this.endpoints = new WebhookEndpointsApi(http);
  }

  // Validates the signature, parses the JunjoEvent, and returns it. Pass
  // `req.body` (or `req.rawBody` if you have a JSON body parser ahead of
  // this call) and `req.headers` from your Express handler.
  verify(
    rawBody: string | Uint8Array,
    headers: WebhookHeaders,
    secret: string,
    opts?: VerifyOptions,
  ): Promise<JunjoEvent> {
    return verifyWebhook(rawBody, headers, secret, opts);
  }

  // Express-compatible middleware. Mount AFTER `express.raw({ type: "application/json" })`
  // so `req.body` is a Buffer; the verified `JunjoEvent` replaces `req.body`
  // before `next()` runs. On verification failure responds 400 with the
  // JunjoError message and does not call `next()`.
  middleware(secret: string, opts?: VerifyOptions): ExpressLikeMiddleware {
    return async (req, res, next) => {
      const body = readMiddlewareBody(req);
      if (body === null) {
        res
          .status(400)
          .send("webhook middleware requires a raw body (use express.raw before this handler)");
        return;
      }
      let event: JunjoEvent;
      try {
        event = await verifyWebhook(body, req.headers, secret, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : "webhook verification failed";
        res.status(400).send(message);
        return;
      }
      req.body = event;
      next();
    };
  }
}
