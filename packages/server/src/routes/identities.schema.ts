import { DISPLAY_NAME_MAX_LENGTH } from "@junjo.io/shared";
import { z } from "zod";

// PUT /v1/users/:userId/display-name. Null clears the name.
export const setDisplayNameBody = z
  .object({
    displayName: z.string().min(1).max(DISPLAY_NAME_MAX_LENGTH).nullable(),
  })
  .strict();

// POST /v1/link-codes/redeem. `code` is compared by hash after
// normalization, so its length bound only rejects absurd input.
export const redeemLinkCodeBody = z
  .object({
    code: z.string().min(1).max(64),
    userId: z.string().min(1).max(255),
  })
  .strict();
