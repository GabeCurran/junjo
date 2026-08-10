import { Junjo, JunjoError } from "@junjo.io/sdk";
import type { SubscribeOptions, Subscription } from "@junjo.io/sdk";
import type {
  GameId,
  Group,
  GroupId,
  Invitation,
  InvitationId,
  JunjoEvent,
  Member,
  MemberId,
  Page,
  UserId,
} from "@junjo.io/shared";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { JunjoStreamClosedError, SubscriptionHub, isStreamClosedError } from "./subscriptionHub.js";
import { useGroup } from "./useGroup.js";
import { useInvitations } from "./useInvitations.js";
import type { UseInvitationsResult } from "./useInvitations.js";
import { useMembers } from "./useMembers.js";
import type { UseMembersResult } from "./useMembers.js";

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
  invitationsList: ReturnType<typeof vi.fn>;
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
  const invitationsList = vi.fn();
  const subscribe = vi.fn(
    async (groupId: GroupId, handler: (event: JunjoEvent) => void, opts?: SubscribeOptions) => {
      const close = vi.fn();
      captures.push({ groupId, handler, opts, close });
      const sub: Subscription = { close };
      return sub;
    },
  );
  Object.assign(client.groups, { get, subscribe });
  Object.assign(client.members, { list });
  Object.assign(client.invitations, { list: invitationsList });
  return { client, get, list, invitationsList, subscribe, captures };
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
    hasPasscode: false,
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
    bannedUntil: null,
    ...overrides,
  };
}

function makeInvitation(id: string, overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: id as InvitationId,
    groupId: GROUP_ID,
    code: `code_${id}`,
    roleId: null,
    targetUserId: null,
    createdBy: null,
    createdAt: new Date("2026-04-28T00:00:00.000Z"),
    expiresAt: null,
    usedAt: null,
    usedBy: null,
    ...overrides,
  };
}

function memberJoined(member: Member): JunjoEvent {
  return {
    id: "evt_joined",
    type: "member.joined",
    gameId: GAME_ID,
    groupId: GROUP_ID,
    occurredAt: new Date(),
    userId: member.userId,
    member,
  };
}

function page<T>(items: T[], nextCursor: string | null = null): Page<T> {
  return { items, nextCursor };
}

function wrapper(client: Junjo) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <JunjoProvider client={client}>{children}</JunjoProvider>;
  };
}

