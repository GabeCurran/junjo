import { Junjo, JunjoError } from "@junjo.io/sdk";
import type { LinkedIdentity, UserId } from "@junjo.io/sdk";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// Imported through the package index on purpose: these tests double as
// a smoke check that the hook is wired into the public API.
import { JunjoProvider, useIdentities } from "./index.js";
import type { UseIdentitiesResult } from "./index.js";

const USER_ID = "game:alice" as UserId;

interface Harness {
  client: Junjo;
  list: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const client = new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  const list = vi.fn();
  Object.assign(client.identities, { list });
  return { client, list };
}

function makeIdentity(userId: string, namespace: string | null, day: number): LinkedIdentity {
  return {
    userId: userId as UserId,
    namespace,
    linkedAt: new Date(`2026-11-0${day}T00:00:00.000Z`),
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

describe("useIdentities", () => {
  it("fetches the person's ids on mount and exposes them on the result", async () => {
    const h = makeHarness();
    const ids = [makeIdentity("game:alice", "game", 1), makeIdentity("web:alice", "web", 2)];
    h.list.mockResolvedValue(ids);

    const { result } = renderHook(() => useIdentities(USER_ID), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.identities).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.identities).toEqual(ids);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith(USER_ID);
  });

  it("exposes an empty list for a never-seen id", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue([]);

    const { result } = renderHook(() => useIdentities(USER_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.identities).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a JunjoError with its code intact through the error field", async () => {
    const h = makeHarness();
    const err = new JunjoError("userId: not a valid game id", "invalid_user_id", 400);
    h.list.mockRejectedValue(err);

    const { result } = renderHook(() => useIdentities(USER_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect((result.current.error as JunjoError).code).toBe("invalid_user_id");
    expect(result.current.identities).toEqual([]);
  });

  it("refetch re-runs the fetch and replaces the data", async () => {
    const h = makeHarness();
    h.list.mockResolvedValueOnce([makeIdentity("game:alice", "game", 1)]);

    const { result } = renderHook(() => useIdentities(USER_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.identities).toHaveLength(1));

    h.list.mockResolvedValueOnce([
      makeIdentity("game:alice", "game", 1),
      makeIdentity("web:alice", "web", 2),
    ]);
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.identities.map((i) => i.userId)).toEqual(["game:alice", "web:alice"]);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("refetches when userId changes", async () => {
    const h = makeHarness();
    h.list.mockImplementation(async (userId: UserId) => [makeIdentity(userId, null, 1)]);

    const { result, rerender } = renderHook(({ id }: { id: UserId }) => useIdentities(id), {
      wrapper: wrapper(h.client),
      initialProps: { id: "alice" as UserId },
    });
    await waitFor(() => expect(result.current.identities[0]?.userId).toBe("alice"));

    rerender({ id: "bob" as UserId });
    await waitFor(() => expect(result.current.identities[0]?.userId).toBe("bob"));
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(h.list).toHaveBeenLastCalledWith("bob");
  });

  it("refetches when the provider's client is swapped", async () => {
    const a = makeHarness();
    const b = makeHarness();
    a.list.mockResolvedValue([makeIdentity("game:from_a", "game", 1)]);
    b.list.mockResolvedValue([makeIdentity("game:from_b", "game", 1)]);

    let captured: UseIdentitiesResult | undefined;
    function Probe() {
      captured = useIdentities(USER_ID);
      return null;
    }
    function Tree({ client }: { client: Junjo }) {
      return (
        <JunjoProvider client={client}>
          <Probe />
        </JunjoProvider>
      );
    }

    const { rerender } = render(<Tree client={a.client} />);
    await waitFor(() => expect(captured?.identities[0]?.userId).toBe("game:from_a"));

    rerender(<Tree client={b.client} />);
    await waitFor(() => expect(captured?.identities[0]?.userId).toBe("game:from_b"));
    expect(b.list).toHaveBeenCalledTimes(1);
  });

  it("parses linkedAt into a Date through the real client", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(input.toString()).pathname).toBe("/v1/users/game%3Aalice/identities");
      return new Response(
        JSON.stringify({
          items: [
            { userId: "game:alice", namespace: "game", linkedAt: "2026-11-01T00:00:00.000Z" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new Junjo({
      apiKey: "test_prefix.test_secret",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const { result } = renderHook(() => useIdentities(USER_ID), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.identities[0]?.linkedAt).toBeInstanceOf(Date);
    expect(result.current.identities[0]?.namespace).toBe("game");
  });
});
