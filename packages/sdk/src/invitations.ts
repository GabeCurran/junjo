import type { GroupId, Invitation, Page, PageOptions } from "@junjo.io/shared";
import { JunjoError } from "./errors.js";
import { type WireInvitation, deserializeInvitation } from "./groups.js";
import type { HttpClient } from "./http.js";

/** Options for {@link InvitationsApi.list}. */
export interface ListInvitationsOptions extends PageOptions {
  includeExpired?: boolean;
  includeUsed?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Invitations: list a group's invitations, look one up by code, and
 * revoke. Creation lives on `groups.inviteByUserId` / `inviteByCode` /
 * `inviteByLink`.
 */
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
    const wire = await this.http.get<{ items: WireInvitation[]; nextCursor: string | null }>(path, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return {
      items: wire.items.map(deserializeInvitation),
      nextCursor: wire.nextCursor,
    };
  }

  async get(
    code: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Invitation | null> {
    try {
      const wire = await this.http.get<WireInvitation>(
        `/v1/invitations/${encodeURIComponent(code)}`,
        { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
      );
      return deserializeInvitation(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async revoke(code: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
    await this.http.delete<unknown>(`/v1/invitations/${encodeURIComponent(code)}`, undefined, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
  }
}
