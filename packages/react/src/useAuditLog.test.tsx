import { Junjo, JunjoError } from "@junjo.io/sdk";
import type { ListAuditOptions } from "@junjo.io/shared";
import type {
  AuditAction,
  AuditEntry,
  AuditEntryId,
  GroupId,
  Page,
  UserId,
} from "@junjo.io/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { useAuditLog } from "./useAuditLog.js";

const GROUP_ID = "grp_alpha" as GroupId;
const ALT_GROUP_ID = "grp_beta" as GroupId;

interface Harness {
  client: Junjo;
  list: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const client = new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  const list = vi.fn();
  const subscribe = vi.fn();
  Object.assign(client.audit, { list });
  Object.assign(client.groups, { subscribe });
  return { client, list, subscribe };
}

function makeEntry(seq: number, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `aud_${seq}` as AuditEntryId,
    groupId: GROUP_ID,
    actorUserId: null,
    action: "group.updated",
    targetId: null,
    payload: {},
    createdAt: new Date(`2026-04-28T00:00:${String(seq).padStart(2, "0")}.000Z`),
    ...overrides,
  };
}

function entriesPage(items: AuditEntry[], nextCursor: string | null = null): Page<AuditEntry> {
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

describe("useAuditLog", () => {
  it("fetches the first page on mount and exposes entries on the result", async () => {
    const h = makeHarness();
    const a = makeEntry(1);
    const b = makeEntry(2);
    h.list.mockResolvedValue(entriesPage([a, b]));

    const { result } = renderHook(() => useAuditLog(GROUP_ID), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.entries).toEqual([]);
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toEqual([a, b]);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, {});
  });

  it("forwards a custom limit to audit.list", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(entriesPage([]));

    renderHook(() => useAuditLog(GROUP_ID, { limit: 25 }), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, { limit: 25 });
  });

  it("forwards an actions filter to audit.list", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(entriesPage([]));
    const actions: AuditAction[] = ["member.invited", "member.joined"];

    renderHook(() => useAuditLog(GROUP_ID, { actions }), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, { actions });
  });

  it("forwards limit and actions together", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(entriesPage([]));
    const actions: AuditAction[] = ["role.assigned"];

    renderHook(() => useAuditLog(GROUP_ID, { actions, limit: 10 }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenCalledWith(GROUP_ID, { actions, limit: 10 });
  });

  it("omits actions when an empty array is supplied", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(entriesPage([]));

    renderHook(() => useAuditLog(GROUP_ID, { actions: [] }), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    const callOpts = h.list.mock.calls[0]?.[1] as ListAuditOptions;
    expect(callOpts.actions).toBeUndefined();
  });

  it("captures a JunjoError thrown by audit.list into result.error", async () => {
    const h = makeHarness();
    const err = new JunjoError("not found", "not_found", 404);
    h.list.mockRejectedValue(err);

    const { result } = renderHook(() => useAuditLog(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.entries).toEqual([]);
  });

  it("refetch resets state and re-runs audit.list", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce(entriesPage([makeEntry(1)]));

    const { result } = renderHook(() => useAuditLog(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    h.list.mockResolvedValueOnce(entriesPage([makeEntry(2), makeEntry(3)]));
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.entries.map((e) => e.id)).toEqual(["aud_2", "aud_3"]);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("does NOT open an SSE subscription (read-only hook)", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(entriesPage([]));

    renderHook(() => useAuditLog(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it("re-fetches when groupId changes", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(entriesPage([]));

    const { rerender } = renderHook(({ id }: { id: GroupId }) => useAuditLog(id), {
      initialProps: { id: GROUP_ID },
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenLastCalledWith(GROUP_ID, {});

    rerender({ id: ALT_GROUP_ID });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    expect(h.list).toHaveBeenLastCalledWith(ALT_GROUP_ID, {});
  });

  it("re-fetches when limit changes", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(entriesPage([]));

    const { rerender } = renderHook(
      ({ limit }: { limit: number }) => useAuditLog(GROUP_ID, { limit }),
      { initialProps: { limit: 25 }, wrapper: wrapper(h.client) },
    );

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    rerender({ limit: 50 });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    expect(h.list).toHaveBeenLastCalledWith(GROUP_ID, { limit: 50 });
  });

  it("re-fetches when the actions filter content changes", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(entriesPage([]));

    const { rerender } = renderHook(
      ({ actions }: { actions: AuditAction[] }) => useAuditLog(GROUP_ID, { actions }),
      {
        initialProps: { actions: ["member.invited"] as AuditAction[] },
        wrapper: wrapper(h.client),
      },
    );

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenLastCalledWith(GROUP_ID, { actions: ["member.invited"] });

    rerender({ actions: ["member.invited", "member.joined"] as AuditAction[] });

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    expect(h.list).toHaveBeenLastCalledWith(GROUP_ID, {
      actions: ["member.invited", "member.joined"],
    });
  });

  it("does NOT re-fetch when actions reference changes but content is equal", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(entriesPage([]));

    const { rerender } = renderHook(
      ({ actions }: { actions: AuditAction[] }) => useAuditLog(GROUP_ID, { actions }),
      {
        initialProps: { actions: ["member.invited", "member.joined"] as AuditAction[] },
        wrapper: wrapper(h.client),
      },
    );

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    rerender({ actions: ["member.invited", "member.joined"] as AuditAction[] });

    await new Promise((r) => setTimeout(r, 10));
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-fetch when actions order changes but membership is equal (sort-stable key)", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(entriesPage([]));

    const { rerender } = renderHook(
      ({ actions }: { actions: AuditAction[] }) => useAuditLog(GROUP_ID, { actions }),
      {
        initialProps: { actions: ["member.invited", "member.joined"] as AuditAction[] },
        wrapper: wrapper(h.client),
      },
    );

    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    rerender({ actions: ["member.joined", "member.invited"] as AuditAction[] });

    await new Promise((r) => setTimeout(r, 10));
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("fetchMore loads the next page using before from nextCursor and appends entries", async () => {
    const h = makeHarness();
    const cursorIso = "2026-04-28T00:00:01.000Z";
    h.list.mockResolvedValueOnce(entriesPage([makeEntry(3), makeEntry(2)], cursorIso));
    h.list.mockResolvedValueOnce(entriesPage([makeEntry(1)]));

    const { result } = renderHook(() => useAuditLog(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.entries.map((e) => e.id)).toEqual(["aud_3", "aud_2", "aud_1"]);
    expect(result.current.hasMore).toBe(false);
    expect(h.list).toHaveBeenCalledTimes(2);
    const lastCall = h.list.mock.calls[1]?.[1] as ListAuditOptions;
    expect(lastCall.before).toBeInstanceOf(Date);
    expect((lastCall.before as Date).toISOString()).toBe(cursorIso);
  });

  it("fetchMore deduplicates entries by id when an existing entry is re-emitted", async () => {
    const h = makeHarness();
    const dup = makeEntry(2);
    h.list.mockResolvedValueOnce(entriesPage([makeEntry(3), dup], "cursor"));
    h.list.mockResolvedValueOnce(entriesPage([dup, makeEntry(1)]));

    const { result } = renderHook(() => useAuditLog(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.entries.map((e) => e.id)).toEqual(["aud_3", "aud_2", "aud_1"]);
  });

  it("fetchMore is a no-op when hasMore is false", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce(entriesPage([makeEntry(1)]));

    const { result } = renderHook(() => useAuditLog(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("fetchMore deduplicates concurrent calls to a single network request", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce(entriesPage([makeEntry(2)], "cursor"));

    let resolveSecond: ((page: Page<AuditEntry>) => void) | null = null;
    const heldPromise = new Promise<Page<AuditEntry>>((resolve) => {
      resolveSecond = resolve;
    });
    h.list.mockReturnValueOnce(heldPromise);

    const { result } = renderHook(() => useAuditLog(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstCall: Promise<void> | null = null;
    let secondCall: Promise<void> | null = null;
    await act(async () => {
      firstCall = result.current.fetchMore();
      secondCall = result.current.fetchMore();
      if (resolveSecond !== null) resolveSecond(entriesPage([makeEntry(1)]));
      await firstCall;
      await secondCall;
    });

    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("fetchMore error preserves the existing snapshot", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce(entriesPage([makeEntry(2)], "cursor"));
    const err = new JunjoError("server error", "internal", 500);
    h.list.mockRejectedValueOnce(err);

    const { result } = renderHook(() => useAuditLog(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.loadingMore).toBe(false);
    expect(result.current.entries).toEqual([makeEntry(2)]);
    expect(result.current.error).toBe(err);
  });

  it("fetchMore forwards limit, actions, and before together", async () => {
    const h = makeHarness();
    const cursorIso = "2026-04-28T00:00:01.000Z";
    h.list.mockResolvedValueOnce(entriesPage([makeEntry(2)], cursorIso));
    h.list.mockResolvedValueOnce(entriesPage([makeEntry(1)]));

    const actions: AuditAction[] = ["member.invited"];
    const { result } = renderHook(() => useAuditLog(GROUP_ID, { actions, limit: 25 }), {
      wrapper: wrapper(h.client),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.fetchMore();
    });

    const lastCall = h.list.mock.calls[1]?.[1] as ListAuditOptions;
    expect(lastCall.limit).toBe(25);
    expect(lastCall.actions).toEqual(actions);
    expect(lastCall.before).toBeInstanceOf(Date);
    expect((lastCall.before as Date).toISOString()).toBe(cursorIso);
  });

  it("does not crash when JunjoProvider is missing (throws via useJunjo)", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      renderHook(() => useAuditLog(GROUP_ID), {
        wrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
      }),
    ).toThrow(/must be used inside a <JunjoProvider>/);
    consoleSpy.mockRestore();
  });

  it("ignores null-as-actorUserId entries in the wire deserialization (sanity check)", async () => {
    const h = makeHarness();
    const e = makeEntry(1, {
      actorUserId: "user_actor" as UserId,
      action: "member.invited",
      targetId: "user_target",
      payload: { invitationId: "inv_1", code: "code_a" },
    });
    h.list.mockResolvedValue(entriesPage([e]));

    const { result } = renderHook(() => useAuditLog(GROUP_ID, { actions: ["member.invited"] }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries[0]?.actorUserId).toBe("user_actor");
    expect(result.current.entries[0]?.payload).toEqual({ invitationId: "inv_1", code: "code_a" });
  });
});
