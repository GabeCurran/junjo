import { randomBytes } from "node:crypto";
import type { PrismaClient, WebhookEndpoint } from "@prisma/client";
import { Hono } from "hono";
import { Errors } from "../errors.js";
import { assertSafeWebhookUrl } from "../webhookUrlGuard.js";
import {
  createWebhookEndpointBody,
  listWebhookEndpointsQuery,
  updateWebhookEndpointBody,
} from "./webhooks.schema.js";

export interface WebhooksRouterOptions {
  // Operator escape hatch for self-host development. Production cloud
  // leaves this false and refuses to deliver to loopback / private hosts.
  allowPrivateHosts?: boolean;
}

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

// 32 random bytes -> base64url, ~43 chars; used when the dev does not
// supply their own secret on `endpoints.create`.
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function webhooksRouter(prisma: PrismaClient, opts: WebhooksRouterOptions = {}): Hono {
  const r = new Hono();
  const guardOpts = { allowPrivateHosts: opts.allowPrivateHosts ?? false };

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
    assertSafeWebhookUrl(url, guardOpts);
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
    return c.json(wire, 201);
  });

  r.get("/", async (c) => {
    const gameId = c.var.gameId;
    const parsed = listWebhookEndpointsQuery.safeParse({
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, cursor } = parsed.data;

    let cursorRow: { id: string; createdAt: Date } | null = null;
    if (cursor) {
      const row = await prisma.webhookEndpoint.findFirst({
        where: { id: cursor, gameId },
        select: { id: true, createdAt: true },
      });
      if (!row) throw Errors.badRequest("invalid cursor");
      cursorRow = row;
    }

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: {
        gameId,
        ...(cursorRow
          ? {
              OR: [
                { createdAt: { lt: cursorRow.createdAt } },
                { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = endpoints.length > limit;
    const sliced = hasMore ? endpoints.slice(0, limit) : endpoints;
    const lastItem = sliced[sliced.length - 1];
    return c.json({
      items: sliced.map(serializeWebhookEndpoint),
      nextCursor: hasMore && lastItem ? lastItem.id : null,
    });
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
      assertSafeWebhookUrl(url, guardOpts);
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