// Lets an in-flight subscribe handshake settle inside act().
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SubscriptionHub", () => {
  it("opens one stream for the first listener and fans events to every listener", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const eventsA: JunjoEvent[] = [];
    const eventsB: JunjoEvent[] = [];

    hub.subscribe(GROUP_ID, { onEvent: (e) => eventsA.push(e) });
    hub.subscribe(GROUP_ID, { onEvent: (e) => eventsB.push(e) });

    expect(h.subscribe).toHaveBeenCalledTimes(1);
    await Promise.resolve();

    const event = memberJoined(makeMember("user_a"));
    h.captures[0]?.handler(event);
    expect(eventsA).toEqual([event]);
    expect(eventsB).toEqual([event]);
  });

  it("keeps distinct groups on distinct streams", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const eventsA: JunjoEvent[] = [];
    const eventsB: JunjoEvent[] = [];

    hub.subscribe(GROUP_ID, { onEvent: (e) => eventsA.push(e) });
    hub.subscribe(ALT_GROUP_ID, { onEvent: (e) => eventsB.push(e) });

    expect(h.subscribe).toHaveBeenCalledTimes(2);
    expect(h.captures[0]?.groupId).toBe(GROUP_ID);
    expect(h.captures[1]?.groupId).toBe(ALT_GROUP_ID);
    await Promise.resolve();

    const event = memberJoined(makeMember("user_a"));
    h.captures[0]?.handler(event);
    expect(eventsA).toEqual([event]);
    expect(eventsB).toEqual([]);
  });

  it("isolates a throwing listener so its neighbors still receive the event", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const received: JunjoEvent[] = [];

    hub.subscribe(GROUP_ID, {
      onEvent: () => {
        throw new Error("broken listener");
      },
    });
    hub.subscribe(GROUP_ID, { onEvent: (e) => received.push(e) });
    await Promise.resolve();

    const event = memberJoined(makeMember("user_a"));
    expect(() => h.captures[0]?.handler(event)).not.toThrow();
    expect(received).toEqual([event]);
  });

  it("closes the underlying stream only when the last listener unsubscribes", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);

    const unsubA = hub.subscribe(GROUP_ID, { onEvent: vi.fn() });
    const unsubB = hub.subscribe(GROUP_ID, { onEvent: vi.fn() });
    await Promise.resolve();
    const close = h.captures[0]?.close;
    expect(close).toBeDefined();

    unsubA();
    expect(close).not.toHaveBeenCalled();

    unsubB();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe is idempotent: calling it twice does not close a shared stream early", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const received: JunjoEvent[] = [];

    const unsubA = hub.subscribe(GROUP_ID, { onEvent: vi.fn() });
    hub.subscribe(GROUP_ID, { onEvent: (e) => received.push(e) });
    await Promise.resolve();

    unsubA();
    unsubA();
    expect(h.captures[0]?.close).not.toHaveBeenCalled();

    const event = memberJoined(makeMember("user_a"));
    h.captures[0]?.handler(event);
    expect(received).toEqual([event]);
  });

  it("stops notifying a listener after it unsubscribes", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const receivedA: JunjoEvent[] = [];
    const receivedB: JunjoEvent[] = [];

    const unsubA = hub.subscribe(GROUP_ID, { onEvent: (e) => receivedA.push(e) });
    hub.subscribe(GROUP_ID, { onEvent: (e) => receivedB.push(e) });
    await Promise.resolve();

    unsubA();
    const event = memberJoined(makeMember("user_a"));
    h.captures[0]?.handler(event);
    expect(receivedA).toEqual([]);
    expect(receivedB).toEqual([event]);
  });

  it("closes a stream whose handshake resolves after every listener left", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    let resolveSubscribe!: (sub: Subscription) => void;
    const close = vi.fn();
    h.subscribe.mockImplementationOnce(
      () =>
        new Promise<Subscription>((resolve) => {
          resolveSubscribe = (sub) => resolve(sub);
        }),
    );

    const unsub = hub.subscribe(GROUP_ID, { onEvent: vi.fn() });
    unsub();

    resolveSubscribe({ close });
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fans a handshake rejection to every listener's onError and lets the next subscribe retry", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const handshakeError = new JunjoError("forbidden", "permission_denied", 403);
    h.subscribe.mockImplementationOnce(() => Promise.reject(handshakeError));
    const onErrorA = vi.fn();
    const onErrorB = vi.fn();

    hub.subscribe(GROUP_ID, { onEvent: vi.fn(), onError: onErrorA });
    hub.subscribe(GROUP_ID, { onEvent: vi.fn(), onError: onErrorB });
    await Promise.resolve();

    expect(onErrorA).toHaveBeenCalledWith(handshakeError);
    expect(onErrorB).toHaveBeenCalledWith(handshakeError);

    // The failed entry is discarded: a later subscribe opens a fresh
    // stream rather than joining a dead one.
    hub.subscribe(GROUP_ID, { onEvent: vi.fn() });
    expect(h.subscribe).toHaveBeenCalledTimes(2);
  });

  it("fans a stream error to every listener's onError, tears down, and the next subscribe reopens", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const onErrorA = vi.fn();
    const onErrorB = vi.fn();

    hub.subscribe(GROUP_ID, { onEvent: vi.fn(), onError: onErrorA });
    hub.subscribe(GROUP_ID, { onEvent: vi.fn(), onError: onErrorB });
    await Promise.resolve();

    const err = new Error("stream dropped");
    h.captures[0]?.opts?.onError?.(err);
    expect(onErrorA).toHaveBeenCalledWith(err);
    expect(onErrorB).toHaveBeenCalledWith(err);

    hub.subscribe(GROUP_ID, { onEvent: vi.fn() });
    expect(h.subscribe).toHaveBeenCalledTimes(2);
  });

  it("fans a server close to every listener's onClose, tears down, and the next subscribe reopens", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();

    hub.subscribe(GROUP_ID, { onEvent: vi.fn(), onClose: onCloseA });
    hub.subscribe(GROUP_ID, { onEvent: vi.fn(), onClose: onCloseB });
    await Promise.resolve();

    h.captures[0]?.opts?.onClose?.();
    expect(onCloseA).toHaveBeenCalledTimes(1);
    expect(onCloseB).toHaveBeenCalledTimes(1);

    hub.subscribe(GROUP_ID, { onEvent: vi.fn() });
    expect(h.subscribe).toHaveBeenCalledTimes(2);
  });

  it("a stale unsubscribe after teardown does not affect the replacement entry", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const unsubStale = hub.subscribe(GROUP_ID, { onEvent: vi.fn(), onError: vi.fn() });
    await Promise.resolve();

    // A stream error tears the first entry down.
    h.captures[0]?.opts?.onError?.(new Error("stream dropped"));

    // A new listener opens a replacement entry for the same groupId.
    const received: JunjoEvent[] = [];
    hub.subscribe(GROUP_ID, { onEvent: (e) => received.push(e) });
    await Promise.resolve();
    expect(h.subscribe).toHaveBeenCalledTimes(2);

    // The old entry's unsubscribe fires late (an unmount racing the
    // teardown); it must not close the replacement's stream or starve
    // its listener.
    unsubStale();
    expect(h.captures[1]?.close).not.toHaveBeenCalled();

    const event = memberJoined(makeMember("user_a"));
    h.captures[1]?.handler(event);
    expect(received).toEqual([event]);
  });

  it("a throwing onError listener during a teardown fan does not starve its neighbors", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const onErrorB = vi.fn();
    hub.subscribe(GROUP_ID, {
      onEvent: vi.fn(),
      onError: () => {
        throw new Error("broken error listener");
      },
    });
    hub.subscribe(GROUP_ID, { onEvent: vi.fn(), onError: onErrorB });
    await Promise.resolve();

    const err = new Error("stream dropped");
    expect(() => h.captures[0]?.opts?.onError?.(err)).not.toThrow();
    expect(onErrorB).toHaveBeenCalledWith(err);

    // The teardown still completed: the next subscribe opens fresh.
    hub.subscribe(GROUP_ID, { onEvent: vi.fn() });
    expect(h.subscribe).toHaveBeenCalledTimes(2);
  });

  it("a throwing onClose listener during a teardown fan does not starve its neighbors", async () => {
    const h = makeHarness();
    const hub = new SubscriptionHub(h.client);
    const onCloseB = vi.fn();
    hub.subscribe(GROUP_ID, {
      onEvent: vi.fn(),
      onClose: () => {
        throw new Error("broken close listener");
      },
    });
    hub.subscribe(GROUP_ID, { onEvent: vi.fn(), onClose: onCloseB });
    await Promise.resolve();

    expect(() => h.captures[0]?.opts?.onClose?.()).not.toThrow();
    expect(onCloseB).toHaveBeenCalledTimes(1);

    hub.subscribe(GROUP_ID, { onEvent: vi.fn() });
    expect(h.subscribe).toHaveBeenCalledTimes(2);
  });
});

