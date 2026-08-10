import { describe, expect, it, vi } from "vitest";
import { JunjoError } from "./errors.js";
import { HttpClient } from "./http.js";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

// A fetch that never settles on its own but rejects with AbortError as
// soon as the provided signal aborts, mirroring real fetch semantics.
function hangingFetch() {
  return vi.fn(
    (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  );
}

function makeClient(
  fetchMock: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  opts?: { apiKey?: string; timeoutMs?: number },
): HttpClient {
  return new HttpClient({
    apiKey: opts && "apiKey" in opts ? opts.apiKey : "test_key",
    baseUrl: "https://example.test",
    fetch: fetchMock as unknown as typeof fetch,
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

describe("HttpClient transport failures", () => {
  it("maps a fetch rejection to code 'network_error' and preserves the cause", async () => {
    const boom = new TypeError("fetch failed: getaddrinfo ENOTFOUND");
    const fetchMock = vi.fn(async () => {
      throw boom;
    });
    const client = makeClient(fetchMock);

    const err = await client.get("/v1/whoami").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JunjoError);
    const junjoErr = err as JunjoError;
    expect(junjoErr.code).toBe("network_error");
    expect(junjoErr.status).toBeUndefined();
    expect(junjoErr.message).toContain("fetch failed: getaddrinfo ENOTFOUND");
    expect(junjoErr.cause).toBe(boom);
  });

  it("maps an elapsed timeoutMs to code 'timeout'", async () => {
    const fetchMock = hangingFetch();
    const client = makeClient(fetchMock, { timeoutMs: 10 });

    await expect(client.get("/v1/whoami")).rejects.toMatchObject({
      name: "JunjoError",
      code: "timeout",
    });
  });

  it("honors a per-request timeoutMs override", async () => {
    const fetchMock = hangingFetch();
    // Client-level timeout is generous; the per-request override fires.
    const client = makeClient(fetchMock, { timeoutMs: 60_000 });

    await expect(client.get("/v1/whoami", { timeoutMs: 10 })).rejects.toMatchObject({
      name: "JunjoError",
      code: "timeout",
    });
  });

  it("times out a response whose BODY stalls after headers arrive", async () => {
    // Headers land immediately, then the body stream never produces
    // data until the abort signal errors it, mirroring a middlebox
    // that forwards headers and stalls. The composed abort must stay
    // armed through body consumption or this hangs forever.
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = makeClient(fetchMock, { timeoutMs: 10 });

    await expect(client.get("/v1/whoami")).rejects.toMatchObject({
      name: "JunjoError",
      code: "timeout",
    });
  });

  it("cancels a stalled body read via the caller's signal", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          signal?.addEventListener(
            "abort",
            () =>
              streamController.error(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        },
      });
      queueMicrotask(() => controller.abort());
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = makeClient(fetchMock, { timeoutMs: 0 });

    await expect(client.get("/v1/whoami", { signal: controller.signal })).rejects.toMatchObject({
      name: "JunjoError",
      code: "cancelled",
    });
  });

  it("surfaces Retry-After on rate-limited responses as retryAfterSeconds", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          code: "rate_limit_exceeded",
          status: 429,
          message: "rate limit exceeded; retry after 7s",
        },
        429,
        { "retry-after": "7" },
      ),
    );
    const client = makeClient(fetchMock);

    const err = await client.get("/v1/groups").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as JunjoError,
    );
    expect(err.code).toBe("rate_limit_exceeded");
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(7);
  });

  it("leaves retryAfterSeconds undefined when the header is absent or malformed", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "group not found" }, 404),
    );
    const client = makeClient(fetchMock);
    const err = await client.get("/v1/groups/x").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as JunjoError,
    );
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("maps a pre-aborted caller signal to code 'cancelled'", async () => {
    const fetchMock = hangingFetch();
    const client = makeClient(fetchMock);

    const controller = new AbortController();
    controller.abort();
    await expect(client.get("/v1/whoami", { signal: controller.signal })).rejects.toMatchObject({
      name: "JunjoError",
      code: "cancelled",
    });
  });

  it("maps a mid-flight caller abort to code 'cancelled'", async () => {
    const fetchMock = hangingFetch();
    const client = makeClient(fetchMock);

    const controller = new AbortController();
    const pending = client.get("/v1/whoami", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "JunjoError", code: "cancelled" });
  });

  it("passes no signal to fetch when timeoutMs is 0 and no caller signal is given", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeUndefined();
      return jsonResponse({ ok: true });
    });
    const client = makeClient(fetchMock, { timeoutMs: 0 });

    await expect(client.get<{ ok: boolean }>("/v1/whoami")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("HttpClient error responses", () => {
  it("throws the envelope's exact code, status, message, and requestId", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { code: "not_found", status: 404, message: "group does not exist", requestId: "req_123" },
        404,
      ),
    );
    const client = makeClient(fetchMock);

    await expect(client.get("/v1/groups/ghost")).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
      status: 404,
      message: "group does not exist",
      requestId: "req_123",
    });
  });

  it("falls back to the x-request-id header when the body has no requestId", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: "permission_denied", status: 403, message: "nope" }, 403, {
        "x-request-id": "req_from_header",
      }),
    );
    const client = makeClient(fetchMock);

    await expect(client.get("/v1/groups")).rejects.toMatchObject({
      name: "JunjoError",
      code: "permission_denied",
      requestId: "req_from_header",
    });
  });

  it("throws code 'unknown' with the transport status for a non-envelope non-2xx body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "content-type": "text/html" },
        }),
    );
    const client = makeClient(fetchMock);

    await expect(client.get("/v1/groups")).rejects.toMatchObject({
      name: "JunjoError",
      code: "unknown",
      status: 502,
    });
  });

  it("throws code 'invalid_wire_data' for a malformed 2xx body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("definitely not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = makeClient(fetchMock);

    await expect(client.get("/v1/groups")).rejects.toMatchObject({
      name: "JunjoError",
      code: "invalid_wire_data",
      status: 200,
    });
  });
});

