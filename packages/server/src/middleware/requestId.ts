import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

// Callers may thread their own correlation id through; anything
// oversized or containing characters that could smuggle content into
// log lines or response headers is replaced with a generated id.
const REQUEST_ID_MAX_LENGTH = 128;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]+$/;

// 9 random bytes -> 12 base64url chars. Short enough to read aloud off
// an error report, random enough to never collide in practice.
export function newRequestId(): string {
  return randomBytes(9).toString("base64url");
}

// Correlation id for every request: echoes a well-formed caller
// x-request-id or mints one, exposes it as c.var.requestId for log
// lines, and returns it on the response so "quote the x-request-id
// from the failing response" works in bug reports.
export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const supplied = c.req.header("x-request-id");
    const requestId =
      supplied && supplied.length <= REQUEST_ID_MAX_LENGTH && SAFE_REQUEST_ID.test(supplied)
        ? supplied
        : newRequestId();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  };
}