describe("stream-closed discriminator", () => {
  it("a server close surfaces an error that isStreamClosedError identifies", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(page([makeMember("user_a")]));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await flush();

    act(() => {
      h.captures[0]?.opts?.onClose?.();
    });

    expect(result.current.error).toBeInstanceOf(JunjoStreamClosedError);
    expect(isStreamClosedError(result.current.error)).toBe(true);
    // The clean close leaves the loaded snapshot intact.
    expect(result.current.members).toHaveLength(1);
  });

  it("a handshake failure surfaces an error that isStreamClosedError rejects", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(page([]));
    const handshakeError = new JunjoError("forbidden", "permission_denied", 403);
    h.subscribe.mockImplementationOnce(() => Promise.reject(handshakeError));

    const { result } = renderHook(() => useMembers(GROUP_ID), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.error).toBe(handshakeError));
    expect(isStreamClosedError(result.current.error)).toBe(false);
  });
});

describe("StrictMode", () => {
  it("mount/unmount/mount under StrictMode ends with exactly one live stream and events flowing", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(page([makeMember("user_a")]));
    const state: { current: UseMembersResult | null } = { current: null };
    function Probe() {
      state.current = useMembers(GROUP_ID);
      return null;
    }

    render(
      <StrictMode>
        <JunjoProvider client={h.client}>
          <Probe />
        </JunjoProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(state.current?.loading).toBe(false));
    await flush();

    // Churn is acceptable (StrictMode double-invokes effects); a leak
    // is not: every stream but one must have been closed.
    const live = h.captures.filter((c) => c.close.mock.calls.length === 0);
    const dead = h.captures.filter((c) => c.close.mock.calls.length > 0);
    expect(live).toHaveLength(1);
    expect(dead).toHaveLength(h.captures.length - 1);

    // Events on a torn-down stream go nowhere.
    const joiner = makeMember("user_b");
    act(() => {
      for (const c of dead) c.handler(memberJoined(joiner));
    });
    expect(state.current?.members.map((m) => m.userId)).toEqual(["user_a"]);

    // The surviving stream feeds the hook.
    act(() => {
      live[0]?.handler(memberJoined(joiner));
    });
    expect(state.current?.members.map((m) => m.userId)).toEqual(["user_a", "user_b"]);
  });
});

