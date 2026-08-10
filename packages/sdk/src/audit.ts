import type {
  AuditAction,
  AuditEntry,
  AuditEntryId,
  GroupId,
  ListAuditOptions,
  Page,
  UserId,
} from "@junjo.io/shared";
import type { HttpClient } from "./http.js";
import { parseWireDate } from "./wire.js";

export interface WireAuditEntry {
  id: string;
  groupId: string;
  actorUserId: string | null;
  action: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function deserializeAuditEntry(w: WireAuditEntry): AuditEntry {
  return {
    id: w.id as AuditEntryId,
    groupId: w.groupId as GroupId,
    actorUserId: w.actorUserId === null ? null : (w.actorUserId as UserId),
    action: w.action as AuditAction,
    targetId: w.targetId,
    payload: w.payload,
    createdAt: parseWireDate(w.createdAt, "createdAt"),
  };
}

/** Audit log: a group's action history, newest-first. */
export class AuditApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Pass `before` to fetch a page strictly older than that boundary: a
   * Date is sent as ISO 8601, a string (an opaque cursor or an ISO
   * timestamp) is passed through verbatim. `nextCursor` is an opaque
   * cursor, ready to feed straight back in as `before` on the next call.
   */
  async list(
    groupId: GroupId,
    opts?: ListAuditOptions & { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Page<AuditEntry>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.before !== undefined) {
      params.set("before", opts.before instanceof Date ? opts.before.toISOString() : opts.before);
    }
    if (opts?.actions !== undefined) {
      for (const action of opts.actions) params.append("actions", action);
    }
    const qs = params.toString();
    const path = qs
      ? `/v1/groups/${encodeURIComponent(groupId)}/audit?${qs}`
      : `/v1/groups/${encodeURIComponent(groupId)}/audit`;
    const wire = await this.http.get<{
      items: WireAuditEntry[];
      nextCursor: string | null;
    }>(path, { signal: opts?.signal, timeoutMs: opts?.timeoutMs });
    return {
      items: wire.items.map(deserializeAuditEntry),
      nextCursor: wire.nextCursor,
    };
  }

  /**
   * Async-iterator wrapper over `list(...)` that walks the group's
   * whole audit timeline, newest-first, feeding each page's
   * `nextCursor` back in as `before`. `actions` filters exactly as on
   * `list`. Hand-rolled rather than built on `paginate` because the
   * audit cursor parameter is named `before`, not `cursor`.
   */
  async *listAll(
    groupId: GroupId,
    opts?: {
      limit?: number;
      actions?: AuditAction[];
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): AsyncGenerator<AuditEntry, void, unknown> {
    let before: string | undefined;
    while (true) {
      const page = await this.list(groupId, { ...opts, before });
      for (const item of page.items) yield item;
      if (!page.nextCursor) return;
      before = page.nextCursor;
    }
  }
}
