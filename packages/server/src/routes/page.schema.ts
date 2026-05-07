import { z } from "zod";
import { getMaxPageSize } from "../config/runtime.js";

// Shared `limit` zod fragment for every list endpoint. The upper bound
// is read dynamically from the runtime config (settable via
// `setMaxPageSize` at boot from `JUNJO_MAX_PAGE_SIZE`). The default
// stays per-endpoint because pagination defaults vary.
//
// Implementation note: zod's `.max(N)` snapshots N at schema-definition
// time. We use `superRefine` so the cap is consulted on every request,
// which matters during tests (which override the cap) and lets one
// running process serve the new ceiling without restart.
export function pageLimit(defaultValue = 50) {
  return z.coerce
    .number()
    .int()
    .min(1)
    .superRefine((n, ctx) => {
      const cap = getMaxPageSize();
      if (n > cap) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: cap,
          inclusive: true,
          type: "number",
          message: `Number must be less than or equal to ${cap}`,
        });
      }
    })
    .default(defaultValue);
}
