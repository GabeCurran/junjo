import { Junjo } from "@junjo.io/sdk";
import type { GroupId, PermissionCheckResult, PermissionKey, UserId } from "@junjo.io/shared";
import { render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { type CanQuery, useCan, useCanMany } from "./useCan.js";

const USER_ID = "user_a" as UserId;
const GROUP_ID = "grp_alpha" as GroupId;
const ALT_GROUP_ID = "grp_beta" as GroupId;
const PERMISSION = "invite_member" as PermissionKey;
const ALT_PERMISSION = "kick_member" as PermissionKey;

const CHECKS: CanQuery[] = [
  { userId: USER_ID, groupId: GROUP_ID, permission: PERMISSION },
  { userId: USER_ID, groupId: ALT_GROUP_ID, permission: ALT_PERMISSION },
];

function allow(allowed: boolean): PermissionCheckResult {
  return { allowed, source: allowed ? "role" : "default" };
}

interface Harness {
  client: Junjo;
  can: ReturnType<typeof vi.fn>;
  checkBatch: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const client = new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  const can = vi.fn();
  const checkBatch = vi.fn();
  Object.assign(client, { can, checkBatch });
  return { client, can, checkBatch };
}

function wrapper(client: Junjo) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <JunjoProvider client={client}>{children}</JunjoProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCanMany", () => {
  it("returns undefined per entry while the batch is in flight", () => {
    const h = makeHarness();
    h.checkBatch.mockReturnValue(new Promise<PermissionCheckResult[]>(() => {}));

    const { result } = renderHook(() => useCanMany(CHECKS), { wrapper: wrapper(h.client) });

    expect(result.current).toEqual([undefined, undefined]);
  });

  it("resolves answers positionally from one request", async () => {
    const h = makeHarness();
    h.checkBatch.mockResolvedValue([allow(true), allow(false)]);

    const { result } = renderHook(() => useCanMany(CHECKS), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current).toEqual([true, false]));
    expect(h.checkBatch).toHaveBeenCalledTimes(1);
    expect(h.checkBatch).toHaveBeenCalledWith(CHECKS);
  });

  it("makes no request for an empty list", () => {
    const h = makeHarness();
    const { result } = renderHook(() => useCanMany([]), { wrapper: wrapper(h.client) });

    expect(result.current).toEqual([]);
    expect(h.checkBatch).not.toHaveBeenCalled();
  });

  it("does not refetch when the caller passes a fresh array of the same tuples", async () => {
    const h = makeHarness();
    h.checkBatch.mockResolvedValue([allow(true), allow(false)]);

    const { result, rerender } = renderHook(
      () =>
        useCanMany([
          { userId: USER_ID, groupId: GROUP_ID, permission: PERMISSION },
          { userId: USER_ID, groupId: ALT_GROUP_ID, permission: ALT_PERMISSION },
        ]),
      { wrapper: wrapper(h.client) },
    );

    await waitFor(() => expect(result.current).toEqual([true, false]));
    const first = result.current;
    rerender();
    rerender();

    expect(h.checkBatch).toHaveBeenCalledTimes(1);
    // A stable snapshot reference is what keeps useSyncExternalStore
    // from re-rendering forever.
    expect(result.current).toBe(first);
  });

  it("refetches only the entries that changed", async () => {
    const h = makeHarness();
    h.checkBatch.mockImplementation(async (queries: CanQuery[]) =>
      queries.map((q) => allow(q.permission === PERMISSION)),
    );

    const { result, rerender } = renderHook(
      ({ permission }: { permission: PermissionKey }) =>
        useCanMany([
          { userId: USER_ID, groupId: GROUP_ID, permission: PERMISSION },
          { userId: USER_ID, groupId: ALT_GROUP_ID, permission },
        ]),
      { initialProps: { permission: ALT_PERMISSION }, wrapper: wrapper(h.client) },
    );

    await waitFor(() => expect(result.current).toEqual([true, false]));
    expect(h.checkBatch).toHaveBeenCalledTimes(1);

    rerender({ permission: "ban_member" as PermissionKey });

    await waitFor(() => expect(result.current).toEqual([true, false]));
    // The first entry was already cached, so only the new tuple is sent.
    expect(h.checkBatch).toHaveBeenCalledTimes(2);
    expect(h.checkBatch).toHaveBeenLastCalledWith([
      { userId: USER_ID, groupId: ALT_GROUP_ID, permission: "ban_member" },
    ]);
  });

  it("shares the cache with useCan", async () => {
    const h = makeHarness();
    h.can.mockResolvedValue(true);
    h.checkBatch.mockResolvedValue([allow(false)]);
    const W = wrapper(h.client);

    function Both() {
      const single = useCan(USER_ID, GROUP_ID, PERMISSION);
      const many = useCanMany([
        { userId: USER_ID, groupId: GROUP_ID, permission: PERMISSION },
        { userId: USER_ID, groupId: ALT_GROUP_ID, permission: ALT_PERMISSION },
      ]);
      return (
        <>
          <span data-testid="single">{single === undefined ? "loading" : String(single)}</span>
          <span data-testid="many">{many.map((v) => String(v)).join(",")}</span>
        </>
      );
    }

    const { findByTestId } = render(
      <W>
        <Both />
      </W>,
    );

    const single = await findByTestId("single");
    const many = await findByTestId("many");
    await waitFor(() => expect(single.textContent).toBe("true"));
    await waitFor(() => expect(many.textContent).toBe("true,false"));

    // The tuple useCan owns is not repeated in the batch.
    expect(h.checkBatch).toHaveBeenCalledWith([
      { userId: USER_ID, groupId: ALT_GROUP_ID, permission: ALT_PERMISSION },
    ]);
  });

  it("leaves entries undefined when the batch rejects, without throwing", async () => {
    const h = makeHarness();
    h.checkBatch.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useCanMany(CHECKS), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.checkBatch).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual([undefined, undefined]);
  });

  it("treats a short result array as denied rather than crashing", async () => {
    const h = makeHarness();
    h.checkBatch.mockResolvedValue([allow(true)]);

    const { result } = renderHook(() => useCanMany(CHECKS), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current).toEqual([true, false]));
  });

  it("keys inherited answers separately from direct ones", async () => {
    const h = makeHarness();
    h.checkBatch.mockImplementation(async (queries: CanQuery[], opts?: { inherit?: boolean }) =>
      queries.map(() => allow(opts?.inherit === true)),
    );
    const one = [CHECKS[0] as CanQuery];

    const { result: direct } = renderHook(() => useCanMany(one), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(direct.current).toEqual([false]));

    const { result: inherited } = renderHook(() => useCanMany(one, { inherit: true }), {
      wrapper: wrapper(h.client),
    });
    await waitFor(() => expect(inherited.current).toEqual([true]));
  });

  it("omits the options argument when not inheriting", async () => {
    const h = makeHarness();
    h.checkBatch.mockResolvedValue([allow(true), allow(true)]);

    renderHook(() => useCanMany(CHECKS), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.checkBatch).toHaveBeenCalledTimes(1));
    expect(h.checkBatch).toHaveBeenCalledWith(CHECKS);
  });

  it("forwards inherit to the SDK", async () => {
    const h = makeHarness();
    h.checkBatch.mockResolvedValue([allow(true), allow(true)]);

    renderHook(() => useCanMany(CHECKS, { inherit: true }), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.checkBatch).toHaveBeenCalledTimes(1));
    expect(h.checkBatch).toHaveBeenCalledWith(CHECKS, { inherit: true });
  });
});

