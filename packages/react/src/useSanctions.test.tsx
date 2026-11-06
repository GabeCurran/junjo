import { Junjo, JunjoError } from "@junjo.io/sdk";
import type { Sanction, UserId } from "@junjo.io/sdk";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// Imported through the package index on purpose: these tests double as
// a smoke check that the hook is wired into the public API.
import { JunjoProvider, useSanctions } from "./index.js";
import type { UseSanctionsResult } from "./index.js";

const USER_ID = "mc:alice" as UserId;

interface Harness {
  client: Junjo;
  forUser: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const client = new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  const forUser = vi.fn();
  Object.assign(client.sanctions, { forUser });
  return { client, forUser };
}

function makeSanction(type: string, userId: string = USER_ID): Sanction {
  return {
    id: `san_${type}`,
    userId: userId as UserId,
    type,
    reason: null,
    issuer: null,
    issuedBy: null,
    startedAt: new Date("2026-11-09T12:00:00.000Z"),
    expiresAt: null,
    version: 1,
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

describe("useSanctions", () => {
  it("fetches the person's active sanctions on mount", async () => {
    const h = makeHarness();
    const sanctions = [makeSanction("mute"), makeSanction("trade.lock")];
    h.forUser.mockResolvedValue(sanctions);

    const { result } = renderHook(() => useSanctions(USER_ID), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.sanctions).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sanctions).toEqual(sanctions);
    expect(result.current.error).toBeNull();
    expect(h.forUser).toHaveBeenCalledTimes(1);
    expect(h.forUser).toHaveBeenCalledWith(USER_ID);
  });

  it("exposes an empty list for a never-seen id", async () => {
    const h = makeHarness();
    h.forUser.mockResolvedValue([]);

    const { result } = renderHook(() => useSanctions(USER_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sanctions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a JunjoError with its code intact through the error field", async () => {
    const h = makeHarness();
    const err = new JunjoError("userId: not a valid mc id", "invalid_user_id", 400);
    h.forUser.mockRejectedValue(err);

    const { result } = renderHook(() => useSanctions(USER_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect((result.current.error as JunjoError).code).toBe("invalid_user_id");
    expect(result.current.sanctions).toEqual([]);
  });

  it("refetch re-runs the fetch and replaces the data", async () => {
    const h = makeHarness();
    h.forUser.mockResolvedValueOnce([makeSanction("mute")]);

    const { result } = renderHook(() => useSanctions(USER_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.sanctions).toHaveLength(1));

    h.forUser.mockResolvedValueOnce([]);
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.sanctions).toEqual([]);
    expect(h.forUser).toHaveBeenCalledTimes(2);
  });

  it("refetches when userId changes", async () => {
    const h = makeHarness();
    h.forUser.mockImplementation(async (userId: UserId) => [makeSanction("mute", userId)]);

    const { result, rerender } = renderHook(({ id }: { id: UserId }) => useSanctions(id), {
      wrapper: wrapper(h.client),
      initialProps: { id: "mc:alice" as UserId },
    });
    await waitFor(() => expect(result.current.sanctions[0]?.userId).toBe("mc:alice"));

    rerender({ id: "mc:bob" as UserId });
    await waitFor(() => expect(result.current.sanctions[0]?.userId).toBe("mc:bob"));
    expect(h.forUser).toHaveBeenCalledTimes(2);
    expect(h.forUser).toHaveBeenLastCalledWith("mc:bob");
  });

  it("refetches when the provider's client is swapped", async () => {
    const a = makeHarness();
    const b = makeHarness();
    a.forUser.mockResolvedValue([makeSanction("mute")]);
    b.forUser.mockResolvedValue([makeSanction("voice")]);

    let captured: UseSanctionsResult | undefined;
    function Probe() {
      captured = useSanctions(USER_ID);
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
    await waitFor(() => expect(captured?.sanctions[0]?.type).toBe("mute"));

    rerender(<Tree client={b.client} />);
    await waitFor(() => expect(captured?.sanctions[0]?.type).toBe("voice"));
    expect(b.forUser).toHaveBeenCalledTimes(1);
  });

  it("parses dates through the real client", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(input.toString()).pathname).toBe("/v1/users/mc%3Aalice/sanctions");
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "san_1",
              userId: "mc:alice",
              type: "mute",
              reason: "spam",
              issuer: null,
              issuedBy: null,
              startedAt: "2026-11-09T12:00:00.000Z",
              expiresAt: "2026-11-09T13:00:00.000Z",
              version: 2,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new Junjo({
      apiKey: "test_prefix.test_secret",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const { result } = renderHook(() => useSanctions(USER_ID), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.sanctions[0]?.startedAt).toBeInstanceOf(Date);
    expect(result.current.sanctions[0]?.expiresAt).toBeInstanceOf(Date);
    expect(result.current.sanctions[0]?.version).toBe(2);
  });
});
