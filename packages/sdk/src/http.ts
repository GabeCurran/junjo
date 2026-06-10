import { JunjoError } from "./errors.js";

export interface HttpClientOptions {
  // Absent in proxy mode: the developer's backend proxy injects the real
  // credential, so the SDK attaches no authorization header at all.
  apiKey?: string;
  baseUrl: string;
  fetch: typeof fetch;
}

interface ServerErrorBody {
  code?: string;
  status?: number;
  message?: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
}

export class HttpClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` };
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
      ...(opts.headers ?? {}),
      ...this.authHeaders(),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    };
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return this.parseResponse<T>(res);
  }

  // The body is forwarded to fetch unencoded; the caller owns serialization.
  async postRaw<T>(
    path: string,
    body: string | ReadableStream<Uint8Array>,
    contentType: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "content-type": contentType,
      },
      body,
    });
    return this.parseResponse<T>(res);
  }

  // Returns the raw Response with the body still open. Non-2xx still
  // throws `JunjoError`; the caller is responsible for draining the body.
  async openStream(path: string, opts?: { signal?: AbortSignal }): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        ...this.authHeaders(),
        accept: "text/event-stream",
      },
      signal: opts?.signal,
    });
    if (!res.ok) {
      await this.throwResponseError(res);
    }
    return res;
  }

  // Reads the canonical error envelope ({ code, status, message }) off a
  // non-2xx response and throws the matching JunjoError. Falls back to
  // the transport-level status when the body is not the envelope.
  private async throwResponseError(res: Response): Promise<never> {
    let parsed: ServerErrorBody = {};
    try {
      parsed = (await res.json()) as ServerErrorBody;
    } catch {
      parsed = {};
    }
    throw new JunjoError(
      parsed.message ?? res.statusText ?? "request failed",
      parsed.code ?? "internal",
      parsed.status ?? res.status,
    );
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      await this.throwResponseError(res);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
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

  // Body is optional and uncommon for DELETE, but valid HTTP/1.1.
  // Used by `bans.remove(userId, { actorUserId })` to attribute the
  // unban without inventing a separate query-param surface. Note that
  // some proxies/CDNs strip DELETE bodies; the server treats the body
  // as optional, so the worst case is lost attribution, not a failure.
  delete<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, body, opts);
  }
}
