import { z } from "zod";
import { pageLimit } from "./page.schema.js";

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
    limit: pageLimit(50),
    cursor: z.string().optional(),
  })
  .strict();

// GET /v1/users/:userId/friends?limit=&cursor=&tagId=&viewer=
//
// `tagId` filters the result to friends tagged with that tag. Tags are
// per-game (not network-wide); see `friendTags.ts` for the rationale.
// When `tagId` is supplied, the returned set is bounded to friend rows
// in the calling game (no scope=network expansion for tag filtering).
//
// `viewer` is an optional junjoUserId the caller wants the visibility
// rules evaluated against. Without it, the API-key caller is treated
// as admin and visibility is bypassed. With it, the friends-list 404s
// when the target's friendsListVisibility blocks the viewer.
export const listFriendsQuery = z
  .object({
    limit: pageLimit(50),
    cursor: z.string().optional(),
    tagId: z.string().min(1).optional(),
    viewer: z.string().min(1).optional(),
  })
  .strict();

// POST /v1/users/:userId/blocks
export const addBlockBody = z
  .object({
    targetJunjoUserId: z.string().min(1),
  })
  .strict();

// GET /v1/users/:userId/blocks
export const listBlocksQuery = z
  .object({
    limit: pageLimit(100),
  })
  .strict();
