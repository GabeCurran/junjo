import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorHandler } from "./error";
import { newRequestId, requestIdMiddleware } from "./requestId";

function buildApp() {
  const app = new Hono();
  app.use("*", requestIdMiddleware());
  app.onError(errorHandler);
  app.get("/ok", (c) => c.json({ requestId: c.var.requestId }));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  return app;
}

describe("requestIdMiddleware", () => {
  it("generates an id and returns it on the response header", async () => {
    const app = buildApp();
    const res = await app.request("/ok");
    const header = res.headers.get("x-request-id");
    expect(header).toBeTruthy();
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe(header);
  });

  it("echoes a well-formed caller-supplied id", async () => {
    const app = buildApp();
    const res = await app.request("/ok", {
      headers: { "x-request-id": "trace-abc_123.def" },
    });
    expect(res.headers.get("x-request-id")).toBe("trace-abc_123.def");
  });

  it("replaces an oversized supplied id", async () => {
    const app = buildApp();
    const res = await app.request("/ok", {
      headers: { "x-request-id": "a".repeat(200) },
    });
    const header = res.headers.get("x-request-id");
    expect(header).toBeTruthy();
    expect(header).not.toBe("a".repeat(200));
  });

  it("replaces a supplied id with unsafe characters", async () => {
    const app = buildApp();
    const res = await app.request("/ok", {
      headers: { "x-request-id": "bad id {with; braces}" },
    });
    const header = res.headers.get("x-request-id");
    expect(header).toBeTruthy();
    expect(header).not.toContain(" ");
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("includes the request id in the internal-error envelope", async () => {
    const app = buildApp();
    const res = await app.request("/boom", {
      headers: { "x-request-id": "boom-trace-1" },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; requestId?: string };
    expect(body.code).toBe("internal");
    expect(body.requestId).toBe("boom-trace-1");
    expect(res.headers.get("x-request-id")).toBe("boom-trace-1");
  });

  it("newRequestId produces distinct url-safe ids", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
