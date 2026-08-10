import { Junjo, JunjoError } from "@junjo.io/sdk";
import type { ListInvitationsOptions, SubscribeOptions, Subscription } from "@junjo.io/sdk";
import type {
  GameId,
  GroupId,
  Invitation,
  InvitationId,
  JunjoEvent,
  Page,
  RoleId,
  UserId,
} from "@junjo.io/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { useInvitations } from "./useInvitations.js";
import { useMutation } from "./useMutation.js";

const GAME_ID = "game_test" as GameId;
const GROUP_ID = "grp_alpha" as GroupId;
const ALT_GROUP_ID = "grp_beta" as GroupId;

interface SubscribeCapture {
  groupId: GroupId;
  handler: (event: JunjoEvent) => void;
  opts?: SubscribeOptions;
  close: ReturnType<typeof vi.fn>;
}

interface Harness {
  client: Junjo;
  list: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  captures: SubscribeCapture[];
}

function makeHarness(): Harness {
  const client = new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  const captures: SubscribeCapture[] = [];
  const list = vi.fn();
  const subscribe = vi.fn(
    async (groupId: GroupId, handler: (event: JunjoEvent) => void, opts?: SubscribeOptions) => {
      const close = vi.fn();
      captures.push({ groupId, handler, opts, close });
      const sub: Subscription = { close };
      return sub;
    },
  );
  Object.assign(client.invitations, { list });
  Object.assign(client.groups, { subscribe });
  return { client, list, subscribe, captures };
}

function makeInvitation(code: string, overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: `inv_${code}` as InvitationId,
    groupId: GROUP_ID,
    code,
    roleId: null,
    targetUserId: null,
    createdBy: null,
    createdAt: new Date("2026-04-28T00:00:00.000Z"),
    expiresAt: null,
    usedAt: null,
    usedBy: null,
    ...overrides,
  };
}

function invitationsPage(items: Invitation[], nextCursor: string | null = null): Page<Invitation> {
  return { items, nextCursor };
}

