import type {
  CreateWebhookEndpointInput,
  GameId,
  JunjoEvent,
  JunjoEventType,
  Page,
  UpdateWebhookEndpointInput,
  WebhookEndpoint,
  WebhookEndpointFormat,
  WebhookEndpointId,
  WebhookEndpointWithSecret,
  WebhookSignatureHeaders,
} from "@junjo.io/shared";
import { JunjoError } from "./errors.js";
import { UNKNOWN_EVENT_TYPE, type WireJunjoEvent, deserializeEvent } from "./events.js";
import type { HttpClient } from "./http.js";
import { paginate } from "./pagination.js";
import { parseWireDate } from "./wire.js";

/**
 * Signature scheme version prefixed onto every signature. Must stay in
 * sync with the signing layout in the server's `webhookWorker.ts`;
 * bumping one without the other breaks every receiver. Web Crypto is
 * used here (rather than `node:crypto`) so the SDK stays portable
 * across Node 20+ (the supported engines range) and modern browsers
 * without pulling in `@types/node`.
 */
export const WEBHOOK_SIGNATURE_SCHEME = "v1";
/** Default clock-skew tolerance for webhook verification (5 minutes). */
export const WEBHOOK_DEFAULT_TOLERANCE_MS = 5 * 60_000;

const SIGNATURE_HEADER = "x-junjo-signature";
const TIMESTAMP_HEADER = "x-junjo-timestamp";
const EVENT_ID_HEADER = "x-junjo-event-id";
const DELIVERY_ID_HEADER = "x-junjo-delivery-id";

/** Options for webhook verification. */
export interface VerifyOptions {
  /**
   * Maximum allowed clock skew, in milliseconds. Set higher only if
   * your receiver and Junjo's clock are known to drift.
   */
  tolerance?: number;
  /** Override the wall clock for tests. */
  now?: () => Date;
}

/**
 * Any headers object verification accepts: the typed signature headers
 * or a framework-style record (string, string[], or missing values).
 * Header names are matched case-insensitively.
 */
export type WebhookHeaders =
  | WebhookSignatureHeaders
  | Record<string, string | string[] | undefined>;

/** Structural request shape the middleware needs; matches Express. */
export interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Uint8Array | string;
}

/** Structural response shape the middleware needs; matches Express. */
export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  send(body?: unknown): void;
  sendStatus(code: number): void;
}

/** The middleware function shape returned by `WebhooksApi.middleware`. */
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

/**
 * HMAC-SHA256 of `<timestamp>.<body>`, hex, prefixed with the scheme
 * version. Mirrors the server's `signWebhookBody`.
 */
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

/**
 * Verifies a webhook delivery's signature and timestamp against the
 * endpoint secret and returns the deserialized event. Throws
 * `JunjoError` with a `webhook_*` code on any verification failure.
 * Pass the RAW request body exactly as received; re-serialized JSON
 * will not match the signature.
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  opts: VerifyOptions = {},
): Promise<JunjoEvent> {
  const payload = await verifyWebhookBody(rawBody, headers, secret, opts);
  return deserializeEvent(payload as WireJunjoEvent);
}

/**
 * The signature, timestamp, and JSON checks shared by every verifier,
 * stopping short of event deserialization. Returns the parsed body
 * verbatim; the `unknown` return is deliberate, nothing about the
 * payload shape has been validated beyond it being the JSON the server
 * signed.
 */
