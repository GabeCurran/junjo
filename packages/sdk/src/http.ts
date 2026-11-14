import { JunjoError } from "./errors.js";

/**
 * Applied when neither JunjoConfig.timeoutMs nor a per-request
 * timeoutMs is set. Generous enough for slow list queries against a
 * cold database, short enough that a black-holed connection surfaces
 * as a typed timeout instead of hanging a game server forever.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Constructor options for {@link HttpClient}. */
export interface HttpClientOptions {
  /**
   * Absent in proxy mode: the developer's backend proxy injects the real
   * credential, so the SDK attaches no authorization header at all.
   */
  apiKey?: string;
  /** Sent as `Junjo-Write-Tag` on every request unless one overrides it. */
  writeTag?: string;
  baseUrl: string;
  fetch: typeof fetch;
  /**
   * Default per-request timeout. 0 disables the built-in timeout
   * entirely (callers can still pass their own AbortSignal).
   */
  timeoutMs?: number;
}

interface ServerErrorBody {
  code?: string;
  status?: number;
  message?: string;
  requestId?: string;
  details?: unknown;
}

/** Per-request options accepted by every {@link HttpClient} method. */
export interface RequestOptions {
  headers?: Record<string, string>;
  /** Cancels the request; surfaces as JunjoError code "cancelled". */
  signal?: AbortSignal;
  /** Overrides the client-level timeout for this request. 0 disables. */
  timeoutMs?: number;
}

/**
 * Options accepted by every method that writes. The SDK never retries
 * on its own; these make a caller's own retry safe.
 */
export interface WriteOptions {
  /** Cancels the request; surfaces as JunjoError code "cancelled". */
  signal?: AbortSignal;
  /** Overrides the client-level timeout for this request. 0 disables. */
  timeoutMs?: number;
  /**
   * Sent as the `Idempotency-Key` header: 1 to 255 printable ASCII
   * characters, no spaces. A repeat with the same key and the same
   * request returns the first answer without running the write again;
   * the same key with a different request fails with
   * `idempotency_key_reused`, and a repeat while the first is still
   * running fails with `idempotency_key_in_progress`. The server keeps
   * keys for 24 hours and ignores them on requests without an API key.
   */
  idempotencyKey?: string;
  /**
   * Sent as the `Junjo-Write-Tag` header: 1 to 128 printable ASCII
   * characters, no spaces. Every event the write causes carries it as
   * `origin.tag`, so a writer can recognise its own changes on the
   * stream. Overrides the client-level `writeTag` for this call.
   */
  writeTag?: string;
}

/**
 * Options for writes the server can make conditional on a version: the
 * member-scoped writes (member version), game ban create and lift
 * (moderation version), and group update and delete (group version).
 */
export interface ConditionalWriteOptions extends WriteOptions {
  /**
   * The version the write expects, sent as `If-Match: "<version>"`. A
   * string that is already a quoted entity tag is sent unchanged. A
   * mismatch fails with `precondition_failed` and writes nothing.
   */
  ifMatch?: number | string;
}

/**
 * Options for writes the server can make create-only: `members.add`.
 */
export interface CreateOnlyWriteOptions extends WriteOptions {
  /**
   * `"*"` makes the write create-only, sent as `If-None-Match: *`. It
   * applies only when the target does not exist yet in any state, and
   * otherwise fails with `precondition_failed` and writes nothing.
   */
  ifNoneMatch?: "*";
}

// Maps write options onto transport options. A string `ifMatch` is
// quoted unless it already is, so an ETag value and a bare version
// produce the same header.
export function writeOptions(
  opts?: ConditionalWriteOptions & CreateOnlyWriteOptions,
): RequestOptions {
  const headers: Record<string, string> = {};
  if (opts?.idempotencyKey !== undefined) headers["idempotency-key"] = opts.idempotencyKey;
  if (opts?.ifMatch !== undefined) {
    const tag = String(opts.ifMatch).trim();
    headers["if-match"] = /^".*"$/.test(tag) ? tag : `"${tag}"`;
  }
  if (opts?.ifNoneMatch !== undefined) headers["if-none-match"] = opts.ifNoneMatch;
  if (opts?.writeTag !== undefined) headers["junjo-write-tag"] = opts.writeTag;
  return { signal: opts?.signal, timeoutMs: opts?.timeoutMs, headers };
}