// Integration: the hooks share the hub owned by the provider, so
// several hooks on one group page cost one server connection.
describe("shared subscription via hooks", () => {
  interface ProbeState {
    members: UseMembersResult | null;
    invitations: UseInvitationsResult | null;
  }

  function makeProbes(state: ProbeState) {
    function MembersProbe() {
      state.members = useMembers(GROUP_ID);
      return null;
    }
    function InvitationsProbe() {
      state.invitations = useInvitations(GROUP_ID, { status: "all" });
      return null;
    }
    return { MembersProbe, InvitationsProbe };
  }

  it("two hooks on the same group share one subscribe call and both receive events", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(page([makeMember("user_a")]));
    h.invitationsList.mockResolvedValue(page([makeInvitation("inv_1")]));
    const state: ProbeState = { members: null, invitations: null };
    const { MembersProbe, InvitationsProbe } = makeProbes(state);

    render(
      <JunjoProvider client={h.client}>
        <MembersProbe />
        <InvitationsProbe />
      </JunjoProvider>,
    );

    await waitFor(() => {
      expect(state.members?.loading).toBe(false);
      expect(state.invitations?.loading).toBe(false);
    });
    await flush();
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.captures[0]?.groupId).toBe(GROUP_ID);

    // One fanned member.joined lands in the members list AND marks the
    // matching pending invitation used in the invitations list.
    const joiner = makeMember("user_b");
    const targeted = makeInvitation("inv_2", { targetUserId: joiner.userId });
    act(() => {
      h.captures[0]?.handler({
        id: "evt_inv",
        type: "member.invited",
        gameId: GAME_ID,
        groupId: GROUP_ID,
        occurredAt: new Date(),
        invitation: targeted,
      });
    });
    act(() => {
      h.captures[0]?.handler(memberJoined(joiner));
    });

    expect(state.members?.members.map((m) => m.userId)).toEqual(["user_a", "user_b"]);
    expect(state.invitations?.invitations.find((i) => i.id === targeted.id)?.usedBy).toBe(
      joiner.userId,
    );
  });

  it("keeps the stream open until the last hook unmounts, then closes it once", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(page([]));
    h.invitationsList.mockResolvedValue(page([]));
    const state: ProbeState = { members: null, invitations: null };
    const { MembersProbe, InvitationsProbe } = makeProbes(state);

    function Tree({ showInvitations }: { showInvitations: boolean }) {
      return (
        <JunjoProvider client={h.client}>
          <MembersProbe />
          {showInvitations ? <InvitationsProbe /> : null}
        </JunjoProvider>
      );
    }

    const { rerender, unmount } = render(<Tree showInvitations={true} />);
    await waitFor(() => expect(h.subscribe).toHaveBeenCalledTimes(1));
    await flush();
    const close = h.captures[0]?.close;
    expect(close).toBeDefined();

    rerender(<Tree showInvitations={false} />);
    expect(close).not.toHaveBeenCalled();

    unmount();
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.subscribe).toHaveBeenCalledTimes(1);
  });

  it("server close notifies every subscribed hook through its streamError surface", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(page([makeMember("user_a")]));
    h.invitationsList.mockResolvedValue(page([makeInvitation("inv_1")]));
    const state: ProbeState = { members: null, invitations: null };
    const { MembersProbe, InvitationsProbe } = makeProbes(state);

    render(
      <JunjoProvider client={h.client}>
        <MembersProbe />
        <InvitationsProbe />
      </JunjoProvider>,
    );
    await waitFor(() => {
      expect(state.members?.loading).toBe(false);
      expect(state.invitations?.loading).toBe(false);
    });
    await flush();
    expect(h.captures).toHaveLength(1);

    act(() => {
      h.captures[0]?.opts?.onClose?.();
    });

    expect(state.members?.error?.message).toMatch(/closed by the server/);
    expect(state.invitations?.error?.message).toMatch(/closed by the server/);
    // The close does not clear the loaded snapshots.
    expect(state.members?.members).toHaveLength(1);
    expect(state.invitations?.invitations).toHaveLength(1);
  });

  it("a hook mounted on a different group opens its own stream", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(page([]));
    const stateA: { current: UseMembersResult | null } = { current: null };
    const stateB: { current: UseMembersResult | null } = { current: null };
    function ProbeA() {
      stateA.current = useMembers(GROUP_ID);
      return null;
    }
    function ProbeB() {
      stateB.current = useMembers(ALT_GROUP_ID);
      return null;
    }

    render(
      <JunjoProvider client={h.client}>
        <ProbeA />
        <ProbeB />
      </JunjoProvider>,
    );

    await waitFor(() => expect(h.subscribe).toHaveBeenCalledTimes(2));
    const groupIds = h.captures.map((c) => c.groupId).sort();
    expect(groupIds).toEqual([GROUP_ID, ALT_GROUP_ID].sort());
  });

  it("a full group page (useGroup + useMembers + useInvitations) costs one server connection", async () => {
    const h = makeHarness();
    h.get.mockResolvedValue(makeGroup());
    h.list.mockResolvedValue(page([makeMember("user_a")]));
    h.invitationsList.mockResolvedValue(page([]));
    const state: ProbeState = { members: null, invitations: null };
    const { MembersProbe, InvitationsProbe } = makeProbes(state);
    const groupState: { current: ReturnType<typeof useGroup> | null } = { current: null };
    function GroupProbe() {
      groupState.current = useGroup(GROUP_ID);
      return null;
    }

    render(
      <JunjoProvider client={h.client}>
        <GroupProbe />
        <MembersProbe />
        <InvitationsProbe />
      </JunjoProvider>,
    );

    await waitFor(() => {
      expect(groupState.current?.loading).toBe(false);
      expect(state.members?.loading).toBe(false);
      expect(state.invitations?.loading).toBe(false);
    });
    await flush();
    expect(h.subscribe).toHaveBeenCalledTimes(1);

    // Every hook on the page sees the shared stream's events.
    const joiner = makeMember("user_b");
    act(() => {
      h.captures[0]?.handler(memberJoined(joiner));
    });
    expect(groupState.current?.members.map((m) => m.userId)).toEqual(["user_a", "user_b"]);
    expect(state.members?.members.map((m) => m.userId)).toEqual(["user_a", "user_b"]);
  });
});