async function verifyWebhookBody(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  opts: VerifyOptions,
): Promise<unknown> {
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

  // The MAC is checked before the timestamp is even parsed: the
  // signature covers `<timestamp>.<body>` as raw strings, so this needs
  // no parsing, and it means unauthenticated senders get the same
  // `webhook_invalid_signature` for every probe instead of an oracle on
  // the receiver's clock and tolerance settings.
  const body = bodyToString(rawBody);
  const expected = await signWebhookBody(secret, body, timestampHeader);
  if (!constantTimeEqual(signatureHeader, expected)) {
    throw new JunjoError("webhook signature does not match", "webhook_invalid_signature", 400);
  }

  // Date.parse is lenient (it accepts more than ISO 8601), but the
  // timestamp is already authenticated at this point; the server only
  // ever signs ISO strings, so leniency here cannot loosen verification.
  const timestampMs = Date.parse(timestampHeader);
  if (Number.isNaN(timestampMs)) {
    throw new JunjoError(
      `${TIMESTAMP_HEADER} is not a valid timestamp`,
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

  try {
    return JSON.parse(body);
  } catch {
    throw new JunjoError("webhook body is not valid JSON", "webhook_invalid_body", 400);
  }
}

/** Result of {@link verifyWebhookWithMeta}. */
export interface VerifiedWebhook {
  event: JunjoEvent;
  /**
   * From x-junjo-event-id: stable per event, shared by every delivery
   * (and retry) of that event. The right key for dedupe.
   */
  eventId: string | undefined;
  /** From x-junjo-delivery-id: unique per delivery attempt. */
  deliveryId: string | undefined;
}

/**
 * Result of {@link verifyWebhookWithMeta} under `onUnknownType: "raw"`
 * when the delivery's event type is not in this SDK version's union.
 * The signature and timestamp checks passed; only deserialization was
 * skipped. `event: null` is the discriminant against
 * {@link VerifiedWebhook}.
 */
export interface UnknownVerifiedWebhook {
  event: null;
  /** The wire event type string, when the payload carries one. */
  eventType: string | undefined;
  /** The parsed body verbatim, shape unvalidated. */
  payload: unknown;
  eventId: string | undefined;
  deliveryId: string | undefined;
}

/** Options for {@link verifyWebhookWithMeta}. */
export interface VerifyWithMetaOptions extends VerifyOptions {
  /**
   * What to do when a delivery verifies but carries an event type this
   * SDK version does not know (a newer server). `"throw"` (the default)
   * throws `JunjoError` with code `unknown_event_type`. `"raw"` returns
   * an {@link UnknownVerifiedWebhook} instead, so receivers on match-all
   * endpoints keep acknowledging deliveries across server upgrades.
   */
  onUnknownType?: "throw" | "raw";
}

/**
 * Same verification as `verifyWebhook`, but also surfaces the delivery
 * identity headers so receivers can dedupe retries without re-reading
 * the headers object themselves. Both ids are undefined only when an
 * intermediary stripped the header; the signature check is unchanged.
 */
export async function verifyWebhookWithMeta(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  opts?: VerifyOptions & { onUnknownType?: "throw" },
): Promise<VerifiedWebhook>;
export async function verifyWebhookWithMeta(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  opts: VerifyWithMetaOptions,
): Promise<VerifiedWebhook | UnknownVerifiedWebhook>;
export async function verifyWebhookWithMeta(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  opts: VerifyWithMetaOptions = {},
): Promise<VerifiedWebhook | UnknownVerifiedWebhook> {
  const payload = await verifyWebhookBody(rawBody, headers, secret, opts);
  const eventId = pickHeader(headers, EVENT_ID_HEADER);
  const deliveryId = pickHeader(headers, DELIVERY_ID_HEADER);
  try {
    return { event: deserializeEvent(payload as WireJunjoEvent), eventId, deliveryId };
  } catch (err) {
    if (
      opts.onUnknownType === "raw" &&
      err instanceof JunjoError &&
      err.code === UNKNOWN_EVENT_TYPE
    ) {
      const type = (payload as { type?: unknown } | null)?.type;
      return {
        event: null,
        eventType: typeof type === "string" ? type : undefined,
        payload,
        eventId,
        deliveryId,
      };
    }
    throw err;
  }
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
  format: string;
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
    format: w.format as WebhookEndpointFormat,
    createdAt: parseWireDate(w.createdAt, "createdAt"),
    disabledAt: w.disabledAt === null ? null : parseWireDate(w.disabledAt, "disabledAt"),
  };
}

function deserializeEndpointWithSecret(
  w: WireWebhookEndpointWithSecret,
): WebhookEndpointWithSecret {
  return { ...deserializeEndpoint(w), secret: w.secret };
}

/** Webhook endpoint management: create, list, update, delete. */
export class WebhookEndpointsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * The signing secret is returned exactly once on create; persist it
   * immediately. `list` and `update` never surface it again.
   */
  async create(
    input: CreateWebhookEndpointInput,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<WebhookEndpointWithSecret> {
    const body: Record<string, unknown> = { url: input.url };
    if (input.events !== undefined) body.events = input.events;
    if (input.secret !== undefined) body.secret = input.secret;
    if (input.format !== undefined) body.format = input.format;
    const wire = await this.http.post<WireWebhookEndpointWithSecret>("/v1/webhooks", body, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return deserializeEndpointWithSecret(wire);
  }

  /**
   * Cursor-paginated (server default limit 50); `nextCursor` is the id
   * of the last item, fed back in as `cursor` for the next page.
   */
  async list(opts?: {
    limit?: number;
    cursor?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<Page<WebhookEndpoint>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    const qs = params.toString();
    const path = qs ? `/v1/webhooks?${qs}` : "/v1/webhooks";
    const wire = await this.http.get<{
      items: WireWebhookEndpoint[];
      nextCursor: string | null;
    }>(path, { signal: opts?.signal, timeoutMs: opts?.timeoutMs });
    return {
      items: wire.items.map(deserializeEndpoint),
      nextCursor: wire.nextCursor,
    };
  }

  /**
   * Async-iterator wrapper over `list(...)` that walks every page until
   * `nextCursor` is null. Endpoint counts are small in practice, but
   * this keeps the surface symmetric with the other paginated lists.
   */
  listAll(opts?: {
    limit?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): AsyncGenerator<WebhookEndpoint> {
    return paginate((cursor) => this.list({ ...opts, cursor }));
  }

  /**
   * The secret is never surfaced by the response; it is only ever
   * returned by `create`.
   */
  async update(
    id: WebhookEndpointId,
    input: UpdateWebhookEndpointInput,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<WebhookEndpoint> {
    const body: Record<string, unknown> = {};
    if (input.url !== undefined) body.url = input.url;
    if (input.events !== undefined) body.events = input.events;
    if (input.disabled !== undefined) body.disabled = input.disabled;
    if (input.format !== undefined) body.format = input.format;
    const wire = await this.http.patch<WireWebhookEndpoint>(
      `/v1/webhooks/${encodeURIComponent(id)}`,
      body,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeEndpoint(wire);
  }

  /**
   * Hard delete; pending deliveries are cascaded by the database.
   * Calling on a missing id throws `JunjoError` with `code: "not_found"`.
   */
  async delete(
    id: WebhookEndpointId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    await this.http.delete<void>(`/v1/webhooks/${encodeURIComponent(id)}`, undefined, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
  }
}

/**
 * Webhooks: endpoint management under `endpoints`, plus signature
 * verification helpers bound to the client for convenience.
 */
export class WebhooksApi {
  readonly endpoints: WebhookEndpointsApi;

  constructor(http: HttpClient) {
    this.endpoints = new WebhookEndpointsApi(http);
  }

  /** Verifies a delivery and returns the event. See `verifyWebhook`. */
  verify(
    rawBody: string | Uint8Array,
    headers: WebhookHeaders,
    secret: string,
    opts?: VerifyOptions,
  ): Promise<JunjoEvent> {
    return verifyWebhook(rawBody, headers, secret, opts);
  }

  /**
   * `verify` plus the event/delivery id headers, for dedupe. See
   * `verifyWebhookWithMeta`.
   */
  verifyWithMeta(
    rawBody: string | Uint8Array,
    headers: WebhookHeaders,
    secret: string,
    opts?: VerifyOptions & { onUnknownType?: "throw" },
  ): Promise<VerifiedWebhook>;
  verifyWithMeta(
    rawBody: string | Uint8Array,
    headers: WebhookHeaders,
    secret: string,
    opts: VerifyWithMetaOptions,
  ): Promise<VerifiedWebhook | UnknownVerifiedWebhook>;
  verifyWithMeta(
    rawBody: string | Uint8Array,
    headers: WebhookHeaders,
    secret: string,
    opts: VerifyWithMetaOptions = {},
  ): Promise<VerifiedWebhook | UnknownVerifiedWebhook> {
    return verifyWebhookWithMeta(rawBody, headers, secret, opts);
  }

  /**
   * Express-compatible middleware. Mount AFTER `express.raw({ type: "application/json" })`
   * so `req.body` is a Buffer; the verified `JunjoEvent` replaces `req.body`
   * before `next()` runs. On verification failure responds 400 with a
   * generic message plus the stable error code and does not call `next()`.
   */
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
        // Error messages can carry receiver internals (e.g. the tolerance
        // window), so only the stable code is reflected to the sender.
        // Full detail stays on the thrown JunjoError for direct verify()
        // callers, who own both sides of the exchange.
        const code = err instanceof JunjoError ? err.code : "webhook_verification_failed";
        res.status(400).send(`webhook verification failed (${code})`);
        return;
      }
      req.body = event;
      next();
    };
  }
}
