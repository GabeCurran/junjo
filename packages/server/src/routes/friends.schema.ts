import { z } from "zod";

// POST /v1/users/:userId/friend-requests
export const sendFriendRequestBody = z
  .object({
    targetJunjoUserId: z.string().min(1),
  })
  .strict();

// GET /v1/users/:userId/friend-requests?direction=in|out|both&limit=&cursor=
export const listFriendRequestsQuery = z
  .object({
    direction: z.enum(["in", "out", "both"]).optional().default("both"),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    cursor: z.string().optional(),
  })
  .strict();

// GET /v1/users/:userId/friends?limit=&cursor=
export const listFriendsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    cursor: z.string().optional(),
  })
  .strict();
