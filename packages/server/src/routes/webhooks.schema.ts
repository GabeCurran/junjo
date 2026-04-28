import { z } from "zod";

// Mirrors the `JunjoEventType` union in `@junjo/shared`. Kept in lockstep
// by hand: every published event type must appear here so the server can
// reject typo'd subscriptions on the create / update flow before they
// silently fail to match.
export const WEBHOOK_EVENT_TYPES = [
  "member.joined",
  "member.left",
  "member.invited",
  "role.created",
  "role.changed",
  "role.deleted",
  "permission.granted",
  "permission.revoked",
  "group.updated",
  "group.deleted",
  "group.relationship.changed",
] as const;

export type WebhookEventTypeString = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_URL_MAX_LENGTH = 2000;
export const WEBHOOK_SECRET_MIN_LENGTH = 16;
export const WEBHOOK_SECRET_MAX_LENGTH = 256;

const urlSchema = z
  .string()
  .min(1)
  .max(WEBHOOK_URL_MAX_LENGTH)
  .refine(
    (s) => {
      try {
        const u = new URL(s);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    },
    { message: "url must be a valid http(s) URL" },
  );

const secretSchema = z.string().min(WEBHOOK_SECRET_MIN_LENGTH).max(WEBHOOK_SECRET_MAX_LENGTH);

const eventsSchema = z.array(z.enum(WEBHOOK_EVENT_TYPES));

export const createWebhookEndpointBody = z.object({
  url: urlSchema,
  events: eventsSchema.optional(),
  secret: secretSchema.optional(),
});

export const updateWebhookEndpointBody = z
  .object({
    url: urlSchema.optional(),
    events: eventsSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine(
    (data) => data.url !== undefined || data.events !== undefined || data.disabled !== undefined,
    { message: "at least one field is required" },
  );

export type CreateWebhookEndpointBody = z.infer<typeof createWebhookEndpointBody>;
export type UpdateWebhookEndpointBody = z.infer<typeof updateWebhookEndpointBody>;
