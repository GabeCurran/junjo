import type { Ban, GameId, Page, PageOptions, UserId } from "@junjo/shared";
import type { HttpClient } from "./http.js";

interface WireGameBan {
  id: string;
  gameId: string;
  userId: string;
  bannedAt: string;
  expiresAt: string | null;
  reason: string | null;
  bannedBy: string | null;
}

function deserializeBan(w: WireGameBan): Ban {
  return {
    id: w.id,
    gameId: w.gameId as GameId,
    userId: w.userId as UserId,
    bannedAt: new Date(w.bannedAt),
    expiresAt: w.expiresAt === null ? null : new Date(w.expiresAt),
    reason: w.reason,
    bannedBy: w.bannedBy === null ? null : (w.bannedBy as UserId),
  };
}

export interface CreateBanInput {
  // External user id of the user to ban (Clerk sub, Supabase uuid,
  // Roblox UserId-as-string -- whatever the dev's auth provider returns).
  userId: UserId;
  // Optional human-readable reason; surfaces in audit / dashboard.
  reason?: string | null;
  // Optional ISO timestamp / Date for time-bounded bans. Omit / null =
  // permanent. Lazy expiry on read; the server does not auto-clean
  // expired rows.
  expiresAt?: Date | string | null;
}

export interface ListBansOptions extends PageOptions {
  // Default false. When true, also returns rows whose `expiresAt` is in
  // the past (the runtime ban-check ignores those, but operators may
  // want to see them in the dashboard).
  includeExpired?: boolean;
}

// Game-level bans. Per-group bans live on `MembersApi` / `GroupsApi`
// alongside kick semantics.
//
// Game-level ban applies across every group in the game: the user
// cannot accept invitations or open-join any group while the ban is
// active. Per-group ban (`groups.ban(...)`) is scoped to one group.
// The two compose -- enforcement on the server checks game-level
// first, then per-group.
export class BansApi {
  constructor(private readonly http: HttpClient) {}

  async list(opts?: ListBansOptions): Promise<Page<Ban>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.includeExpired === true) params.set("includeExpired", "true");
    const qs = params.toString();
    const path = qs ? `/v1/bans?${qs}` : "/v1/bans";
    const wire = await this.http.get<{ items: WireGameBan[]; nextCursor: string | null }>(path);
    return {
      items: wire.items.map(deserializeBan),
      nextCursor: wire.nextCursor,
    };
  }

  async add(input: CreateBanInput): Promise<Ban> {
    const body: Record<string, unknown> = { userId: input.userId };
    if (input.reason !== undefined) body.reason = input.reason;
    if (input.expiresAt !== undefined) {
      body.expiresAt =
        input.expiresAt === null
          ? null
          : input.expiresAt instanceof Date
            ? input.expiresAt.toISOString()
            : input.expiresAt;
    }
    const wire = await this.http.post<WireGameBan>("/v1/bans", body);
    return deserializeBan(wire);
  }

  async remove(userId: UserId): Promise<void> {
    await this.http.delete<unknown>(`/v1/bans/${encodeURIComponent(userId)}`);
  }
}
