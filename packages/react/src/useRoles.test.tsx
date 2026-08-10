import { Junjo, JunjoError } from "@junjo.io/sdk";
import type { SubscribeOptions, Subscription } from "@junjo.io/sdk";
import type {
  GameId,
  GroupId,
  JunjoEvent,
  PermissionKey,
  Role,
  RoleId,
  UserId,
} from "@junjo.io/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { useRoles } from "./useRoles.js";

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
  Object.assign(client.groups, { subscribe });
  Object.assign(client.roles, { list });
  return { client, list, subscribe, captures };
}

function makeRole(id: string, overrides: Partial<Role> = {}): Role {
  return {
    id: id as RoleId,
    groupId: GROUP_ID,
    name: `Role ${id}`,
    priority: 50,
    color: null,
    isDefault: false,
    permissions: [],
    createdAt: new Date("2026-04-28T00:00:00.000Z"),
    ...overrides,
  };
}

function wrapper(client: Junjo) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <JunjoProvider client={client}>{children}</JunjoProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useRoles", () => {
  it("fetches the group's roles on mount and exposes them on the result", async () => {
    const h = makeHarness();
    const roleA = makeRole("role_a");
    const roleB = makeRole("role_b");
    h.list.mockResolvedValue([roleA, roleB]);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.roles).toEqual([]);
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.roles).toEqual([roleA, roleB]);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith(GROUP_ID);
  });

  it("captures a JunjoError thrown by roles.list into result.error", async () => {
    const h = makeHarness();
    const err = new JunjoError("boom", "internal", 500);
    h.list.mockRejectedValue(err);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.roles).toEqual([]);
  });

  it("refetch re-runs the list call and clears prior error", async () => {
    const h = makeHarness();
    h.list.mockRejectedValueOnce(new JunjoError("transient", "internal", 500));

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(JunjoError));

    const role = makeRole("role_a");
    h.list.mockResolvedValueOnce([role]);
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.roles).toEqual([role]);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("opens a single SSE subscription scoped to the active groupId", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue([]);

    renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    expect(h.captures[0]?.groupId).toBe(GROUP_ID);
    expect(typeof h.captures[0]?.handler).toBe("function");
    expect(typeof h.captures[0]?.opts?.onError).toBe("function");
  });

  it("closes the subscription on unmount", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue([]);

    const { unmount } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.captures).toHaveLength(1));
    const close = h.captures[0]?.close;
    expect(close).toBeDefined();
    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("re-fetches and re-subscribes when groupId changes", async () => {
    const h = makeHarness();
    const roleA = makeRole("role_a");
    const roleB = makeRole("role_b", { groupId: ALT_GROUP_ID });
    h.list.mockImplementation((id: GroupId) =>
      Promise.resolve(id === GROUP_ID ? [roleA] : [roleB]),
    );

    const { result, rerender } = renderHook(({ id }: { id: GroupId }) => useRoles(id), {
      initialProps: { id: GROUP_ID },
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.roles).toEqual([roleA]));
    const firstClose = h.captures[0]?.close;
    expect(firstClose).toBeDefined();

    rerender({ id: ALT_GROUP_ID });

    await waitFor(() => expect(result.current.roles).toEqual([roleB]));
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenLastCalledWith(ALT_GROUP_ID);
    await waitFor(() => expect(h.captures).toHaveLength(2));
    expect(h.captures[1]?.groupId).toBe(ALT_GROUP_ID);
  });

  it("appends a new role on role.created", async () => {
    const h = makeHarness();
    const existing = makeRole("role_a");
    h.list.mockResolvedValue([existing]);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const created = makeRole("role_b");
    act(() => {
      handler({
        id: "evt_1",
        type: "role.created",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        role: created,
      });
    });

    expect(result.current.roles).toEqual([existing, created]);
  });

  it("replaces an existing entry when role.created carries a known id", async () => {
    const h = makeHarness();
    const original = makeRole("role_a", { name: "Old" });
    h.list.mockResolvedValue([original]);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const replacement = makeRole("role_a", { name: "New" });
    act(() => {
      handler({
        id: "evt_1",
        type: "role.created",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        role: replacement,
      });
    });

    expect(result.current.roles).toHaveLength(1);
    expect(result.current.roles[0]?.name).toBe("New");
  });

  it("removes a role on role.deleted and ignores unknown roleIds", async () => {
    const h = makeHarness();
    const a = makeRole("role_a");
    const b = makeRole("role_b");
    h.list.mockResolvedValue([a, b]);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.roles).toHaveLength(2));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    act(() => {
      handler({
        id: "evt_1",
        type: "role.deleted",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        roleId: a.id,
      });
    });
    expect(result.current.roles).toEqual([b]);

    const snapshot = result.current.roles;
    act(() => {
      handler({
        id: "evt_2",
        type: "role.deleted",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        roleId: "role_unknown" as RoleId,
      });
    });
    expect(result.current.roles).toBe(snapshot);
  });

  it("adds a permission to the affected role on permission.granted", async () => {
    const h = makeHarness();
    const role = makeRole("role_a", { permissions: ["members.kick"] });
    h.list.mockResolvedValue([role]);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    act(() => {
      handler({
        id: "evt_1",
        type: "permission.granted",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        roleId: role.id,
        permission: "members.ban" as PermissionKey,
      });
    });

    expect(result.current.roles[0]?.permissions).toEqual(["members.kick", "members.ban"]);
  });

  it("keeps state untouched when permission.granted repeats an existing permission", async () => {
    const h = makeHarness();
    const role = makeRole("role_a", { permissions: ["members.kick"] });
    h.list.mockResolvedValue([role]);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const snapshot = result.current.roles;
    act(() => {
      handler({
        id: "evt_1",
        type: "permission.granted",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        roleId: role.id,
        permission: "members.kick" as PermissionKey,
      });
    });

    expect(result.current.roles).toBe(snapshot);
  });

  it("removes a permission from the affected role on permission.revoked", async () => {
    const h = makeHarness();
    const role = makeRole("role_a", { permissions: ["members.kick", "members.ban"] });
    h.list.mockResolvedValue([role]);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    act(() => {
      handler({
        id: "evt_1",
        type: "permission.revoked",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        roleId: role.id,
        permission: "members.ban" as PermissionKey,
      });
    });

    expect(result.current.roles[0]?.permissions).toEqual(["members.kick"]);
  });

  it("does not change state for role.changed (member assignment, not a definition change)", async () => {
    const h = makeHarness();
    const role = makeRole("role_a");
    h.list.mockResolvedValue([role]);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(h.captures).toHaveLength(1));
    const handler = h.captures[0]?.handler;
    if (!handler) throw new Error("handler missing");

    const snapshot = result.current.roles;
    act(() => {
      handler({
        id: "evt_1",
        type: "role.changed",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        userId: "user_a" as UserId,
        added: [role.id],
        removed: [],
        actorUserId: null,
      });
    });

    expect(result.current.roles).toBe(snapshot);
  });

  it("captures a streaming error via onError without clearing the snapshot", async () => {
    const h = makeHarness();
    const role = makeRole("role_a");
    h.list.mockResolvedValue([role]);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.roles).toHaveLength(1));
    const onError = h.captures[0]?.opts?.onError;
    if (!onError) throw new Error("onError missing");

    act(() => {
      onError(new Error("stream dropped"));
    });

    expect(result.current.error).toEqual(new Error("stream dropped"));
    expect(result.current.roles).toEqual([role]);
  });

  it("captures a thrown subscribe handshake error into result.error", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue([]);
    const handshakeError = new JunjoError("forbidden", "permission_denied", 403);
    h.subscribe.mockImplementationOnce(() => Promise.reject(handshakeError));

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.error).toBe(handshakeError));
    expect(result.current.loading).toBe(false);
  });

  it("surfaces a server-initiated stream close as a stream error", async () => {
    const h = makeHarness();
    const role = makeRole("role_a");
    h.list.mockResolvedValue([role]);

    const { result } = renderHook(() => useRoles(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(h.captures).toHaveLength(1));
    const onClose = h.captures[0]?.opts?.onClose;
    if (!onClose) throw new Error("onClose missing");

    act(() => {
      onClose();
    });

    expect(result.current.error?.message).toMatch(/closed by the server/);
    expect(result.current.roles).toEqual([role]);
  });
});