// Composes the caller's signal with the client timeout and remembers
// which source fired so the catch path can classify the failure.
interface ComposedAbort {
  signal: AbortSignal | undefined;
  classify: () => "timeout" | "cancelled" | null;
  cleanup: () => void;
}

function composeAbort(callerSignal: AbortSignal | undefined, timeoutMs: number): ComposedAbort {
  if (!callerSignal && timeoutMs <= 0) {
    return { signal: undefined, classify: () => null, cleanup: () => {} };
  }

  const controller = new AbortController();
  // First cause wins: whichever source aborts first records itself, so
  // a caller abort and a timer firing in the same tick classify
  // deterministically instead of by check order.
  let reason: "timeout" | "cancelled" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onCallerAbort = () => {
    reason ??= "cancelled";
    controller.abort();
  };
  if (callerSignal) {
    if (callerSignal.aborted) {
      reason = "cancelled";
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }
  if (timeoutMs > 0 && reason === null) {
    timer = setTimeout(() => {
      reason ??= "timeout";
      controller.abort();
    }, timeoutMs);
    // Never hold a game server's event loop open for a pending timeout.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
  }

  return {
    signal: controller.signal,
    classify: () => reason,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

// Translates a rejection that happened under a composed abort into the
// matching typed JunjoError.
function abortError(err: unknown, abort: ComposedAbort): JunjoError {
  const reason = abort.classify();
  if (reason === "timeout") {
    return new JunjoError("request timed out", "timeout", undefined, { cause: err });
  }
  if (reason === "cancelled") {
    return new JunjoError("request cancelled", "cancelled", undefined, { cause: err });
  }
  return new JunjoError(
    err instanceof Error && err.message ? `network error: ${err.message}` : "network error",
    "network_error",
    undefined,
    { cause: err },
  );
}

/**
 * Low-level HTTP transport shared by every API namespace. Exported for
 * advanced use, but internal-ish: its surface can change between minor
 * versions. Prefer the typed namespaces on {@link Junjo}.
 */
export class HttpClient {
  private readonly apiKey: string | undefined;
  private readonly writeTag: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.apiKey = opts.apiKey;
    this.writeTag = opts.writeTag;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // Lowest-precedence headers: a request's own options override them.
  private defaultHeaders(): Record<string, string> {
    return this.writeTag === undefined ? {} : { "junjo-write-tag": this.writeTag };
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` };
  }

  // Runs fetch AND full body consumption under one composed abort
  // signal, translating failures into typed JunjoErrors: "timeout"
  // when the built-in (or overridden) timeout fired, "cancelled" when
  // the caller's signal aborted, "network_error" for everything fetch
  // itself rejects with (DNS, refused connection, TLS, offline). The
  // abort stays armed until the body is fully read: a server that
  // sends headers and then stalls the body must still surface as a
  // timeout, not a hang.
  private async performRequest<T>(
    url: string,
    init: RequestInit,
    opts: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    const abort = composeAbort(opts.signal, opts.timeoutMs ?? this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: abort.signal });
      } catch (err) {
        throw abortError(err, abort);
      }
      return await this.parseResponse<T>(res, abort);
    } finally {
      abort.cleanup();
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    // Caller headers are spread first so the SDK-owned values win: a
    // stray `authorization` or `content-type` in opts.headers must not
    // silently clobber the credential or the JSON encoding.
    const headers: Record<string, string> = {
      ...this.defaultHeaders(),
      ...(opts.headers ?? {}),
      ...this.authHeaders(),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    };
    return this.performRequest<T>(
      url,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      opts,
    );
  }

  /**
   * The body is forwarded to fetch unencoded; the caller owns
   * serialization. Extra `headers` are spread first, as in `request`.
   */
  async postRaw<T>(
    path: string,
    body: string | ReadableStream<Uint8Array>,
    contentType: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return this.performRequest<T>(
      url,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders(),
          ...(opts.headers ?? {}),
          ...this.authHeaders(),
          "content-type": contentType,
        },
        body,
      },
      opts,
    );
  }

  /**
   * Returns the raw Response with the body still open. Non-2xx still
   * throws `JunjoError`; the caller is responsible for draining the body.
   * The client timeout deliberately does NOT apply: an SSE response
   * stays open indefinitely by design, and a fetch signal covers the
   * whole response lifetime, not just connection establishment. The
   * caller's signal is the cancellation surface. Extra `headers` are
   * spread first, so the credential and `accept` stay SDK-owned.
   * `accept` defaults to `text/event-stream`.
   */
  async openStream(
    path: string,
    opts?: { signal?: AbortSignal; headers?: Record<string, string>; accept?: string },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          ...(opts?.headers ?? {}),
          ...this.authHeaders(),
          accept: opts?.accept ?? "text/event-stream",
        },
        signal: opts?.signal,
      });
    } catch (err) {
      if (opts?.signal?.aborted) {
        throw new JunjoError("request cancelled", "cancelled", undefined, { cause: err });
      }
      throw new JunjoError(
        err instanceof Error && err.message ? `network error: ${err.message}` : "network error",
        "network_error",
        undefined,
        { cause: err },
      );
    }
    if (!res.ok) {
      await this.throwResponseError(res);
    }
    return res;
  }

  // Reads the canonical error envelope ({ code, status, message,
  // requestId?, details? }) off a non-2xx response and throws the matching
  // JunjoError. A body that is not the envelope (an HTML 502 from a
  // proxy, an empty body) throws code "unknown" with the transport
  // status, never a fabricated server code. The server's code is
  // passed through even when this SDK version does not know it
  // (forward compat with newer servers; see JunjoErrorCode). On 429s
  // the Retry-After header is surfaced as retryAfterSeconds so callers
  // can implement honest backoff.
  private async throwResponseError(res: Response, abort?: ComposedAbort): Promise<never> {
    let parsed: ServerErrorBody = {};
    try {
      parsed = (await res.json()) as ServerErrorBody;
    } catch (err) {
      if (abort?.classify()) throw abortError(err, abort);
      parsed = {};
    }
    const requestId =
      typeof parsed.requestId === "string"
        ? parsed.requestId
        : (res.headers.get("x-request-id") ?? undefined);
    const retryAfterRaw = res.headers.get("retry-after");
    const retryAfterSeconds =
      retryAfterRaw !== null && /^\d+$/.test(retryAfterRaw.trim())
        ? Number(retryAfterRaw.trim())
        : undefined;
    const message =
      (typeof parsed.message === "string" && parsed.message) ||
      res.statusText ||
      `request failed with HTTP ${res.status}`;
    // `details` is surfaced only when it is a plain object, so a caller
    // can index it without guarding against arrays or primitives.
    const details =
      parsed.details !== null &&
      typeof parsed.details === "object" &&
      !Array.isArray(parsed.details)
        ? (parsed.details as Record<string, unknown>)
        : undefined;
    throw new JunjoError(
      message,
      typeof parsed.code === "string" ? (parsed.code as JunjoError["code"]) : "unknown",
      parsed.status ?? res.status,
      {
        ...(requestId !== undefined ? { requestId } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        ...(details !== undefined ? { details } : {}),
      },
    );
  }

  private async parseResponse<T>(res: Response, abort?: ComposedAbort): Promise<T> {
    if (!res.ok) {
      await this.throwResponseError(res, abort);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      // An abort mid-body (stalled stream hitting the timeout, or a
      // caller cancellation) is a transport outcome, not wire garbage.
      if (abort?.classify()) throw abortError(err, abort);
      throw new JunjoError("response body was not valid JSON", "invalid_wire_data", res.status, {
        cause: err,
      });
    }
  }

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, body, opts);
  }

  get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, undefined, opts);
  }

  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, body, opts);
  }

  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, body, opts);
  }

  /**
   * Body is optional and uncommon for DELETE, but valid HTTP/1.1.
   * Used by `bans.remove(userId, { actorUserId })` to attribute the
   * unban without inventing a separate query-param surface. Note that
   * some proxies/CDNs strip DELETE bodies; the server treats the body
   * as optional, so the worst case is lost attribution, not a failure.
   */
  delete<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, body, opts);
  }
}
