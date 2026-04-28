import { Junjo, JunjoError } from "@junjo/sdk";
import type { SubscribeOptions, Subscription } from "@junjo/sdk";
import type {
  GameId,
  Group,
  GroupId,
  JunjoEvent,
  Member,
  MemberId,
  Page,
  RoleId,
  UserId,
} from "@junjo/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { useGroup } from "./useGroup.js";

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
  get: ReturnType<typeof vi.fn>;
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
  const get = vi.fn();
  const list = vi.fn();
  const subscribe = vi.fn(
    async (groupId: GroupId, handler: (event: JunjoEvent) => void, opts?: SubscribeOptions) => {
      const close = vi.fn();
      captures.push({ groupId, handler, opts, close });
      const sub: Subscription = { close };
      return sub;
    },
  );
  // Replace SDK methods with our spies. The Junjo constructor wired the
  // real ones; overwriting them on the live instance keeps tests focused
  // on the hook's behavior rather than the underlying transport.
  Object.assign(client.groups, { get, subscribe });
  Object.assign(client.members, { list });
  return { client, get, list, subscribe, captures };
}

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: GROUP_ID,
    gameId: GAME_ID,
    kind: "guild",
    name: "Crimson Wolves",
    visibility: "invite-only",
    metadata: {},
    defaultRoleId: null,
    parentGroupId: null,
    memberCount: 0,
    createdAt: new Date("2026-04-28T00:00:00.000Z"),
    updatedAt: new Date("2026-04-28T00:00:00.000Z"),
    softDeletedAt: null,
    ...overrides,
  };
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
    ...overrides,
  };
}

function membersPage(items: Member[]): Page<Member> {
  return { items, nextCursor: null };
}

