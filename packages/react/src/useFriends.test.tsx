import { Junjo, JunjoError } from "@junjo.io/sdk";
import type {
  Block,
  FriendRequestList,
  FriendSuggestion,
  FriendTag,
  Friendship,
  FriendshipPage,
  UserId,
  UserVisibilitySettings,
} from "@junjo.io/sdk";
import type { FriendTagId, GameId, UserRelationshipId } from "@junjo.io/shared";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// Imported through the package index on purpose: these tests double as
// a smoke check that the friends hooks are wired into the public API.
import {
  JunjoProvider,
  useBlocklist,
  useFriendRequests,
  useFriendSuggestions,
  useFriendTags,
  useFriends,
  useUserVisibility,
} from "./index.js";
import type { UseFriendsResult } from "./index.js";

const USER_ID = "user_a" as UserId;
const GAME_ID = "game_test" as GameId;

interface Harness {
  client: Junjo;
  list: ReturnType<typeof vi.fn>;
  requestsList: ReturnType<typeof vi.fn>;
  suggestions: ReturnType<typeof vi.fn>;
  blocksList: ReturnType<typeof vi.fn>;
  tagsList: ReturnType<typeof vi.fn>;
  visibilityGet: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const client = new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  const list = vi.fn();
  const requestsList = vi.fn();
  const suggestions = vi.fn();
  const blocksList = vi.fn();
  const tagsList = vi.fn();
  const visibilityGet = vi.fn();
  Object.assign(client.friends, { list, suggestions });
  Object.assign(client.friends.requests, { list: requestsList });
  Object.assign(client.friends.blocks, { list: blocksList });
  Object.assign(client.friends.tags, { list: tagsList });
  Object.assign(client.friends.visibility, { get: visibilityGet });
  return { client, list, requestsList, suggestions, blocksList, tagsList, visibilityGet };
}

function makeFriendship(junjoUserId: string): Friendship {
  return {
    id: `frd_${junjoUserId}` as UserRelationshipId,
    gameId: "game_test" as GameId,
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
          id: "req_in" as UserRelationshipId,
          gameId: "game_test" as GameId,
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

function makeSuggestion(junjoUserId: string): FriendSuggestion {
  return {
    junjoUserId: junjoUserId as UserId,
    mutualCount: 3,
    sampleMutualJunjoUserIds: ["user_mutual" as UserId],
  };
}

function makeBlock(junjoUserId: string): Block {
  return {
    id: `blk_${junjoUserId}` as UserRelationshipId,
    gameId: GAME_ID,
    junjoUserId: junjoUserId as UserId,
    blockedAt: new Date("2026-05-03T00:00:00.000Z"),
  };
}

function makeTag(name: string): FriendTag {
  return {
    id: `tag_${name}` as FriendTagId,
    gameId: GAME_ID,
    junjoUserId: USER_ID,
    name,
    color: null,
    createdAt: new Date("2026-05-04T00:00:00.000Z"),
  };
}

function makeVisibility(overrides: Partial<UserVisibilitySettings> = {}): UserVisibilitySettings {
  return {
    gameId: GAME_ID,
    junjoUserId: USER_ID,
    friendsListVisibility: "friends-only",
    allowed: ["private", "friends-only", "public"],
    updatedAt: null,
    ...overrides,
  };
}

describe("useFriendSuggestions", () => {
  it("fetches suggestions on mount and forwards the limit", async () => {
    const h = makeHarness();
    const suggestion = makeSuggestion("user_b");
    h.suggestions.mockResolvedValue([suggestion]);

    const { result } = renderHook(() => useFriendSuggestions(USER_ID, { limit: 5 }), {
      wrapper: wrapper(h.client),
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.suggestions).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.suggestions).toEqual([suggestion]);
    expect(result.current.error).toBeNull();
    expect(h.suggestions).toHaveBeenCalledTimes(1);
    expect(h.suggestions).toHaveBeenCalledWith(USER_ID, { limit: 5 });
  });

  it("passes limit: undefined when no options are given", async () => {
    const h = makeHarness();
    h.suggestions.mockResolvedValue([]);

    renderHook(() => useFriendSuggestions(USER_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(h.suggestions).toHaveBeenCalledTimes(1));
    expect(h.suggestions).toHaveBeenCalledWith(USER_ID, { limit: undefined });
  });

  it("surfaces a fetch failure as error without throwing", async () => {
    const h = makeHarness();
    h.suggestions.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useFriendSuggestions(USER_ID), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.suggestions).toEqual([]);
  });

  it("refetch re-runs the fetch and replaces the data", async () => {
    const h = makeHarness();
    h.suggestions.mockResolvedValueOnce([makeSuggestion("user_b")]);

    const { result } = renderHook(() => useFriendSuggestions(USER_ID), {
      wrapper: wrapper(h.client),
    });
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));

    h.suggestions.mockResolvedValueOnce([makeSuggestion("user_c"), makeSuggestion("user_d")]);
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.suggestions.map((s) => s.junjoUserId)).toEqual(["user_c", "user_d"]);
    expect(h.suggestions).toHaveBeenCalledTimes(2);
  });
});

