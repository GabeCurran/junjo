import { Junjo } from "@junjo/sdk";
import type { FriendRequestList, Friendship, FriendshipPage, UserId } from "@junjo/sdk";
import { render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// Imported through the package index on purpose: these tests double as
// a smoke check that the friends hooks are wired into the public API.
import { JunjoProvider, useFriendRequests, useFriends } from "./index.js";
import type { UseFriendsResult } from "./index.js";

const USER_ID = "user_a" as UserId;

interface Harness {
  client: Junjo;
  list: ReturnType<typeof vi.fn>;
  requestsList: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const client = new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  const list = vi.fn();
  const requestsList = vi.fn();
  Object.assign(client.friends, { list });
  Object.assign(client.friends.requests, { list: requestsList });
  return { client, list, requestsList };
}

function makeFriendship(junjoUserId: string): Friendship {
  return {
    id: `frd_${junjoUserId}`,
    gameId: "game_test",
    junjoUserId: junjoUserId as UserId,
    since: new Date("2026-05-01T00:00:00.000Z"),
  };
}

function friendsPage(items: Friendship[], nextCursor: string | null = null): FriendshipPage {
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

describe("useFriends", () => {
  it("fetches the friends list on mount and exposes it on the result", async () => {
    const h = makeHarness();
    const friend = makeFriendship("user_b");
    h.list.mockResolvedValue(friendsPage([friend]));

    const { result } = renderHook(() => useFriends(USER_ID), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.friends).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.friends).toEqual([friend]);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith(USER_ID, {
      limit: undefined,
      tagId: undefined,
      viewer: undefined,
    });
  });

  it("refetches when the provider's client is swapped", async () => {
    const a = makeHarness();
    const b = makeHarness();
    const fromA = makeFriendship("user_from_a");
    const fromB = makeFriendship("user_from_b");
    a.list.mockResolvedValue(friendsPage([fromA]));
    b.list.mockResolvedValue(friendsPage([fromB]));

    let captured: UseFriendsResult | undefined;
    function Probe() {
      captured = useFriends(USER_ID);
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
    await waitFor(() => expect(captured?.friends).toEqual([fromA]));
    expect(a.list).toHaveBeenCalledTimes(1);

    rerender(<Tree client={b.client} />);

    await waitFor(() => expect(captured?.friends).toEqual([fromB]));
    expect(b.list).toHaveBeenCalledTimes(1);
    expect(a.list).toHaveBeenCalledTimes(1);
  });
});

describe("useFriendRequests", () => {
  it("fetches inbound and outbound requests on mount", async () => {
    const h = makeHarness();
    const requests: FriendRequestList = {
      inbound: [
        {
          id: "req_in",
          gameId: "game_test",
          actorJunjoUserId: "user_b" as UserId,
          targetJunjoUserId: USER_ID,
          createdAt: new Date("2026-05-02T00:00:00.000Z"),
        },
      ],
      outbound: [],
    };
    h.requestsList.mockResolvedValue(requests);

    const { result } = renderHook(() => useFriendRequests(USER_ID, { direction: "both" }), {
      wrapper: wrapper(h.client),
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.requests).toEqual({ inbound: [], outbound: [] });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.requests).toEqual(requests);
    expect(result.current.error).toBeNull();
    expect(h.requestsList).toHaveBeenCalledTimes(1);
    expect(h.requestsList).toHaveBeenCalledWith(USER_ID, { direction: "both" });
  });

  it("surfaces a fetch failure as error without throwing", async () => {
    const h = makeHarness();
    h.requestsList.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useFriendRequests(USER_ID), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.requests).toEqual({ inbound: [], outbound: [] });
  });
});
