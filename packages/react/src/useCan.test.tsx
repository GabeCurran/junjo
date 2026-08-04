import { Junjo } from "@junjo.io/sdk";
import type { GroupId, PermissionKey, UserId } from "@junjo.io/shared";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { useInvalidatePermissions } from "./permissionCache.js";
import { useCan } from "./useCan.js";

const USER_ID = "user_a" as UserId;
const ALT_USER_ID = "user_b" as UserId;
const GROUP_ID = "grp_alpha" as GroupId;
const ALT_GROUP_ID = "grp_beta" as GroupId;
const PERMISSION = "invite_member" as PermissionKey;
const ALT_PERMISSION = "kick_member" as PermissionKey;

interface Harness {
  client: Junjo;
  can: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const client = new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  const can = vi.fn();
  Object.assign(client, { can });
  return { client, can };
}

function wrapper(client: Junjo) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <JunjoProvider client={client}>{children}</JunjoProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCan", () => {
  it("returns undefined while the request is in flight", () => {
    const h = makeHarness();
    h.can.mockReturnValue(new Promise<boolean>(() => {}));

    const { result } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION), {
      wrapper: wrapper(h.client),
    });

    expect(result.current).toBeUndefined();
  });

  it("resolves to true when the permission is granted", async () => {
    const h = makeHarness();
    h.can.mockResolvedValue(true);

    const { result } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current).toBe(true));
    expect(h.can).toHaveBeenCalledTimes(1);
    expect(h.can).toHaveBeenCalledWith(USER_ID, GROUP_ID, PERMISSION);
  });

  it("resolves to false when the permission is denied", async () => {
    const h = makeHarness();
    h.can.mockResolvedValue(false);

    const { result } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current).toBe(false));
  });

  it("returns undefined when the SDK call rejects (does not throw to the consumer)", async () => {
    const h = makeHarness();
    h.can.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(h.can).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();
  });

  it("dedupes concurrent consumers with identical args to one network call", async () => {
    const h = makeHarness();
    h.can.mockResolvedValue(true);
    const W = wrapper(h.client);

    function Pair() {
      const a = useCan(USER_ID, GROUP_ID, PERMISSION);
      const b = useCan(USER_ID, GROUP_ID, PERMISSION);
      return (
        <>
          <span data-testid="a">{a === undefined ? "loading" : String(a)}</span>
          <span data-testid="b">{b === undefined ? "loading" : String(b)}</span>
        </>
      );
    }

    const { findByTestId } = render(
      <W>
        <Pair />
      </W>,
    );

    const a = await findByTestId("a");
    const b = await findByTestId("b");
    await waitFor(() => expect(a.textContent).toBe("true"));
    expect(b.textContent).toBe("true");
    expect(h.can).toHaveBeenCalledTimes(1);
  });

  it("fetches separately when any of (userId, groupId, permission) differ", async () => {
    const h = makeHarness();
    h.can.mockImplementation(async (u: UserId, _g: GroupId, p: PermissionKey) => {
      if (u === ALT_USER_ID) return false;
      if (p === ALT_PERMISSION) return false;
      return true;
    });

    const { result: r1 } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION), {
      wrapper: wrapper(h.client),
    });
    const { result: r2 } = renderHook(() => useCan(ALT_USER_ID, GROUP_ID, PERMISSION), {
      wrapper: wrapper(h.client),
    });
    const { result: r3 } = renderHook(() => useCan(USER_ID, ALT_GROUP_ID, PERMISSION), {
      wrapper: wrapper(h.client),
    });
    const { result: r4 } = renderHook(() => useCan(USER_ID, GROUP_ID, ALT_PERMISSION), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => {
      expect(r1.current).toBe(true);
      expect(r2.current).toBe(false);
      expect(r3.current).toBe(true);
      expect(r4.current).toBe(false);
    });
    expect(h.can).toHaveBeenCalledTimes(4);
  });

  it("re-fetches when the arguments change between renders", async () => {
    const h = makeHarness();
    h.can.mockImplementation(async (_u: UserId, _g: GroupId, p: PermissionKey) => p === PERMISSION);

    const { result, rerender } = renderHook(
      ({ permission }: { permission: PermissionKey }) => useCan(USER_ID, GROUP_ID, permission),
      {
        initialProps: { permission: PERMISSION },
        wrapper: wrapper(h.client),
      },
    );

    await waitFor(() => expect(result.current).toBe(true));
    expect(h.can).toHaveBeenCalledTimes(1);

    rerender({ permission: ALT_PERMISSION });

    await waitFor(() => expect(result.current).toBe(false));
    expect(h.can).toHaveBeenCalledTimes(2);
    expect(h.can).toHaveBeenLastCalledWith(USER_ID, GROUP_ID, ALT_PERMISSION);
  });

  it("scopes the cache per provider: separate providers do not share results", async () => {
    const a = makeHarness();
    const b = makeHarness();
    a.can.mockResolvedValue(true);
    b.can.mockResolvedValue(false);

    const { result: rA } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION), {
      wrapper: wrapper(a.client),
    });
    const { result: rB } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION), {
      wrapper: wrapper(b.client),
    });

    await waitFor(() => {
      expect(rA.current).toBe(true);
      expect(rB.current).toBe(false);
    });
    expect(a.can).toHaveBeenCalledTimes(1);
    expect(b.can).toHaveBeenCalledTimes(1);
  });

  it("returns the cached value synchronously on a remount within the same provider", async () => {
    const h = makeHarness();
    h.can.mockResolvedValue(true);
    let secondAllowed: boolean | undefined = undefined;

    function First() {
      const allowed = useCan(USER_ID, GROUP_ID, PERMISSION);
      return <span data-testid="first">{allowed === undefined ? "loading" : String(allowed)}</span>;
    }
    function Second() {
      secondAllowed = useCan(USER_ID, GROUP_ID, PERMISSION);
      return null;
    }
    function Tree({ phase }: { phase: "first" | "second" }) {
      return (
        <JunjoProvider client={h.client}>
          {phase === "first" ? <First /> : <Second />}
        </JunjoProvider>
      );
    }

    const { rerender, findByTestId } = render(<Tree phase="first" />);
    const node = await findByTestId("first");
    await waitFor(() => expect(node.textContent).toBe("true"));
    expect(h.can).toHaveBeenCalledTimes(1);

    rerender(<Tree phase="second" />);

    expect(secondAllowed).toBe(true);
    expect(h.can).toHaveBeenCalledTimes(1);
  });

  it("throws a descriptive error when used outside a JunjoProvider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION))).toThrow(
        /must be used inside a <JunjoProvider>/,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("retries a failed fetch on a subsequent mount (errors are not cached)", async () => {
    const h = makeHarness();
    h.can.mockRejectedValueOnce(new Error("transient"));
    const W = wrapper(h.client);

    const { result: first, unmount } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION), {
      wrapper: W,
    });
    await waitFor(() => expect(h.can).toHaveBeenCalledTimes(1));
    expect(first.current).toBeUndefined();
    unmount();

    h.can.mockResolvedValueOnce(true);
    const { result: second } = renderHook(() => useCan(USER_ID, GROUP_ID, PERMISSION), {
      wrapper: W,
    });

    await waitFor(() => expect(second.current).toBe(true));
    expect(h.can).toHaveBeenCalledTimes(2);
  });

  it("refetches after invalidateUser clears the cached value", async () => {
    const h = makeHarness();
    h.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const { result } = renderHook(
      () => ({
        allowed: useCan(USER_ID, GROUP_ID, PERMISSION),
        invalidate: useInvalidatePermissions(),
      }),
      { wrapper: wrapper(h.client) },
    );

    await waitFor(() => expect(result.current.allowed).toBe(true));
    expect(h.can).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.invalidate.invalidateUser(USER_ID);
    });

    await waitFor(() => expect(result.current.allowed).toBe(false));
    expect(h.can).toHaveBeenCalledTimes(2);
  });

  it("refetches after a targeted invalidate of the exact triple", async () => {
    const h = makeHarness();
    h.can.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { result } = renderHook(
      () => ({
        allowed: useCan(USER_ID, GROUP_ID, PERMISSION),
        invalidate: useInvalidatePermissions(),
      }),
      { wrapper: wrapper(h.client) },
    );

    await waitFor(() => expect(result.current.allowed).toBe(false));

    act(() => {
      result.current.invalidate.invalidate(USER_ID, GROUP_ID, PERMISSION);
    });

    await waitFor(() => expect(result.current.allowed).toBe(true));
    expect(h.can).toHaveBeenCalledTimes(2);
  });

  it("does not refetch a consumer whose group was not invalidated", async () => {
    const h = makeHarness();
    h.can.mockResolvedValue(true);

    const { result } = renderHook(
      () => ({
        allowed: useCan(USER_ID, GROUP_ID, PERMISSION),
        invalidate: useInvalidatePermissions(),
      }),
      { wrapper: wrapper(h.client) },
    );

    await waitFor(() => expect(result.current.allowed).toBe(true));
    expect(h.can).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.invalidate.invalidateGroup(ALT_GROUP_ID);
    });

    expect(result.current.allowed).toBe(true);
    expect(h.can).toHaveBeenCalledTimes(1);
  });

  it("notifies all consumers of the same key when the request resolves", async () => {
    const h = makeHarness();
    let resolve!: (allowed: boolean) => void;
    h.can.mockReturnValue(
      new Promise<boolean>((r) => {
        resolve = r;
      }),
    );
    const W = wrapper(h.client);

    function Twin({ id }: { id: string }) {
      const allowed = useCan(USER_ID, GROUP_ID, PERMISSION);
      return <span data-testid={id}>{allowed === undefined ? "loading" : String(allowed)}</span>;
    }

    const { findByTestId } = render(
      <W>
        <Twin id="x" />
        <Twin id="y" />
      </W>,
    );
    const x = await findByTestId("x");
    const y = await findByTestId("y");
    expect(x.textContent).toBe("loading");
    expect(y.textContent).toBe("loading");

    await act(async () => {
      resolve(true);
      await Promise.resolve();
    });

    expect(x.textContent).toBe("true");
    expect(y.textContent).toBe("true");
    expect(h.can).toHaveBeenCalledTimes(1);
  });
});
