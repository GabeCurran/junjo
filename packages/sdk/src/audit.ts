import type {
  AuditAction,
  AuditEntry,
  AuditEntryId,
  GroupId,
  ListAuditOptions,
  Page,
  UserId,
} from "@junjo/shared";
import type { HttpClient } from "./http.js";

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
    createdAt: new Date(w.createdAt),
  };
}

export class AuditApi {
  constructor(private readonly http: HttpClient) {}

  // Returns audit entries for a group, newest first. Pass `before: Date`
  // to fetch a page strictly older than a given timestamp; the returned
  // `nextCursor` is the ISO 8601 createdAt of the last item, ready to
  // feed back in as `before` on the next call.
  async list(groupId: GroupId, opts?: ListAuditOptions): Promise<Page<AuditEntry>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.before !== undefined) params.set("before", opts.before.toISOString());
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
    }>(path);
    return {
      items: wire.items.map(deserializeAuditEntry),
      nextCursor: wire.nextCursor,
    };
  }
}