describe("useCan inherit", () => {
  it("omits the options argument by default", async () => {
    const h = makeHarness();
    h.can.mockResolvedValue(true);

    const { result } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current).toBe(true));
    expect(h.can).toHaveBeenCalledWith(USER_ID, GROUP_ID, PERMISSION);
  });

  it("forwards inherit to the SDK", async () => {
    const h = makeHarness();
    h.can.mockResolvedValue(true);

    const { result } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION, { inherit: true }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current).toBe(true));
    expect(h.can).toHaveBeenCalledWith(USER_ID, GROUP_ID, PERMISSION, { inherit: true });
  });

  it("caches inherited and direct answers under different keys", async () => {
    const h = makeHarness();
    h.can.mockImplementation(
      async (_u: UserId, _g: GroupId, _p: PermissionKey, opts?: { inherit?: boolean }) =>
        opts?.inherit === true,
    );
    const W = wrapper(h.client);

    function Both() {
      const direct = useCan(USER_ID, GROUP_ID, PERMISSION);
      const inherited = useCan(USER_ID, GROUP_ID, PERMISSION, { inherit: true });
      return (
        <span data-testid="both">
          {String(direct)},{String(inherited)}
        </span>
      );
    }

    const { findByTestId } = render(
      <W>
        <Both />
      </W>,
    );

    const node = await findByTestId("both");
    await waitFor(() => expect(node.textContent).toBe("false,true"));
    expect(h.can).toHaveBeenCalledTimes(2);
  });
});
