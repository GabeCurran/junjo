import { z } from "zod";

const TAG_NAME = z.string().min(1).max(64);
const TAG_COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a #rrggbb hex string");

// POST /v1/users/:userId/friend-tags
export const createFriendTagBody = z
  .object({
    name: TAG_NAME,
    color: TAG_COLOR.optional(),
  })
  .strict();

// PATCH /v1/friend-tags/:id
export const updateFriendTagBody = z
  .object({
    name: TAG_NAME.optional(),
    color: TAG_COLOR.nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.color !== undefined, {
    message: "patch must include `name` or `color`",
  });

// PUT /v1/users/:userId/friends/:otherUserId/tags
export const setFriendTagsBody = z
  .object({
    tagIds: z.array(z.string().min(1)),
  })
  .strict();
