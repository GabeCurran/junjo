import type {
  CreateWebhookEndpointInput,
  GameId,
  JunjoEvent,
  JunjoEventType,
  UpdateWebhookEndpointInput,
  WebhookEndpoint,
  WebhookEndpointFormat,
  WebhookEndpointId,
  WebhookEndpointWithSecret,
  WebhookSignatureHeaders,
} from "@junjo/shared";
import { JunjoError } from "./errors.js";
import { type WireJunjoEvent, deserializeEvent } from "./events.js";
import type { HttpClient } from "./http.js";
import { parseWireDate } from "./wire.js";

// Must stay in sync with the signing layout in the server's
// `webhookWorker.ts`; bumping one without the other breaks every
// receiver. Web Crypto is used here (rather than `node:crypto`) so the
// SDK stays portable across Node 19+ and modern browsers without
// pulling in `@types/node`.
export const WEBHOOK_SIGNATURE_SCHEME = "v1";
export const WEBHOOK_DEFAULT_TOLERANCE_MS = 5 * 60_000;

const SIGNATURE_HEADER = "x-junjo-signature";
const TIMESTAMP_HEADER = "x-junjo-timestamp";

export interface VerifyOptions {
  // Maximum allowed clock skew, in milliseconds. Set higher only if
  // your receiver and Junjo's clock are known to drift.
  tolerance?: number;
  // Override the wall clock for tests.
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
// version. Mirrors the server's `signWebhookBody`.
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

export class WebhookEndpointsApi {
  constructor(private readonly http: HttpClient) {}

  // The signing secret is returned exactly once on create; persist it
  // immediately. `list` and `update` never surface it again.
  async create(input: CreateWebhookEndpointInput): Promise<WebhookEndpointWithSecret> {
    const body: Record<string, unknown> = { url: input.url };
    if (input.events !== undefined) body.events = input.events;
    if (input.secret !== undefined) body.secret = input.secret;
    if (input.format !== undefined) body.format = input.format;
    const wire = await this.http.post<WireWebhookEndpointWithSecret>("/v1/webhooks", body);
    return deserializeEndpointWithSecret(wire);
  }

  // No pagination by design: typical games have a handful of endpoints.
  // Adding `?limit&cursor` later is an additive change; the server already
  // returns the Page<T> envelope with nextCursor: null today.
  async list(): Promise<WebhookEndpoint[]> {
    const wire = await this.http.get<{
      items: WireWebhookEndpoint[];
      nextCursor: string | null;
    }>("/v1/webhooks");
    return wire.items.map(deserializeEndpoint);
  }

  // The secret is never surfaced by the response; it is only ever
  // returned by `create`.
  async update(id: WebhookEndpointId, input: UpdateWebhookEndpointInput): Promise<WebhookEndpoint> {
    const body: Record<string, unknown> = {};
    if (input.url !== undefined) body.url = input.url;
    if (input.events !== undefined) body.events = input.events;
    if (input.disabled !== undefined) body.disabled = input.disabled;
    if (input.format !== undefined) body.format = input.format;
    const wire = await this.http.patch<WireWebhookEndpoint>(
      `/v1/webhooks/${encodeURIComponent(id)}`,
      body,
    );
    return deserializeEndpoint(wire);
  }

  // Hard delete; pending deliveries are cascaded by the database.
  // Calling on a missing id throws `JunjoError` with `code: "not_found"`.
  async delete(id: WebhookEndpointId): Promise<void> {
    await this.http.delete<void>(`/v1/webhooks/${encodeURIComponent(id)}`);
  }
}

export class WebhooksApi {
  readonly endpoints: WebhookEndpointsApi;

  constructor(http: HttpClient) {
    this.endpoints = new WebhookEndpointsApi(http);
  }

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
  // before `next()` runs. On verification failure responds 400 with a
  // generic message plus the stable error code and does not call `next()`.
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