describe("HttpClient successful responses", () => {
  it("resolves undefined for a 204 response", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const client = makeClient(fetchMock);

    await expect(client.delete("/v1/roles/role_1")).resolves.toBeUndefined();
  });

  it("serializes the JSON body with content-type application/json", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://example.test/v1/groups");
      const req = new Request(String(url), init);
      expect(req.method).toBe("POST");
      expect(req.headers.get("content-type")).toBe("application/json");
      expect(await req.json()).toEqual({ name: "The Guild" });
      return jsonResponse({ id: "grp_1" });
    });
    const client = makeClient(fetchMock);

    await client.post("/v1/groups", { name: "The Guild" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("omits the authorization header when no apiKey is configured (proxy mode)", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(String(url), init);
      expect(req.headers.get("authorization")).toBeNull();
      return jsonResponse({ ok: true });
    });
    const client = makeClient(fetchMock, { apiKey: undefined });

    await client.get("/v1/groups");
  });
});

describe("HttpClient header precedence", () => {
  it("SDK-owned authorization and content-type beat caller-supplied headers", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(String(url), init);
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toBe("application/json");
      expect(req.headers.get("x-custom")).toBe("kept");
      return jsonResponse({ ok: true });
    });
    const client = makeClient(fetchMock);

    await client.post(
      "/v1/groups",
      { name: "x" },
      {
        headers: {
          authorization: "Bearer attacker_key",
          "content-type": "text/plain",
          "x-custom": "kept",
        },
      },
    );
  });
});

describe("HttpClient.postRaw", () => {
  it("forwards the body unencoded with the caller's content-type", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(String(url), init);
      expect(req.method).toBe("POST");
      expect(String(url)).toBe("https://example.test/v1/groups/grp_1/bulk-invite");
      expect(req.headers.get("content-type")).toBe("text/csv");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(await req.text()).toBe("userId\nuser_alice\n");
      return jsonResponse({ invited: 1, skipped: 0, errors: [] });
    });
    const client = makeClient(fetchMock);

    const result = await client.postRaw<{ invited: number }>(
      "/v1/groups/grp_1/bulk-invite",
      "userId\nuser_alice\n",
      "text/csv",
    );
    expect(result.invited).toBe(1);
  });
});
