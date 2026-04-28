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

// Shared HTTP helper used by every sub-namespace class. Sets the
// Authorization header, JSON-encodes bodies, parses JSON responses, and
// turns non-2xx responses into JunjoError instances that preserve the
// server's code, status, and message.
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
