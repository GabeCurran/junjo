import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { JunjoError } from "../errors.js";

// Hono `onError` handler. Turns a thrown JunjoError into the canonical
// JSON shape the SDK consumes; logs anything else and returns 500.
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof JunjoError) {
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  }
  console.error("[junjo-server] unhandled error", err);
  return c.json({ code: "internal", status: 500, message: "internal error" }, 500);
};
