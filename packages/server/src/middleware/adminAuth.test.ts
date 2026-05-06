import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adminAuthMiddleware } from "./adminAuth";
import { errorHandler } from "./error";

const ADMIN_TOKEN = "test-admin-token-9f2a";

function buildApp(token: string | undefined) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("/admin/*", adminAuthMiddleware(token));
  app.get("/admin/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("adminAuthMiddleware", () => {
  it("accepts a request whose Bearer token matches the configured admin token", async () => {
    const app = buildApp(ADMIN_TOKEN);
    const res = await app.request("/admin/ping", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("rejects when no Authorization header is present", async () => {
    const app = buildApp(ADMIN_TOKEN);
    const res = await app.request("/admin/ping");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("rejects when the Authorization header does not start with 'Bearer '", async () => {
    const app = buildApp(ADMIN_TOKEN);
    const res = await app.request("/admin/ping", {
      headers: { authorization: ADMIN_TOKEN },
    });
    expect(res.status).toBe(401);
  });

  it("rejects when the Bearer token is empty", async () => {
    // HTTP header values are normalized to strip trailing whitespace, so
    // sending `Bearer ` with a trailing space cannot guarantee the
    // middleware sees an empty token after slicing. The realistic empty
    // case is `Bearer` alone (no space + no token), which fails the
    // startsWith check; either way the response is the same envelope.
    const app = buildApp(ADMIN_TOKEN);
    const res = await app.request("/admin/ping", {
      headers: { authorization: "Bearer" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("rejects when the Bearer token is wrong (same length)", async () => {
    const app = buildApp(ADMIN_TOKEN);
    const wrong = "x".repeat(ADMIN_TOKEN.length);
    expect(wrong.length).toBe(ADMIN_TOKEN.length);
    const res = await app.request("/admin/ping", {
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects when the Bearer token is wrong (longer)", async () => {
    const app = buildApp(ADMIN_TOKEN);
    const res = await app.request("/admin/ping", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}-extra` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects when the Bearer token is wrong (shorter)", async () => {
    const app = buildApp(ADMIN_TOKEN);
    const res = await app.request("/admin/ping", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN.slice(0, 5)}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects every request when the configured token is undefined", async () => {
    const app = buildApp(undefined);
    const res = await app.request("/admin/ping", {
      headers: { authorization: "Bearer anything" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/disabled/i);
  });

  it("rejects every request when the configured token is the empty string", async () => {
    const app = buildApp("");
    const res = await app.request("/admin/ping", {
      headers: { authorization: "Bearer anything" },
    });
    expect(res.status).toBe(401);
  });

  it("trims whitespace from the bearer token before comparing", async () => {
    const app = buildApp(ADMIN_TOKEN);
    const res = await app.request("/admin/ping", {
      headers: { authorization: `Bearer   ${ADMIN_TOKEN}   ` },
    });
    expect(res.status).toBe(200);
  });

  it("treats Authorization header case-insensitively", async () => {
    const app = buildApp(ADMIN_TOKEN);
    const res = await app.request("/admin/ping", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});
