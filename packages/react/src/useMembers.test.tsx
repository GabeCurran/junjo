import { Junjo, JunjoError } from "@junjo/sdk";
import type { SubscribeOptions, Subscription } from "@junjo/sdk";
import type {
  GameId,
  GroupId,
  JunjoEvent,
  Member,
  MemberId,
  MemberStatus,
  Page,
  RoleId,
  UserId,
} from "@junjo/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { useMembers } from "./useMembers.js";
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
  Object.assign(client.members, { list });
  Object.assign(client.groups, { subscribe });
  return { client, list, subscribe, captures };
}

function makeMember(userId: string, overrides: Partial<Member> = {}): Member {
  return {
    id: `mem_${userId}` as MemberId,
    groupId: GROUP_ID,
    userId: userId as UserId,
    status: "active",
    roles: [],
    metadata: {},
    notesPublic: null,
    notesPrivate: null,
    joinedAt: new Date("2026-04-28T00:00:00.000Z"),
    bannedUntil: null,
    ...overrides,
  };
}

function membersPage(items: Member[], nextCursor: string | null = null): Page<Member> {
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

describe("useMembers", () => {
  it("fetches the first page on mount and exposes members on the result", async () => {
    const h = makeHarness();
    const a = makeMember("user_a");
    const b = makeMember("user_b");
    h.list.mockResolvedValue(membersPage([a, b]));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.members).toEqual([]);
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([a, b]);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, undefined);
  });

  it("filters non-active members out by default", async () => {
    const h = makeHarness();
    const active = makeMember("user_a");
    const left = makeMember("user_b", { status: "left" });
    const kicked = makeMember("user_c", { status: "kicked" });
    const invited = makeMember("user_d", { status: "invited" });
    h.list.mockResolvedValue(membersPage([active, left, kicked, invited]));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([active]);
  });

  it('returns every member when status is "all"', async () => {
    const h = makeHarness();
    const active = makeMember("user_a");
    const left = makeMember("user_b", { status: "left" });
    const kicked = makeMember("user_c", { status: "kicked" });
    h.list.mockResolvedValue(membersPage([active, left, kicked]));

    const { result } = renderHook(() => useMembers(GROUP_ID, { status: "all" }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([active, left, kicked]);
  });

  it('returns only matching status when status is "left"', async () => {
    const h = makeHarness();
    const active = makeMember("user_a");
    const left = makeMember("user_b", { status: "left" });
    h.list.mockResolvedValue(membersPage([active, left]));

    const { result } = renderHook(() => useMembers(GROUP_ID, { status: "left" }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([left]);
  });

  it("forwards a custom limit to members.list", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(membersPage([]));

    renderHook(() => useMembers(GROUP_ID, { limit: 25 }), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, { limit: 25 });
  });

  it("captures a JunjoError thrown by members.list into result.error", async () => {
    const h = makeHarness();
    const err = new JunjoError("not found", "not_found", 404);
    h.list.mockRejectedValue(err);

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.members).toEqual([]);
  });

  it("refetch resets state and re-runs members.list", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce(membersPage([makeMember("user_a")]));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.members).toHaveLength(1));

    h.list.mockResolvedValueOnce(membersPage([makeMember("user_x"), makeMember("user_y")]));
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.members.map((m) => m.userId)).toEqual(["user_x", "user_y"]);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("opens a single SSE subscription scoped to the active groupId", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(membersPage([]));

    renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    expect(h.captures[0]?.groupId).toBe(GROUP_ID);
    expect(typeof h.captures[0]?.handler).toBe("function");
    expect(typeof h.captures[0]?.opts?.onError).toBe("function");
  });

  it("closes the subscription on unmount", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(membersPage([]));

    const { unmount } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const close = h.captures[0]?.close;
    expect(close).toBeDefined();
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("re-fetches and re-subscribes when groupId changes", async () => {
    const h = makeHarness();
    h.list.mockImplementation(() => Promise.resolve(membersPage([])));

    const { result, rerender } = renderHook(({ id }: { id: GroupId }) => useMembers(id), {
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
    expect(h.list).toHaveBeenLastCalledWith(ALT_GROUP_ID, undefined);
  });

  it("does not re-subscribe when only the status filter changes", async () => {
    const h = makeHarness();
    const active = makeMember("user_a");
    const left = makeMember("user_b", { status: "left" });
    h.list.mockResolvedValue(membersPage([active, left]));

    const { result, rerender } = renderHook(
      ({ status }: { status: "active" | "all" }) => useMembers(GROUP_ID, { status }),
      {
        initialProps: { status: "active" },
        wrapper: wrapper(h.client),
      },
    );

    await waitFor(() => expect(result.current.members).toEqual([active]));
    expect(h.captures).toHaveLength(1);

    rerender({ status: "all" });

    await waitFor(() => expect(result.current.members).toEqual([active, left]));
    expect(h.captures).toHaveLength(1);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("appends a new active member on member.joined when the filter matches", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(membersPage([makeMember("user_a")]));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const newMember = makeMember("user_b");
    act(() => {
      handler({
        id: "evt_1",
        type: "member.joined",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        userId: newMember.userId,
        member: newMember,
      });
    });

    expect(result.current.members.map((m) => m.userId)).toEqual(["user_a", "user_b"]);
  });

  it("ignores member.joined when the filter excludes the member", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(membersPage([makeMember("user_a")]));

    const { result } = renderHook(() => useMembers(GROUP_ID, { status: "active" }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const left = makeMember("user_b", { status: "left" } as Partial<Member>);
    act(() => {
      handler({
        id: "evt_1",
        type: "member.joined",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        userId: left.userId,
        member: left,
      });
    });

    expect(result.current.members).toHaveLength(1);
    expect(result.current.members[0]?.userId).toBe("user_a");
  });

  it("removes a member on member.left", async () => {
    const h = makeHarness();
    const a = makeMember("user_a");
    const b = makeMember("user_b");
    h.list.mockResolvedValue(membersPage([a, b]));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    act(() => {
      handler({
        id: "evt_1",
        type: "member.left",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        userId: a.userId,
        reason: "left",
      });
    });

    expect(result.current.members.map((m) => m.userId)).toEqual(["user_b"]);
  });

  it("updates a member's roles on role.changed (added + removed merge)", async () => {
    const h = makeHarness();
    const member = makeMember("user_a", {
      roles: ["role_one" as RoleId, "role_two" as RoleId],
    });
    h.list.mockResolvedValue(membersPage([member]));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    act(() => {
      handler({
        id: "evt_1",
        type: "role.changed",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        userId: member.userId,
        added: ["role_three" as RoleId],
        removed: ["role_one" as RoleId],
        actorUserId: null,
      });
    });

    expect(result.current.members[0]?.roles).toEqual(["role_two", "role_three"]);
  });

  it("ignores role.changed for an unknown user", async () => {
    const h = makeHarness();
    const member = makeMember("user_a");
    h.list.mockResolvedValue(membersPage([member]));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const snapshot = result.current.members;
    act(() => {
      handler({
        id: "evt_1",
        type: "role.changed",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        userId: "user_unknown" as UserId,
        added: ["role_x" as RoleId],
        removed: [],
        actorUserId: null,
      });
    });

    expect(result.current.members).toBe(snapshot);
  });

  it("does not change state for unrelated events (e.g. role.created)", async () => {
    const h = makeHarness();
    const before = makeMember("user_a");
    h.list.mockResolvedValue(membersPage([before]));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.members).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const snapshot = result.current.members;
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

    expect(result.current.members).toBe(snapshot);
  });

  it("uses the latest filter when an event arrives after a status change", async () => {
    const h = makeHarness();
    const active = makeMember("user_a");
    h.list.mockResolvedValue(membersPage([active]));

    const { result, rerender } = renderHook(
      ({ status }: { status: "active" | "all" }) => useMembers(GROUP_ID, { status }),
      {
        initialProps: { status: "active" } as { status: "active" | "all" },
        wrapper: wrapper(h.client),
      },
    );

    await waitFor(() => expect(h.captures).toHaveLength(1));
    rerender({ status: "all" });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");
    const left = makeMember("user_b", { status: "left" as MemberStatus });
    act(() => {
      handler({
        id: "evt_1",
        type: "member.joined",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        userId: left.userId,
        member: left,
      });
    });

    expect(result.current.members.map((m) => m.userId)).toContain("user_b");
  });

  it("captures a streaming error without clearing the snapshot", async () => {
    const h = makeHarness();
    const member = makeMember("user_a");
    h.list.mockResolvedValue(membersPage([member]));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.members).toHaveLength(1));
    const onError = h.captures[0]?.opts?.onError;
    if (!onError) throw new Error("onError missing");

    act(() => {
      onError(new Error("stream dropped"));
    });

    expect(result.current.error).toEqual(new Error("stream dropped"));
    expect(result.current.members).toEqual([member]);
  });

  it("captures a thrown subscribe handshake error into result.error", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(membersPage([]));
    const handshakeError = new JunjoError("forbidden", "permission_denied", 403);
    h.subscribe.mockImplementationOnce(() => Promise.reject(handshakeError));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.error).toBe(handshakeError));
    expect(result.current.loading).toBe(false);
  });

  it("closes a subscription that resolves after unmount", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(membersPage([]));

    let resolveSubscribe!: (sub: Subscription) => void;
    const close = vi.fn();
    h.subscribe.mockImplementationOnce(
      () =>
        new Promise<Subscription>((resolve) => {
          resolveSubscribe = (sub) => resolve(sub);
        }),
    );

    const { unmount } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

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
    const a = makeMember("user_a");
    const b = makeMember("user_b");
    const c = makeMember("user_c");
    h.list.mockResolvedValueOnce(membersPage([a, b], "cursor_1"));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([a, b]);
    expect(result.current.hasMore).toBe(true);

    h.list.mockResolvedValueOnce(membersPage([c], null));
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.members).toEqual([a, b, c]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loadingMore).toBe(false);
    expect(h.list).toHaveBeenLastCalledWith(GROUP_ID, { cursor: "cursor_1" });
  });

  it("fetchMore is a no-op when hasMore is false", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(membersPage([makeMember("user_a")], null));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("fetchMore deduplicates concurrent calls to a single network request", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce(membersPage([makeMember("user_a")], "cursor_1"));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    let resolveSecond!: (page: Page<Member>) => void;
    h.list.mockImplementationOnce(
      () =>
        new Promise<Page<Member>>((resolve) => {
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
      resolveSecond(membersPage([makeMember("user_b")], null));
      await firstCall;
      await secondCall;
    });

    expect(h.list).toHaveBeenCalledTimes(2);
    expect(result.current.members.map((m) => m.userId)).toEqual(["user_a", "user_b"]);
  });

  it("captures a fetchMore error without dropping previous members", async () => {
    const h = makeHarness();
    const a = makeMember("user_a");
    h.list.mockResolvedValueOnce(membersPage([a], "cursor_1"));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const err = new JunjoError("boom", "internal", 500);
    h.list.mockRejectedValueOnce(err);
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.error).toBe(err);
    expect(result.current.members).toEqual([a]);
    expect(result.current.loadingMore).toBe(false);
  });

  it("forwards limit on fetchMore alongside the cursor", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce(membersPage([makeMember("user_a")], "cursor_1"));

    const { result } = renderHook(() => useMembers(GROUP_ID, { limit: 25 }), {
      wrapper: wrapper(h.client),
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    h.list.mockResolvedValueOnce(membersPage([], null));
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(h.list).toHaveBeenLastCalledWith(GROUP_ID, { cursor: "cursor_1", limit: 25 });
  });

  describe("applyOptimistic", () => {
    it("applies the updater to local members and returns a rollback closure", async () => {
      const h = makeHarness();
      const a = makeMember("user_a");
      const b = makeMember("user_b");
      h.list.mockResolvedValue(membersPage([a, b]));

      const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let rollback: (() => void) | undefined;
      act(() => {
        rollback = result.current.applyOptimistic((prev) =>
          prev.filter((m) => m.userId !== "user_a"),
        );
      });
      expect(result.current.members).toEqual([b]);

      act(() => {
        rollback?.();
      });
      expect(result.current.members).toEqual([a, b]);
    });

    it("rolls back to the snapshot taken at applyOptimistic call time", async () => {
      const h = makeHarness();
      const a = makeMember("user_a");
      const b = makeMember("user_b");
      h.list.mockResolvedValue(membersPage([a, b]));

      const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let rollbackA: (() => void) | undefined;
      act(() => {
        rollbackA = result.current.applyOptimistic((prev) =>
          prev.filter((m) => m.userId !== "user_a"),
        );
      });
      expect(result.current.members).toEqual([b]);

      let rollbackB: (() => void) | undefined;
      act(() => {
        rollbackB = result.current.applyOptimistic((prev) =>
          prev.filter((m) => m.userId !== "user_b"),
        );
      });
      expect(result.current.members).toEqual([]);

      act(() => {
        rollbackB?.();
      });
      expect(result.current.members).toEqual([b]);

      act(() => {
        rollbackA?.();
      });
      expect(result.current.members).toEqual([a, b]);
    });

    it("does not call the SDK", async () => {
      const h = makeHarness();
      h.list.mockResolvedValue(membersPage([makeMember("user_a")]));

      const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const callsBefore = h.list.mock.calls.length;
      act(() => {
        result.current.applyOptimistic((prev) => prev.slice(0, 0));
      });

      expect(h.list).toHaveBeenCalledTimes(callsBefore);
    });

    it("supports the kick optimistic-removal pattern", async () => {
      const h = makeHarness();
      const a = makeMember("user_a");
      const b = makeMember("user_b");
      const c = makeMember("user_c");
      h.list.mockResolvedValue(membersPage([a, b, c]));

      const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let rollback: (() => void) | undefined;
      act(() => {
        rollback = result.current.applyOptimistic((prev) =>
          prev.filter((m) => m.userId !== "user_b"),
        );
      });
      expect(result.current.members.map((m) => m.userId)).toEqual(["user_a", "user_c"]);
      expect(typeof rollback).toBe("function");
    });

    it("supports the role-assignment optimistic update pattern", async () => {
      const h = makeHarness();
      const a = makeMember("user_a", { roles: ["role_one" as RoleId] });
      h.list.mockResolvedValue(membersPage([a]));

      const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const newRole = "role_two" as RoleId;
      act(() => {
        result.current.applyOptimistic((prev) =>
          prev.map((m) => (m.userId === "user_a" ? { ...m, roles: [...m.roles, newRole] } : m)),
        );
      });

      expect(result.current.members[0]?.roles).toEqual(["role_one", "role_two"]);
    });

    it("preserves members reference when updater returns the input array unchanged", async () => {
      const h = makeHarness();
      const a = makeMember("user_a");
      h.list.mockResolvedValue(membersPage([a]));

      const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const before = result.current.members;
      act(() => {
        result.current.applyOptimistic((prev) => prev);
      });
      expect(result.current.members).toBe(before);
    });

    it("layers SSE events on top of the optimistic state", async () => {
      const h = makeHarness();
      const a = makeMember("user_a");
      const b = makeMember("user_b");
      h.list.mockResolvedValue(membersPage([a, b]));

      const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.loading).toBe(false));
      await waitFor(() => expect(h.captures.length).toBe(1));

      act(() => {
        result.current.applyOptimistic((prev) => prev.filter((m) => m.userId !== "user_a"));
      });
      expect(result.current.members.map((m) => m.userId)).toEqual(["user_b"]);

      const c = makeMember("user_c");
      const event: JunjoEvent = {
        id: "evt_1" as JunjoEvent["id"],
        type: "member.joined",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        userId: "user_c" as UserId,
        member: c,
        occurredAt: new Date("2026-04-28T01:00:00.000Z"),
      };
      const capture = h.captures[0];
      if (!capture) throw new Error("expected subscription capture");
      act(() => {
        capture.handler(event);
      });

      expect(result.current.members.map((m) => m.userId)).toEqual(["user_b", "user_c"]);
    });

    it("rollback restores the pre-optimistic snapshot, losing intermediate SSE events", async () => {
      const h = makeHarness();
      const a = makeMember("user_a");
      h.list.mockResolvedValue(membersPage([a]));

      const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.loading).toBe(false));
      await waitFor(() => expect(h.captures.length).toBe(1));

      let rollback: (() => void) | undefined;
      act(() => {
        rollback = result.current.applyOptimistic((prev) =>
          prev.filter((m) => m.userId !== "user_a"),
        );
      });
      expect(result.current.members).toEqual([]);

      const c = makeMember("user_c");
      const joinedEvent: JunjoEvent = {
        id: "evt_1" as JunjoEvent["id"],
        type: "member.joined",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        userId: "user_c" as UserId,
        member: c,
        occurredAt: new Date("2026-04-28T01:00:00.000Z"),
      };
      const capture = h.captures[0];
      if (!capture) throw new Error("expected subscription capture");
      act(() => {
        capture.handler(joinedEvent);
      });
      expect(result.current.members.map((m) => m.userId)).toEqual(["user_c"]);

      act(() => {
        rollback?.();
      });
      expect(result.current.members.map((m) => m.userId)).toEqual(["user_a"]);
    });

    it("composes with useMutation for snapshot-and-rollback on error", async () => {
      const h = makeHarness();
      const a = makeMember("user_a");
      const b = makeMember("user_b");
      h.list.mockResolvedValue(membersPage([a, b]));

      type Ctx = { rollback: () => void };
      const failure = new JunjoError("kick failed", "internal", 500);
      const kickFn = vi.fn().mockRejectedValue(failure);

      function Harness() {
        const { members, applyOptimistic } = useMembers(GROUP_ID);
        const mutation = useMutation<void, Error, void, Ctx>({
          mutationFn: () => kickFn(),
          onMutate: () => {
            const rollback = applyOptimistic((prev) => prev.filter((m) => m.userId !== "user_a"));
            return { rollback };
          },
          onError: (_err, _vars, ctx) => {
            ctx?.rollback();
          },
        });
        return { members, mutation };
      }

      const { result } = renderHook(Harness, { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.members.length).toBe(2));

      await act(async () => {
        try {
          await result.current.mutation.mutateAsync();
        } catch {
          // expected
        }
      });

      expect(kickFn).toHaveBeenCalledTimes(1);
      expect(result.current.mutation.status).toBe("error");
      expect(result.current.mutation.error).toBe(failure);
      expect(result.current.members.map((m) => m.userId)).toEqual(["user_a", "user_b"]);
    });

    it("composes with useMutation: onMutate optimistic remove, onError no-op on success", async () => {
      const h = makeHarness();
      const a = makeMember("user_a");
      const b = makeMember("user_b");
      h.list.mockResolvedValue(membersPage([a, b]));

      type Ctx = { rollback: () => void };
      const kickFn = vi.fn().mockResolvedValue(undefined);

      function Harness() {
        const { members, applyOptimistic } = useMembers(GROUP_ID);
        const mutation = useMutation<void, Error, void, Ctx>({
          mutationFn: () => kickFn(),
          onMutate: () => {
            const rollback = applyOptimistic((prev) => prev.filter((m) => m.userId !== "user_a"));
            return { rollback };
          },
          onError: (_err, _vars, ctx) => {
            ctx?.rollback();
          },
        });
        return { members, mutation };
      }

      const { result } = renderHook(Harness, { wrapper: wrapper(h.client) });
      await waitFor(() => expect(result.current.members.length).toBe(2));

      await act(async () => {
        await result.current.mutation.mutateAsync();
      });

      expect(kickFn).toHaveBeenCalledTimes(1);
      expect(result.current.mutation.status).toBe("success");
      expect(result.current.members.map((m) => m.userId)).toEqual(["user_b"]);
    });

    it("returns a stable applyOptimistic reference across renders", async () => {
      const h = makeHarness();
      h.list.mockResolvedValue(membersPage([makeMember("user_a")]));

      const { result, rerender } = renderHook(({ groupId }) => useMembers(groupId), {
        wrapper: wrapper(h.client),
        initialProps: { groupId: GROUP_ID },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const first = result.current.applyOptimistic;

      rerender({ groupId: GROUP_ID });

      expect(result.current.applyOptimistic).toBe(first);
    });

    it("rollback after groupId change does not mutate the new group's members", async () => {
      const h = makeHarness();
      const a = makeMember("user_a");
      const c = makeMember("user_c", { groupId: ALT_GROUP_ID });
      h.list.mockResolvedValueOnce(membersPage([a]));
      h.list.mockResolvedValueOnce(membersPage([c]));

      const { result, rerender } = renderHook(({ groupId }) => useMembers(groupId), {
        wrapper: wrapper(h.client),
        initialProps: { groupId: GROUP_ID },
      });
      await waitFor(() => expect(result.current.members.length).toBe(1));

      let rollback: (() => void) | undefined;
      act(() => {
        rollback = result.current.applyOptimistic((prev) =>
          prev.filter((m) => m.userId !== "user_a"),
        );
      });
      expect(result.current.members).toEqual([]);

      rerender({ groupId: ALT_GROUP_ID });
      await waitFor(() => expect(result.current.members.map((m) => m.userId)).toEqual(["user_c"]));

      act(() => {
        rollback?.();
      });

      expect(result.current.members.map((m) => m.userId)).toEqual(["user_a"]);
    });
  });
});
