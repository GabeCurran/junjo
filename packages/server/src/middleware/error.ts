import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { JunjoError } from "../errors.js";
import { logger } from "../logger.js";

// Hono `onError` handler. Turns a thrown JunjoError into the canonical
// JSON shape the SDK consumes; logs anything else and returns 500.
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof JunjoError) {
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  }
  logger.error({ err, path: c.req.path, method: c.req.method }, "unhandled error");
  return c.json({ code: "internal", status: 500, message: "internal error" }, 500);
};
