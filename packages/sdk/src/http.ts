import { JunjoError } from "./errors.js";

export interface HttpClientOptions {
  apiKey: string;
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
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.headers ?? {}),
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
        authorization: `Bearer ${this.apiKey}`,
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
        authorization: `Bearer ${this.apiKey}`,
        accept: "text/event-stream",
      },
      signal: opts?.signal,
    });
    if (!res.ok) {
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
    return res;
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
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

  delete<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, undefined, opts);
  }
}