function wrapper(client: Junjo) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <JunjoProvider client={client}>{children}</JunjoProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useInvitations", () => {
  it("fetches the first page on mount and exposes invitations on the result", async () => {
    const h = makeHarness();
    const a = makeInvitation("code_a");
    const b = makeInvitation("code_b");
    h.list.mockResolvedValue(invitationsPage([a, b]));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.invitations).toEqual([]);
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.invitations).toEqual([a, b]);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, {});
  });

  it('passes empty server flags by default (status: "pending")', async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    const callOpts = h.list.mock.calls[0]?.[1] as ListInvitationsOptions;
    expect(callOpts.includeExpired).toBeUndefined();
    expect(callOpts.includeUsed).toBeUndefined();
  });

  it('lifts both server exclusions when status is "used"', async () => {
    // includeUsed alone would drop used invitations whose expiry has
    // since passed (the server's expired-row exclusion still applies),
    // so the wire query must lift both flags.
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    renderHook(() => useInvitations(GROUP_ID, { status: "used" }), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, { includeExpired: true, includeUsed: true });
  });

  it('passes includeExpired: true when status is "expired"', async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    renderHook(() => useInvitations(GROUP_ID, { status: "expired" }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, { includeExpired: true });
  });

  it('passes both flags when status is "all"', async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    renderHook(() => useInvitations(GROUP_ID, { status: "all" }), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, { includeExpired: true, includeUsed: true });
  });

  it('filters out used and expired invitations client-side when status is "pending"', async () => {
    const h = makeHarness();
    const pending = makeInvitation("code_pending");
    const used = makeInvitation("code_used", {
      usedAt: new Date("2026-04-27T00:00:00.000Z"),
      usedBy: "user_x" as UserId,
    });
    const expired = makeInvitation("code_expired", {
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    h.list.mockResolvedValue(invitationsPage([pending, used, expired]));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.invitations).toEqual([pending]);
  });

  it('keeps only used invitations client-side when status is "used"', async () => {
    const h = makeHarness();
    const pending = makeInvitation("code_pending");
    const used = makeInvitation("code_used", {
      usedAt: new Date("2026-04-27T00:00:00.000Z"),
      usedBy: "user_x" as UserId,
    });
    // A used invitation whose expiry has since passed still counts as
    // used (the statuses partition disjointly).
    const usedExpired = makeInvitation("code_used_expired", {
      usedAt: new Date("2026-04-27T00:00:00.000Z"),
      usedBy: "user_y" as UserId,
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    h.list.mockResolvedValue(invitationsPage([pending, used, usedExpired]));

    const { result } = renderHook(() => useInvitations(GROUP_ID, { status: "used" }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.invitations).toEqual([used, usedExpired]);
  });

  it('keeps only unused expired invitations client-side when status is "expired"', async () => {
    const h = makeHarness();
    const future = makeInvitation("code_future", {
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const expired = makeInvitation("code_expired", {
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    // Redeemed-then-expired belongs to the "used" partition.
    const usedExpired = makeInvitation("code_used_expired", {
      usedAt: new Date("2026-04-27T00:00:00.000Z"),
      usedBy: "user_x" as UserId,
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    h.list.mockResolvedValue(invitationsPage([future, expired, usedExpired]));

    const { result } = renderHook(() => useInvitations(GROUP_ID, { status: "expired" }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.invitations).toEqual([expired]);
  });

  it("forwards a custom limit to invitations.list", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    renderHook(() => useInvitations(GROUP_ID, { limit: 25 }), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, { limit: 25 });
  });

  it("captures a JunjoError thrown by invitations.list into result.error", async () => {
    const h = makeHarness();
    const err = new JunjoError("not found", "not_found", 404);
    h.list.mockRejectedValue(err);

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.invitations).toEqual([]);
  });

  it("refetch resets state and re-runs invitations.list", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce(invitationsPage([makeInvitation("code_a")]));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.invitations).toHaveLength(1));

    h.list.mockResolvedValueOnce(
      invitationsPage([makeInvitation("code_x"), makeInvitation("code_y")]),
    );
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.invitations.map((i) => i.code)).toEqual(["code_x", "code_y"]);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("opens a single SSE subscription scoped to the active groupId", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    expect(h.captures[0]?.groupId).toBe(GROUP_ID);
    expect(typeof h.captures[0]?.handler).toBe("function");
    expect(typeof h.captures[0]?.opts?.onError).toBe("function");
  });

  it("closes the subscription on unmount", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    const { unmount } = renderHook(() => useInvitations(GROUP_ID), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const close = h.captures[0]?.close;
    expect(close).toBeDefined();
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("re-fetches and re-subscribes when groupId changes", async () => {
    const h = makeHarness();
    h.list.mockImplementation(() => Promise.resolve(invitationsPage([])));

    const { result, rerender } = renderHook(({ id }: { id: GroupId }) => useInvitations(id), {
      initialProps: { id: GROUP_ID },
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const firstClose = h.captures[0]?.close;
    expect(firstClose).toBeDefined();

    rerender({ id: ALT_GROUP_ID });

    await waitFor(() => expect(h.captures).toHaveLength(2));
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(h.captures[1]?.groupId).toBe(ALT_GROUP_ID);
    expect(result.current.loading).toBe(false);
    expect(h.list).toHaveBeenLastCalledWith(ALT_GROUP_ID, {});
  });

  it("does not re-subscribe when only the status filter changes", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    const { rerender } = renderHook(
      ({ status }: { status: "pending" | "all" }) => useInvitations(GROUP_ID, { status }),
      {
        initialProps: { status: "pending" } as { status: "pending" | "all" },
        wrapper: wrapper(h.client),
      },
    );

    await waitFor(() => expect(h.captures).toHaveLength(1));
    rerender({ status: "all" });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    expect(h.captures).toHaveLength(1);
    expect(h.list).toHaveBeenLastCalledWith(GROUP_ID, { includeExpired: true, includeUsed: true });
  });

  it("appends a pending invitation on member.invited when the filter matches", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([makeInvitation("code_a")]));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const fresh = makeInvitation("code_b");
    act(() => {
      handler({
        id: "evt_1",
        type: "member.invited",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        invitation: fresh,
      });
    });

    expect(result.current.invitations.map((i) => i.code)).toEqual(["code_a", "code_b"]);
  });

  it('ignores member.invited when the filter excludes the invitation (status: "used")', async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    const { result } = renderHook(() => useInvitations(GROUP_ID, { status: "used" }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    act(() => {
      handler({
        id: "evt_1",
        type: "member.invited",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        invitation: makeInvitation("code_b"),
      });
    });

    expect(result.current.invitations).toEqual([]);
  });

  it("replaces an existing invitation on a duplicate member.invited (idempotent dedupe)", async () => {
    const h = makeHarness();
    const original = makeInvitation("code_a");
    h.list.mockResolvedValue(invitationsPage([original]));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const updated: Invitation = {
      ...original,
      roleId: "role_member" as RoleId,
    };
    act(() => {
      handler({
        id: "evt_1",
        type: "member.invited",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        invitation: updated,
      });
    });

    expect(result.current.invitations).toHaveLength(1);
    expect(result.current.invitations[0]?.roleId).toBe("role_member");
  });

  it("removes a direct pending invitation when its target user joins (pending filter)", async () => {
    const h = makeHarness();
    const pending = makeInvitation("code_a", {
      targetUserId: "user_target" as UserId,
    });
    h.list.mockResolvedValue(invitationsPage([pending]));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.invitations).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    act(() => {
      handler({
        id: "evt_1",
        type: "member.joined",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date("2026-04-29T00:00:00.000Z"),
        userId: "user_target" as UserId,
        member: {
          id: "mem_1" as never,
          groupId: GROUP_ID,
          userId: "user_target" as UserId,
          status: "active",
          roles: [],
          metadata: {},
          notesPublic: null,
          notesPrivate: null,
          joinedAt: new Date("2026-04-29T00:00:00.000Z"),
          bannedUntil: null,
        },
      });
    });

    expect(result.current.invitations).toEqual([]);
  });

  it('updates a direct pending invitation in place on member.joined when filter is "all"', async () => {
    const h = makeHarness();
    const pending = makeInvitation("code_a", {
      targetUserId: "user_target" as UserId,
    });
    h.list.mockResolvedValue(invitationsPage([pending]));

    const { result } = renderHook(() => useInvitations(GROUP_ID, { status: "all" }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.invitations).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const occurredAt = new Date("2026-04-29T00:00:00.000Z");
    act(() => {
      handler({
        id: "evt_1",
        type: "member.joined",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt,
        userId: "user_target" as UserId,
        member: {
          id: "mem_1" as never,
          groupId: GROUP_ID,
          userId: "user_target" as UserId,
          status: "active",
          roles: [],
          metadata: {},
          notesPublic: null,
          notesPrivate: null,
          joinedAt: occurredAt,
          bannedUntil: null,
        },
      });
    });

    expect(result.current.invitations).toHaveLength(1);
    expect(result.current.invitations[0]?.usedAt).toEqual(occurredAt);
    expect(result.current.invitations[0]?.usedBy).toBe("user_target");
  });

  it("ignores member.joined for users not matching any direct invitation", async () => {
    const h = makeHarness();
    const pending = makeInvitation("code_a", {
      targetUserId: "user_target" as UserId,
    });
    h.list.mockResolvedValue(invitationsPage([pending]));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.invitations).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const snapshot = result.current.invitations;
    act(() => {
      handler({
        id: "evt_1",
        type: "member.joined",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        userId: "user_other" as UserId,
        member: {
          id: "mem_1" as never,
          groupId: GROUP_ID,
          userId: "user_other" as UserId,
          status: "active",
          roles: [],
          metadata: {},
          notesPublic: null,
          notesPrivate: null,
          joinedAt: new Date(),
          bannedUntil: null,
        },
      });
    });

    expect(result.current.invitations).toBe(snapshot);
  });

  it("ignores member.joined for open-code invitations (targetUserId: null)", async () => {
    const h = makeHarness();
    const openCode = makeInvitation("code_a");
    h.list.mockResolvedValue(invitationsPage([openCode]));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.invitations).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const snapshot = result.current.invitations;
    act(() => {
      handler({
        id: "evt_1",
        type: "member.joined",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        userId: "user_anyone" as UserId,
        member: {
          id: "mem_1" as never,
          groupId: GROUP_ID,
          userId: "user_anyone" as UserId,
          status: "active",
          roles: [],
          metadata: {},
          notesPublic: null,
          notesPrivate: null,
          joinedAt: new Date(),
          bannedUntil: null,
        },
      });
    });

    expect(result.current.invitations).toBe(snapshot);
  });

  it("ignores unrelated events (e.g. role.created)", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([makeInvitation("code_a")]));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.invitations).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const snapshot = result.current.invitations;
    act(() => {
      handler({
        id: "evt_1",
        type: "role.created",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        role: {
          id: "role_x" as RoleId,
          groupId: GROUP_ID,
          name: "Officer",
          priority: 50,
          color: null,
          isDefault: false,
          permissions: [],
          createdAt: new Date(),
        },
      });
    });

    expect(result.current.invitations).toBe(snapshot);
  });

  it("uses the latest filter when an event arrives after a status change", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    const { result, rerender } = renderHook(
      ({ status }: { status: "pending" | "used" }) => useInvitations(GROUP_ID, { status }),
      {
        initialProps: { status: "pending" } as { status: "pending" | "used" },
        wrapper: wrapper(h.client),
      },
    );

    await waitFor(() => expect(h.captures).toHaveLength(1));
    rerender({ status: "used" });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");
    const freshPending = makeInvitation("code_b");
    act(() => {
      handler({
        id: "evt_1",
        type: "member.invited",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        invitation: freshPending,
      });
    });

    expect(result.current.invitations).toEqual([]);
  });

  it("captures a streaming error without clearing the snapshot", async () => {
    const h = makeHarness();
    const seed = makeInvitation("code_a");
    h.list.mockResolvedValue(invitationsPage([seed]));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.invitations).toHaveLength(1));
    const onError = h.captures[0]?.opts?.onError;
    if (!onError) throw new Error("onError missing");

    act(() => {
      onError(new Error("stream dropped"));
    });

    expect(result.current.error).toEqual(new Error("stream dropped"));
    expect(result.current.invitations).toEqual([seed]);
  });

  it("captures a thrown subscribe handshake error into result.error", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));
    const handshakeError = new JunjoError("forbidden", "permission_denied", 403);
    h.subscribe.mockImplementationOnce(() => Promise.reject(handshakeError));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.error).toBe(handshakeError));
    expect(result.current.loading).toBe(false);
  });

  it("closes a subscription that resolves after unmount", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([]));

    let resolveSubscribe!: (sub: Subscription) => void;
    const close = vi.fn();
    h.subscribe.mockImplementationOnce(
      () =>
        new Promise<Subscription>((resolve) => {
          resolveSubscribe = (sub) => resolve(sub);
        }),
    );

    const { unmount } = renderHook(() => useInvitations(GROUP_ID), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(h.subscribe).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      resolveSubscribe({ close });
      await Promise.resolve();
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fetchMore loads the next page, appends, and updates hasMore", async () => {
    const h = makeHarness();
    const a = makeInvitation("code_a");
    const b = makeInvitation("code_b");
    const c = makeInvitation("code_c");
    h.list.mockResolvedValueOnce(invitationsPage([a, b], "cursor_1"));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.invitations).toEqual([a, b]);
    expect(result.current.hasMore).toBe(true);

    h.list.mockResolvedValueOnce(invitationsPage([c], null));
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.invitations).toEqual([a, b, c]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loadingMore).toBe(false);
    expect(h.list).toHaveBeenLastCalledWith(GROUP_ID, { cursor: "cursor_1" });
  });

  it("fetchMore is a no-op when hasMore is false", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(invitationsPage([makeInvitation("code_a")], null));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("fetchMore deduplicates concurrent calls to a single network request", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce(invitationsPage([makeInvitation("code_a")], "cursor_1"));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    let resolveSecond!: (page: Page<Invitation>) => void;
    h.list.mockImplementationOnce(
      () =>
        new Promise<Page<Invitation>>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    let firstCall: Promise<void>;
    let secondCall: Promise<void>;
    act(() => {
      firstCall = result.current.fetchMore();
      secondCall = result.current.fetchMore();
    });

    await act(async () => {
      resolveSecond(invitationsPage([makeInvitation("code_b")], null));
      await firstCall;
      await secondCall;
    });

    expect(h.list).toHaveBeenCalledTimes(2);
    expect(result.current.invitations.map((i) => i.code)).toEqual(["code_a", "code_b"]);
  });

  it("captures a fetchMore error without dropping previous invitations", async () => {
    const h = makeHarness();
    const a = makeInvitation("code_a");
    h.list.mockResolvedValueOnce(invitationsPage([a], "cursor_1"));

    const { result } = renderHook(() => useInvitations(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const err = new JunjoError("boom", "internal", 500);
    h.list.mockRejectedValueOnce(err);
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.error).toBe(err);
    expect(result.current.invitations).toEqual([a]);
    expect(result.current.loadingMore).toBe(false);
  });

  it("forwards limit and status flags on fetchMore alongside the cursor", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce(invitationsPage([makeInvitation("code_a")], "cursor_1"));

    const { result } = renderHook(() => useInvitations(GROUP_ID, { status: "all", limit: 25 }), {
      wrapper: wrapper(h.client),
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    h.list.mockResolvedValueOnce(invitationsPage([], null));
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(h.list).toHaveBeenLastCalledWith(GROUP_ID, {
      includeExpired: true,
      includeUsed: true,
      cursor: "cursor_1",
      limit: 25,
    });
  });

  describe("applyOptimistic", () => {
    it("applies the updater to local invitations and returns a rollback closure", async () => {
      const h = makeHarness();
      const a = makeInvitation("code_a");
      const b = makeInvitation("code_b");
      h.list.mockResolvedValue(invitationsPage([a, b]));

      const { result } = renderHook(() => useInvitations(GROUP_ID), {
        wrapper: wrapper(h.client),
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let rollback: (() => void) | undefined;
      act(() => {
        rollback = result.current.applyOptimistic((prev) =>
          prev.filter((i) => i.code !== "code_a"),
        );
      });
      expect(result.current.invitations).toEqual([b]);

      act(() => {
        rollback?.();
      });
      expect(result.current.invitations).toEqual([a, b]);
    });

    it("rolls back to the snapshot taken at applyOptimistic call time", async () => {
      const h = makeHarness();
      const a = makeInvitation("code_a");
      const b = makeInvitation("code_b");
      h.list.mockResolvedValue(invitationsPage([a, b]));

      const { result } = renderHook(() => useInvitations(GROUP_ID), {
        wrapper: wrapper(h.client),
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let rollbackA: (() => void) | undefined;
      act(() => {
        rollbackA = result.current.applyOptimistic((prev) =>
          prev.filter((i) => i.code !== "code_a"),
        );
      });
      expect(result.current.invitations).toEqual([b]);

      let rollbackB: (() => void) | undefined;
      act(() => {
        rollbackB = result.current.applyOptimistic((prev) =>
          prev.filter((i) => i.code !== "code_b"),
        );
      });
      expect(result.current.invitations).toEqual([]);

      act(() => {
        rollbackB?.();
      });
      expect(result.current.invitations).toEqual([b]);

      act(() => {
        rollbackA?.();
      });
      expect(result.current.invitations).toEqual([a, b]);
    });

    it("does not call the SDK", async () => {
      const h = makeHarness();
      h.list.mockResolvedValue(invitationsPage([makeInvitation("code_a")]));

      const { result } = renderHook(() => useInvitations(GROUP_ID), {
        wrapper: wrapper(h.client),
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const callsBefore = h.list.mock.calls.length;
      act(() => {
        result.current.applyOptimistic((prev) => prev.slice(0, 0));
      });

      expect(h.list).toHaveBeenCalledTimes(callsBefore);
    });

    it("supports the revoke optimistic-removal pattern", async () => {
      const h = makeHarness();
      const a = makeInvitation("code_a");
      const b = makeInvitation("code_b");
      const c = makeInvitation("code_c");
      h.list.mockResolvedValue(invitationsPage([a, b, c]));

      const { result } = renderHook(() => useInvitations(GROUP_ID), {
        wrapper: wrapper(h.client),
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let rollback: (() => void) | undefined;
      act(() => {
        rollback = result.current.applyOptimistic((prev) =>
          prev.filter((i) => i.code !== "code_b"),
        );
      });
      expect(result.current.invitations.map((i) => i.code)).toEqual(["code_a", "code_c"]);
      expect(typeof rollback).toBe("function");
    });

    it("supports the inviteByUserId optimistic-prepend pattern", async () => {
      const h = makeHarness();
      const a = makeInvitation("code_a");
      h.list.mockResolvedValue(invitationsPage([a]));

      const { result } = renderHook(() => useInvitations(GROUP_ID), {
        wrapper: wrapper(h.client),
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const newInvite = makeInvitation("code_pending", {
        targetUserId: "user_new" as UserId,
      });

      act(() => {
        result.current.applyOptimistic((prev) => [newInvite, ...prev]);
      });

      expect(result.current.invitations.map((i) => i.code)).toEqual(["code_pending", "code_a"]);
    });

    it("preserves invitations reference when updater returns the input array unchanged", async () => {
      const h = makeHarness();
      const a = makeInvitation("code_a");
      h.list.mockResolvedValue(invitationsPage([a]));

      const { result } = renderHook(() => useInvitations(GROUP_ID), {
        wrapper: wrapper(h.client),
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const before = result.current.invitations;
      act(() => {
        result.current.applyOptimistic((prev) => prev);
      });
      expect(result.current.invitations).toBe(before);
    });

    it("layers SSE events on top of the optimistic state", async () => {
      const h = makeHarness();
      const a = makeInvitation("code_a");
      h.list.mockResolvedValue(invitationsPage([a]));

      const { result } = renderHook(() => useInvitations(GROUP_ID), {
        wrapper: wrapper(h.client),
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      await waitFor(() => expect(h.captures.length).toBe(1));

      act(() => {
        result.current.applyOptimistic((prev) => prev.filter((i) => i.code !== "code_a"));
      });
      expect(result.current.invitations).toEqual([]);

      const newInvite = makeInvitation("code_b");
      const event: JunjoEvent = {
        id: "evt_1",
        type: "member.invited",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        invitation: newInvite,
        occurredAt: new Date("2026-04-28T01:00:00.000Z"),
      };
      const capture = h.captures[0];
      if (!capture) throw new Error("expected subscription capture");
      act(() => {
        capture.handler(event);
      });

      expect(result.current.invitations.map((i) => i.code)).toEqual(["code_b"]);
    });

    it("rollback restores the pre-optimistic snapshot, losing intermediate SSE events", async () => {
      const h = makeHarness();
      const a = makeInvitation("code_a");
      h.list.mockResolvedValue(invitationsPage([a]));

      const { result } = renderHook(() => useInvitations(GROUP_ID), {
        wrapper: wrapper(h.client),
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      await waitFor(() => expect(h.captures.length).toBe(1));

      let rollback: (() => void) | undefined;
      act(() => {
        rollback = result.current.applyOptimistic((prev) =>
          prev.filter((i) => i.code !== "code_a"),
        );
      });
      expect(result.current.invitations).toEqual([]);

      const newInvite = makeInvitation("code_b");
      const event: JunjoEvent = {
        id: "evt_1",
        type: "member.invited",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        invitation: newInvite,
        occurredAt: new Date("2026-04-28T01:00:00.000Z"),
      };
      const capture = h.captures[0];
      if (!capture) throw new Error("expected subscription capture");
      act(() => {
        capture.handler(event);
      });
      expect(result.current.invitations.map((i) => i.code)).toEqual(["code_b"]);

      act(() => {
        rollback?.();
      });
      expect(result.current.invitations.map((i) => i.code)).toEqual(["code_a"]);
    });

    it("composes with useMutation for snapshot-and-rollback on error", async () => {
      const h = makeHarness();
      const a = makeInvitation("code_a");
      const b = makeInvitation("code_b");
      h.list.mockResolvedValue(invitationsPage([a, b]));

      type Ctx = { rollback: () => void };
      const failure = new JunjoError("revoke failed", "internal", 500);
      const revokeFn = vi.fn().mockRejectedValue(failure);

      function Harness() {
        const { invitations, applyOptimistic } = useInvitations(GROUP_ID);
        const mutation = useMutation<void, Error, void, Ctx>({
          mutationFn: () => revokeFn(),
          onMutate: () => {
            const rollback = applyOptimistic((prev) => prev.filter((i) => i.code !== "code_a"));
            return { rollback };
          },
          onError: (_err, _vars, ctx) => {
            ctx?.rollback();
          },
        });
        return { invitations, mutation };
      }

      const { result } = renderHook(Harness, { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.invitations.length).toBe(2));

      await act(async () => {
        try {
          await result.current.mutation.mutateAsync();
        } catch {
          // expected
        }
      });

      expect(revokeFn).toHaveBeenCalledTimes(1);
      expect(result.current.mutation.status).toBe("error");
      expect(result.current.mutation.error).toBe(failure);
      expect(result.current.invitations.map((i) => i.code)).toEqual(["code_a", "code_b"]);
    });

    it("composes with useMutation: optimistic remove, no-op on success", async () => {
      const h = makeHarness();
      const a = makeInvitation("code_a");
      const b = makeInvitation("code_b");
      h.list.mockResolvedValue(invitationsPage([a, b]));

      type Ctx = { rollback: () => void };
      const revokeFn = vi.fn().mockResolvedValue(undefined);

      function Harness() {
        const { invitations, applyOptimistic } = useInvitations(GROUP_ID);
        const mutation = useMutation<void, Error, void, Ctx>({
          mutationFn: () => revokeFn(),
          onMutate: () => {
            const rollback = applyOptimistic((prev) => prev.filter((i) => i.code !== "code_a"));
            return { rollback };
          },
          onError: (_err, _vars, ctx) => {
            ctx?.rollback();
          },
        });
        return { invitations, mutation };
      }

      const { result } = renderHook(Harness, { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.invitations.length).toBe(2));

      await act(async () => {
        await result.current.mutation.mutateAsync();
      });

      expect(revokeFn).toHaveBeenCalledTimes(1);
      expect(result.current.mutation.status).toBe("success");
      expect(result.current.invitations.map((i) => i.code)).toEqual(["code_b"]);
    });

    it("returns a stable applyOptimistic reference across renders", async () => {
      const h = makeHarness();
      h.list.mockResolvedValue(invitationsPage([makeInvitation("code_a")]));

      const { result, rerender } = renderHook(({ groupId }) => useInvitations(groupId), {
        wrapper: wrapper(h.client),
        initialProps: { groupId: GROUP_ID },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const first = result.current.applyOptimistic;

      rerender({ groupId: GROUP_ID });

      expect(result.current.applyOptimistic).toBe(first);
    });

    it("rollback uses the captured snapshot even after groupId changes", async () => {
      const h = makeHarness();
      const a = makeInvitation("code_a");
      const c = makeInvitation("code_c", { groupId: ALT_GROUP_ID });
      h.list.mockResolvedValueOnce(invitationsPage([a]));
      h.list.mockResolvedValueOnce(invitationsPage([c]));

      const { result, rerender } = renderHook(({ groupId }) => useInvitations(groupId), {
        wrapper: wrapper(h.client),
        initialProps: { groupId: GROUP_ID },
      });
      await waitFor(() => expect(result.current.invitations.length).toBe(1));

      let rollback: (() => void) | undefined;
      act(() => {
        rollback = result.current.applyOptimistic((prev) =>
          prev.filter((i) => i.code !== "code_a"),
        );
      });
      expect(result.current.invitations).toEqual([]);

      rerender({ groupId: ALT_GROUP_ID });
      await waitFor(() =>
        expect(result.current.invitations.map((i) => i.code)).toEqual(["code_c"]),
      );

      act(() => {
        rollback?.();
      });

      expect(result.current.invitations.map((i) => i.code)).toEqual(["code_a"]);
    });
  });
});