function wrapper(client: Junjo) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <JunjoProvider client={client}>{children}</JunjoProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useGroup", () => {
  it("fetches the group and members on mount and exposes them on the result", async () => {
    const h = makeHarness();
    const group = makeGroup();
    const memberA = makeMember("user_a");
    const memberB = makeMember("user_b");
    h.get.mockResolvedValue(group);
    h.list.mockResolvedValue(membersPage([memberA, memberB]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.group).toBeNull();
    expect(result.current.members).toEqual([]);
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.group).toBe(group);
    expect(result.current.members).toEqual([memberA, memberB]);
    expect(result.current.error).toBeNull();
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledWith(GROUP_ID);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith(GROUP_ID);
  });

  it("filters non-active members out of the initial roster", async () => {
    const h = makeHarness();
    const active = makeMember("user_a");
    const left = makeMember("user_b", { status: "left" });
    const kicked = makeMember("user_c", { status: "kicked" });
    const invited = makeMember("user_d", { status: "invited" });
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([active, left, kicked, invited]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([active]);
  });

  it("captures a JunjoError thrown by groups.get into result.error", async () => {
    const h = makeHarness();
    const err = new JunjoError("not found", "not_found", 404);
    h.get.mockRejectedValue(err);
    h.list.mockResolvedValue(membersPage([]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.group).toBeNull();
    expect(result.current.members).toEqual([]);
  });

  it("captures a JunjoError thrown by members.list into result.error", async () => {
    const h = makeHarness();
    h.get.mockResolvedValue(makeGroup());
    h.list.mockRejectedValue(new JunjoError("boom", "internal", 500));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(JunjoError);
    expect((result.current.error as JunjoError).code).toBe("internal");
  });

  it("refetch re-runs both API calls and clears prior error", async () => {
    const h = makeHarness();
    h.get.mockRejectedValueOnce(new JunjoError("transient", "internal", 500));
    h.list.mockResolvedValue(membersPage([]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(JunjoError));

    const group = makeGroup({ name: "Renamed" });
    h.get.mockResolvedValueOnce(group);
    h.list.mockResolvedValue(membersPage([makeMember("user_a")]));

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.group).toEqual(group);
    expect(result.current.members).toHaveLength(1);
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("opens a single SSE subscription scoped to the active groupId", async () => {
    const h = makeHarness();
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([]));

    renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    expect(h.captures[0]?.groupId).toBe(GROUP_ID);
    expect(typeof h.captures[0]?.handler).toBe("function");
    expect(typeof h.captures[0]?.opts?.onError).toBe("function");
  });

  it("closes the subscription on unmount", async () => {
    const h = makeHarness();
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([]));

    const { unmount } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const close = h.captures[0]?.close;
    expect(close).toBeDefined();
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("re-fetches and re-subscribes when groupId changes", async () => {
    const h = makeHarness();
    const groupA = makeGroup({ id: GROUP_ID, name: "Alpha" });
    const groupB = makeGroup({ id: ALT_GROUP_ID, name: "Beta" });
    h.get.mockImplementation((id: GroupId) => Promise.resolve(id === GROUP_ID ? groupA : groupB));
    h.list.mockResolvedValue(membersPage([]));

    const { result, rerender } = renderHook(({ id }: { id: GroupId }) => useGroup(id), {
      initialProps: { id: GROUP_ID },
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.group?.id).toBe(GROUP_ID));
    const firstClose = h.captures[0]?.close;
    expect(firstClose).toBeDefined();

    rerender({ id: ALT_GROUP_ID });

    await waitFor(() => expect(result.current.group?.id).toBe(ALT_GROUP_ID));
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenLastCalledWith(ALT_GROUP_ID);
    expect(h.list).toHaveBeenLastCalledWith(ALT_GROUP_ID);
    expect(h.captures).toHaveLength(2);
    expect(h.captures[1]?.groupId).toBe(ALT_GROUP_ID);
  });

  it("appends a new active member on member.joined", async () => {
    const h = makeHarness();
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([makeMember("user_a")]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    expect(handler).toBeDefined();
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

  it("replaces an existing member entry when the same userId joins again", async () => {
    const h = makeHarness();
    const original = makeMember("user_a", { roles: ["role_old" as RoleId] });
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([original]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const replacement = makeMember("user_a", { roles: ["role_new" as RoleId] });
    act(() => {
      handler({
        id: "evt_1",
        type: "member.joined",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        userId: replacement.userId,
        member: replacement,
      });
    });

    expect(result.current.members).toHaveLength(1);
    expect(result.current.members[0]?.roles).toEqual(["role_new"]);
  });

  it("removes a member on member.left", async () => {
    const h = makeHarness();
    const a = makeMember("user_a");
    const b = makeMember("user_b");
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([a, b]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

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
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([member]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

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
      });
    });

    expect(result.current.members[0]?.roles).toEqual(["role_two", "role_three"]);
  });

  it("ignores role.changed for an unknown user", async () => {
    const h = makeHarness();
    const member = makeMember("user_a", { roles: ["role_one" as RoleId] });
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([member]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

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
        userId: "user_unknown" as UserId,
        added: ["role_x" as RoleId],
        removed: [],
      });
    });

    expect(result.current.members).toEqual([member]);
  });

  it("replaces the group on group.updated", async () => {
    const h = makeHarness();
    h.get.mockResolvedValue(makeGroup({ name: "Old" }));
    h.list.mockResolvedValue(membersPage([]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.group?.name).toBe("Old"));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const updated = makeGroup({ name: "New" });
    act(() => {
      handler({
        id: "evt_1",
        type: "group.updated",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        group: updated,
      });
    });

    expect(result.current.group).toEqual(updated);
  });

  it("clears group and members on group.deleted", async () => {
    const h = makeHarness();
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([makeMember("user_a"), makeMember("user_b")]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.members).toHaveLength(2));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    act(() => {
      handler({
        id: "evt_1",
        type: "group.deleted",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
      });
    });

    expect(result.current.group).toBeNull();
    expect(result.current.members).toEqual([]);
  });

  it("does not change state for unrelated events (e.g. role.created)", async () => {
    const h = makeHarness();
    const before = makeMember("user_a");
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([before]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

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

  it("captures a streaming error via onError without clearing the snapshot", async () => {
    const h = makeHarness();
    const member = makeMember("user_a");
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([member]));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.members).toHaveLength(1));
    const onError = h.captures[0]?.opts?.onError;
    if (!onError) throw new Error("onError missing");

    act(() => {
      onError(new Error("stream dropped"));
    });

    expect(result.current.error).toEqual(new Error("stream dropped"));
    expect(result.current.members).toEqual([member]);
    expect(result.current.group).not.toBeNull();
  });

  it("captures a thrown subscribe handshake error into result.error", async () => {
    const h = makeHarness();
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([]));
    const handshakeError = new JunjoError("forbidden", "permission_denied", 403);
    h.subscribe.mockImplementationOnce(() => Promise.reject(handshakeError));

    const { result } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.error).toBe(handshakeError));
    expect(result.current.loading).toBe(false);
    expect(result.current.group).not.toBeNull();
  });

  it("closes a subscription that resolves after unmount", async () => {
    const h = makeHarness();
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(membersPage([]));

    let resolveSubscribe!: (sub: Subscription) => void;
    const close = vi.fn();
    h.subscribe.mockImplementationOnce(
      () =>
        new Promise<Subscription>((resolve) => {
          resolveSubscribe = (sub) => resolve(sub);
        }),
    );

    const { unmount } = renderHook(() => useGroup(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.subscribe).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      resolveSubscribe({ close });
      await Promise.resolve();
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
