import { randomBytes } from "node:crypto";
import type { PrismaClient, WebhookEndpoint } from "@prisma/client";
import { Hono } from "hono";
import { Errors } from "../errors.js";
import { createWebhookEndpointBody, updateWebhookEndpointBody } from "./webhooks.schema.js";

export interface WireWebhookEndpoint {
  id: string;
  gameId: string;
  url: string;
  events: string[];
  format: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface WireWebhookEndpointWithSecret extends WireWebhookEndpoint {
  secret: string;
}

export function serializeWebhookEndpoint(endpoint: WebhookEndpoint): WireWebhookEndpoint {
  return {
    id: endpoint.id,
    gameId: endpoint.gameId,
    url: endpoint.url,
    events: endpoint.events,
    format: endpoint.format,
    createdAt: endpoint.createdAt.toISOString(),
    disabledAt: endpoint.disabledAt ? endpoint.disabledAt.toISOString() : null,
  };
}

// 32 random bytes -> base64url. ~43 chars, URL-safe, well above the
// `WEBHOOK_SECRET_MIN_LENGTH` floor. Used when the dev does not supply
// their own secret on `endpoints.create`.
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function webhooksRouter(prisma: PrismaClient): Hono {
  const r = new Hono();

  r.post("/", async (c) => {
    const gameId = c.var.gameId;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw Errors.badRequest("body must be valid JSON");
    }
    const parsed = createWebhookEndpointBody.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid body");
    }
    const { url, events, secret, format } = parsed.data;
    const finalSecret = secret ?? generateWebhookSecret();

    const created = await prisma.webhookEndpoint.create({
      data: {
        gameId,
        url,
        secret: finalSecret,
        events: events ?? [],
        ...(format !== undefined ? { format } : {}),
      },
    });

    const wire: WireWebhookEndpointWithSecret = {
      ...serializeWebhookEndpoint(created),
      secret: finalSecret,
    };
    return c.json(wire);
  });

  r.get("/", async (c) => {
    const gameId = c.var.gameId;
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { gameId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return c.json({ items: endpoints.map(serializeWebhookEndpoint) });
  });

  r.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;

    const existing = await prisma.webhookEndpoint.findFirst({ where: { id, gameId } });
    if (!existing) throw Errors.notFound("webhook endpoint");

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw Errors.badRequest("body must be valid JSON");
    }
    const parsed = updateWebhookEndpointBody.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid body");
    }
    const { url, events, disabled, format } = parsed.data;

    const data: {
      url?: string;
      events?: string[];
      disabledAt?: Date | null;
      format?: string;
    } = {};
    if (url !== undefined && url !== existing.url) {
      data.url = url;
    }
    if (events !== undefined && !arraysEqual(events, existing.events)) {
      data.events = events;
    }
    if (disabled !== undefined) {
      const targetDisabled = disabled ? new Date() : null;
      const currentlyDisabled = existing.disabledAt !== null;
      if (disabled !== currentlyDisabled) {
        data.disabledAt = targetDisabled;
      }
    }
    if (format !== undefined && format !== existing.format) {
      data.format = format;
    }

    if (Object.keys(data).length === 0) {
      return c.json(serializeWebhookEndpoint(existing));
    }

    const updated = await prisma.webhookEndpoint.update({
      where: { id: existing.id },
      data,
    });
    return c.json(serializeWebhookEndpoint(updated));
  });

  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;

    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id, gameId },
      select: { id: true },
    });
    if (!existing) throw Errors.notFound("webhook endpoint");

    await prisma.webhookEndpoint.delete({ where: { id: existing.id } });
    return c.body(null, 204);
  });

  return r;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
