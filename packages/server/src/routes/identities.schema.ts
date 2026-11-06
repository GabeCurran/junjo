import { z } from "zod";

// POST /v1/link-codes/redeem. `code` is compared by hash after
// normalization, so its length bound only rejects absurd input.
export const redeemLinkCodeBody = z
  .object({
    code: z.string().min(1).max(64),
    userId: z.string().min(1).max(255),
  })
  .strict();