describe("useBlocklist", () => {
  it("fetches the blocklist on mount", async () => {
    const h = makeHarness();
    const block = makeBlock("user_b");
    h.blocksList.mockResolvedValue([block]);

    const { result } = renderHook(() => useBlocklist(USER_ID), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.blocks).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.blocks).toEqual([block]);
    expect(result.current.error).toBeNull();
    expect(h.blocksList).toHaveBeenCalledTimes(1);
    expect(h.blocksList).toHaveBeenCalledWith(USER_ID);
  });

  it("surfaces a JunjoError with its code intact through the error field", async () => {
    const h = makeHarness();
    const err = new JunjoError("slow down", "rate_limit_exceeded", 429);
    h.blocksList.mockRejectedValue(err);

    const { result } = renderHook(() => useBlocklist(USER_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.error).toBeInstanceOf(JunjoError);
    expect((result.current.error as JunjoError).code).toBe("rate_limit_exceeded");
    expect(result.current.blocks).toEqual([]);
  });

  it("refetch re-runs the fetch and replaces the data", async () => {
    const h = makeHarness();
    h.blocksList.mockResolvedValueOnce([makeBlock("user_b")]);

    const { result } = renderHook(() => useBlocklist(USER_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.blocks).toHaveLength(1));

    h.blocksList.mockResolvedValueOnce([]);
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.blocks).toEqual([]);
    expect(h.blocksList).toHaveBeenCalledTimes(2);
  });
});

describe("useFriendTags", () => {
  it("fetches the user's tags on mount", async () => {
    const h = makeHarness();
    const tag = makeTag("Raid group");
    h.tagsList.mockResolvedValue([tag]);

    const { result } = renderHook(() => useFriendTags(USER_ID), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.tags).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tags).toEqual([tag]);
    expect(result.current.error).toBeNull();
    expect(h.tagsList).toHaveBeenCalledTimes(1);
    expect(h.tagsList).toHaveBeenCalledWith(USER_ID);
  });

  it("surfaces a fetch failure as error without throwing", async () => {
    const h = makeHarness();
    h.tagsList.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useFriendTags(USER_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.tags).toEqual([]);
  });

  it("refetch re-runs the fetch and replaces the data", async () => {
    const h = makeHarness();
    h.tagsList.mockResolvedValueOnce([makeTag("Raid group")]);

    const { result } = renderHook(() => useFriendTags(USER_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.tags).toHaveLength(1));

    h.tagsList.mockResolvedValueOnce([makeTag("Raid group"), makeTag("IRL")]);
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.tags.map((t) => t.name)).toEqual(["Raid group", "IRL"]);
    expect(h.tagsList).toHaveBeenCalledTimes(2);
  });
});

describe("useUserVisibility", () => {
  it("fetches the visibility settings on mount", async () => {
    const h = makeHarness();
    const settings = makeVisibility();
    h.visibilityGet.mockResolvedValue(settings);

    const { result } = renderHook(() => useUserVisibility(USER_ID), {
      wrapper: wrapper(h.client),
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.visibility).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.visibility).toEqual(settings);
    expect(result.current.error).toBeNull();
    expect(h.visibilityGet).toHaveBeenCalledTimes(1);
    expect(h.visibilityGet).toHaveBeenCalledWith(USER_ID);
  });

  it("surfaces a fetch failure as error without throwing", async () => {
    const h = makeHarness();
    h.visibilityGet.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useUserVisibility(USER_ID), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.visibility).toBeNull();
  });

  it("refetch re-runs the fetch and replaces the data", async () => {
    const h = makeHarness();
    h.visibilityGet.mockResolvedValueOnce(makeVisibility());

    const { result } = renderHook(() => useUserVisibility(USER_ID), {
      wrapper: wrapper(h.client),
    });
    await waitFor(() => expect(result.current.visibility).not.toBeNull());

    const updated = makeVisibility({
      friendsListVisibility: "public",
      updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    });
    h.visibilityGet.mockResolvedValueOnce(updated);
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.visibility).toEqual(updated);
    expect(h.visibilityGet).toHaveBeenCalledTimes(2);
  });
});

describe("useAsync race regressions", () => {
  it("keeps the newest result when two overlapping refetches resolve out of order", async () => {
    const h = makeHarness();
    const initial = makeFriendship("user_initial");
    const stale = makeFriendship("user_stale");
    const newest = makeFriendship("user_newest");
    h.list.mockResolvedValueOnce(friendsPage([initial]));

    const { result } = renderHook(() => useFriends(USER_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.friends).toEqual([initial]));

    let resolveFirst!: (page: FriendshipPage) => void;
    let resolveSecond!: (page: FriendshipPage) => void;
    h.list.mockImplementationOnce(
      () =>
        new Promise<FriendshipPage>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    h.list.mockImplementationOnce(
      () =>
        new Promise<FriendshipPage>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    let firstRefetch!: Promise<void>;
    let secondRefetch!: Promise<void>;
    act(() => {
      firstRefetch = result.current.refetch();
      secondRefetch = result.current.refetch();
    });

    // The newer refetch resolves first...
    await act(async () => {
      resolveSecond(friendsPage([newest]));
      await secondRefetch;
    });
    expect(result.current.friends).toEqual([newest]);

    // ...then the older one resolves late and must not clobber it.
    await act(async () => {
      resolveFirst(friendsPage([stale]));
      await firstRefetch;
    });

    expect(result.current.friends).toEqual([newest]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("a refetch resolving after unmount commits no state and logs no error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = makeHarness();
    h.list.mockResolvedValueOnce(friendsPage([makeFriendship("user_b")]));

    const { result, unmount } = renderHook(() => useFriends(USER_ID), {
      wrapper: wrapper(h.client),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolveLate!: (page: FriendshipPage) => void;
    h.list.mockImplementationOnce(
      () =>
        new Promise<FriendshipPage>((resolve) => {
          resolveLate = resolve;
        }),
    );

    let lateRefetch!: Promise<void>;
    act(() => {
      lateRefetch = result.current.refetch();
    });

    unmount();

    await act(async () => {
      resolveLate(friendsPage([makeFriendship("user_late")]));
      await lateRefetch;
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
