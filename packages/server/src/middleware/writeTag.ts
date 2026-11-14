import { WRITE_TAG_HEADER, WRITE_TAG_MAX_LENGTH } from "@junjo.io/shared";
import type { MiddlewareHandler } from "hono";
import { Errors } from "../errors.js";
import { currentRequestContext } from "../requestContext.js";

// Printable ASCII without spaces, like Idempotency-Key.
const TAG_PATTERN = new RegExp(`^[\\x21-\\x7e]{1,${WRITE_TAG_MAX_LENGTH}}$`);

// Reads the optional `Junjo-Write-Tag` header into the request context,
// where event minting stamps it on every event the request causes. A
// malformed tag is a 400, so a writer never believes it tagged a write
// that went out untagged. Must run inside the request context.
export function writeTagMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.header(WRITE_TAG_HEADER);
    if (raw !== undefined) {
      if (!TAG_PATTERN.test(raw)) {
        throw Errors.badRequest(
          `${WRITE_TAG_HEADER} must be 1 to ${WRITE_TAG_MAX_LENGTH} printable ASCII characters with no spaces`,
        );
      }
      const ctx = currentRequestContext();
      if (ctx) ctx.writeTag = raw;
    }
    await next();
  };
}
