import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Errors, JunjoError } from "../errors.js";
import { logger } from "../logger.js";
import { isNulCharacterError } from "../prismaErrors.js";

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof JunjoError) {
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  }
  // Framework-level rejections (e.g. the bodyLimit middleware's 413)
  // arrive as HTTPException carrying their own response; return it as-is
  // rather than collapsing to a generic 500.
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  // A U+0000 anywhere in a stored string (an id, a reason, a metadata
  // value) is a client input error, not a server fault. Postgres is the
  // one place that rejects it, so it is recognised here rather than in
  // every request schema.
  if (isNulCharacterError(err)) {
    const invalid = Errors.badRequest("strings must not contain the NUL character (U+0000)");
    return c.json(invalid.toJSON(), 400);
  }
  // requestId is set by requestIdMiddleware; undefined only for errors
  // thrown before it runs (or in tests that mount errorHandler alone).
  const requestId = c.var.requestId;
  logger.error({ err, path: c.req.path, method: c.req.method, requestId }, "unhandled error");
  return c.json(
    {
      code: "internal",
      status: 500,
      message: "internal error",
      // Lets a developer quote the exact failing request when reporting
      // a problem; matches the x-request-id response header.
      ...(requestId ? { requestId } : {}),
    },
    500,
  );
};
