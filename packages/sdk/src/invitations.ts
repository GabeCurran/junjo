import type { GroupId, Invitation, Page, PageOptions } from "@junjo/shared";
import { JunjoError } from "./errors.js";
import { type WireInvitation, deserializeInvitation } from "./groups.js";
import type { HttpClient } from "./http.js";

export interface ListInvitationsOptions extends PageOptions {
  includeExpired?: boolean;
  includeUsed?: boolean;
}

export class InvitationsApi {
  constructor(private readonly http: HttpClient) {}

  async list(groupId: GroupId, opts?: ListInvitationsOptions): Promise<Page<Invitation>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.includeExpired !== undefined) {
      params.set("includeExpired", String(opts.includeExpired));
    }
    if (opts?.includeUsed !== undefined) {
      params.set("includeUsed", String(opts.includeUsed));
    }
    const qs = params.toString();
    const base = `/v1/groups/${encodeURIComponent(groupId)}/invitations`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<{ items: WireInvitation[]; nextCursor: string | null }>(path);
    return {
      items: wire.items.map(deserializeInvitation),
      nextCursor: wire.nextCursor,
    };
  }

  async get(code: string): Promise<Invitation | null> {
    try {
      const wire = await this.http.get<WireInvitation>(
        `/v1/invitations/${encodeURIComponent(code)}`,
      );
      return deserializeInvitation(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async revoke(code: string): Promise<void> {
    await this.http.delete<unknown>(`/v1/invitations/${encodeURIComponent(code)}`);
  }
}
