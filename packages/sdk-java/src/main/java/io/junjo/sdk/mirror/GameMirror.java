package io.junjo.sdk.mirror;

import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.JunjoException;
import io.junjo.sdk.JunjoLogger;
import io.junjo.sdk.JunjoResponse;
import io.junjo.sdk.MembersApi;
import io.junjo.sdk.events.EventType;
import io.junjo.sdk.events.GameSubscription;
import io.junjo.sdk.events.JunjoEvent;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.internal.Backoff;
import io.junjo.sdk.internal.ClientAccess;
import io.junjo.sdk.internal.DurableFiles;
import io.junjo.sdk.internal.Safe;
import io.junjo.sdk.internal.Threads;
import io.junjo.sdk.internal.Transport;
import io.junjo.sdk.model.Ban;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.LinkedIdentity;
import io.junjo.sdk.model.ListBansOptions;
import io.junjo.sdk.model.ListSanctionsOptions;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.Page;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionSource;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.model.RoleGraph;
import io.junjo.sdk.model.Sanction;
import io.junjo.sdk.permissions.ContextInheritance;
import io.junjo.sdk.permissions.PermissionResolver;
import io.junjo.sdk.permissions.PermissionResolver.GroupResolver;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * A local, continuously updated copy of the state a game server checks on its hot path: role
 * graphs for chosen groups, the game's bans and sanctions, and the access of members tracked on
 * demand.
 *
 * <p>Consistency: a load reads the stream position, then the snapshots, then follows the game
 * stream from that position, so no change after the snapshot is missed. A snapshot may already
 * include a few changes the stream then repeats; every application here is idempotent (reload,
 * replace or delete), so a repeat is harmless. Member, ban and sanction events whose version is
 * not newer than the loaded state are skipped without a reload. A {@code 410} (position expired)
 * triggers a full reload from the new position.
 *
 * <p>Threading: every mutation runs on one applier thread, in stream order, and publishes a new
 * immutable state through a volatile field. Reads take no lock and do no I/O, so they are safe on
 * a latency-sensitive thread. A read that needs state not loaded yet answers "unknown"
 * ({@link Answer#UNKNOWN} or an empty Optional) rather than guessing. The {@code onChange},
 * {@code onError} and {@code onResync} callbacks run on the applier thread and must not block:
 * nothing else is applied while they run.
 *
 * <p>Ids: a person may hold several linked ids, and the server names a person in events and lists
 * by one rendered id. The mirror records every known person's ids, so a read by any linked id
 * answers for the person. An id it has not resolved yet answers UNKNOWN for bans and sanctions
 * (unless that exact id is banned or sanctioned) and is resolved in the background;
 * {@link #resolve(String)} and {@link #track(String, String)} resolve eagerly. Ids are compared
 * exactly; the server's id formats already fix their letter case.
 *
 * <p>Arguments: every method that takes a user and a group takes the user first, as
 * {@code permissions().check} does.
 *
 * <p>Failure: a failed load keeps the previous state and is retried with backoff; each failure is
 * reported to {@code onError}. That includes the first load: {@link #start()} keeps retrying
 * through an outage until the mirror is ready. A fatal stream failure (any refused reconnect
 * other than an expiry) is reported to {@code onError}, after which the mirror keeps answering
 * from its last state and {@link #isLive()} turns false.
 *
 * <p>Contexts: a check may name a {@link Context}; the context-less reads check in
 * {@link Context#GLOBAL}, where only global entries apply. The game's context inheritance (its
 * config's {@code permissions.contexts}) comes from the server: every role graph carries it, so
 * the newest graph load sets it, and a {@code permissions.config.updated} event replaces it live.
 * That event also reloads the held graphs when it changes the permission mode. An inheritance set
 * with {@link Builder#contextInheritance(ContextInheritance)} or
 * {@link #setContextInheritance(ContextInheritance)} overrides the server's; it is only needed
 * with a server whose role graphs do not carry the inheritance, and must then match the game's
 * config for the mirror's answers to match {@code permissions().check}.
 *
 * <p>Persistence: with {@link Builder#snapshotFile(Path)} the mirror saves its state to that file
 * and loads it at start, so it answers at once, even before the server is reachable. Loaded data
 * may be stale until the stream, resumed from the saved position, catches up; when that position
 * has expired the mirror reloads everything from the server.
 *
 * <p>Retention: with {@link Builder#retainUntracked(Duration)} an untracked member's last loaded
 * access is kept, in memory and in the snapshot file, for that window after the member was last
 * tracked. A retained member is not tracked: reads do not answer for it, it is not listed by
 * {@link #trackedMembers(String)}, and stream events never reload it. Tracking it again answers
 * from the retained access at once while the access is reloaded. A retained entry is dropped when
 * it outlives the window, when a member event shows a newer version of the membership, when an
 * identity event names any of the person's ids, when its group is deleted, and on a full reload
 * from the server, after which links may have changed.
 */
public final class GameMirror implements AutoCloseable {
    /** The event types the mirror applies; the stream is filtered to these. */
    public static final Set<EventType> EVENT_TYPES = Collections.unmodifiableSet(EnumSet.of(
            EventType.MEMBER_JOINED,
            EventType.MEMBER_LEFT,
            EventType.MEMBER_UPDATED,
            EventType.MEMBER_BANNED,
            EventType.MEMBER_UNBANNED,
            EventType.ROLE_CREATED,
            EventType.ROLE_CHANGED,
            EventType.ROLE_UPDATED,
            EventType.ROLE_DELETED,
            EventType.PERMISSION_GRANTED,
            EventType.PERMISSION_REVOKED,
            EventType.GROUP_UPDATED,
            EventType.GROUP_DELETED,
            EventType.GAME_USER_BANNED,
            EventType.GAME_USER_UNBANNED,
            EventType.GAME_USER_SANCTIONED,
            EventType.GAME_USER_UNSANCTIONED,
            EventType.IDENTITY_LINKED,
            EventType.IDENTITY_UNLINKED,
            EventType.IDENTITY_UPDATED,
            EventType.PERMISSIONS_CONFIG_UPDATED));

    /** The state of the mirror's game stream. */
    public enum StreamState {
        /** Not started yet, or loading before the first connection. */
        CONNECTING,
        CONNECTED,
        /** Dropped and waiting to reconnect; reads answer from the last state. */
        RECONNECTING,
        /** Closed, or stopped by a fatal failure. */
        STOPPED
    }

    private static final int PAGE_SIZE = 100;
    /** Tracks that arrive within this window share one batched access read. */
    private static final long TRACK_BATCH_WINDOW_MS = 10;
    /** The longest gap between two prunes of retained members. */
    private static final long RETAIN_PRUNE_MAX_MS = 60_000;
    private static final String CLOSED_MESSAGE = "mirror closed";

    private final JunjoClient client;
    private final Transport transport;
    private final Set<String> initialGroups;
    private final Clock clock;
    private final Duration loadTimeout;
    private final Duration memberLoadTimeout;
    private final Duration retryBase;
    private final Duration retryMax;
    private final Consumer<Throwable> onError;
    private final Consumer<String> onResync;
    private final Consumer<MirrorChange> onChange;
    private final SubscribeOptions.Builder streamOptions;
    private final boolean defaultRoleForNonMembers;
    private final Path snapshotFile;
    private final Duration snapshotInterval;
    private final Duration retainWindow;
    private final DurableFiles.Disk disk;
    private final JunjoLogger logger;
    private final ExecutorService applier;
    private final AtomicLong skipped = new AtomicLong();
    private final AtomicBoolean startCalled = new AtomicBoolean();
    private final CompletableFuture<GameMirror> started = new CompletableFuture<>();
    private final Set<String> resolving = ConcurrentHashMap.newKeySet();

    private volatile State state = State.EMPTY;
    // The explicit inheritance that wins over the server's, or null to follow the server.
    private volatile ContextInheritance override;
    private volatile boolean closed;
    private volatile boolean live;
    private volatile StreamState streamState = StreamState.CONNECTING;
    private volatile Instant lastEventAt;
    private volatile GameSubscription subscription;

    // Applier-thread-only bookkeeping.
    private final Map<MemberKey, List<CompletableFuture<Void>>> trackWaiters = new HashMap<>();
    private boolean resumeFromSnapshot;
    private boolean snapshotDirty;
    private boolean snapshotSaveScheduled;
    private final Map<String, Set<MemberKey>> pendingTracks = new HashMap<>();
    private boolean trackFlushScheduled;
    private boolean inheritanceChanged;

    private GameMirror(Builder b) {
        this.client = b.client;
        this.transport = ClientAccess.transport(b.client);
        this.initialGroups = Set.copyOf(b.groups);
        this.clock = b.clock;
        this.loadTimeout = b.loadTimeout;
        this.memberLoadTimeout = b.memberLoadTimeout;
        this.retryBase = b.retryBase;
        this.retryMax = b.retryMax;
        this.onError = b.onError;
        this.onResync = b.onResync;
        this.onChange = b.onChange;
        this.streamOptions = b.streamOptions;
        this.defaultRoleForNonMembers = b.defaultRoleForNonMembers;
        this.snapshotFile = b.snapshotFile;
        this.snapshotInterval = b.snapshotInterval;
        this.retainWindow = b.retainWindow;
        this.disk = b.disk;
        this.override = b.inheritance;
        this.logger = transport.logger();
        this.applier = Executors.newSingleThreadExecutor(Threads.daemonFactory("junjo-mirror"));
    }

    public static Builder builder(JunjoClient client) {
        return new Builder(client);
    }

    // ------------------------------------------------------------------ lifecycle

    /**
     * Loads the state and opens the stream. Completes once the mirror answers from loaded state:
     * from the snapshot file when one was configured and readable, else from the server. Failures
     * do not fail the future; they are reported to {@code onError} and retried with backoff, so
     * during an outage the future stays pending until the server answers. It fails only when the
     * mirror is closed first. Calling it again returns the same future.
     */
    public CompletableFuture<GameMirror> start() {
        if (startCalled.compareAndSet(false, true) && !submit(this::boot)) {
            started.completeExceptionally(mirrorClosed());
        }
        return started;
    }

    /** Whether the mirror answers from loaded state, from the server or a snapshot file. */
    public boolean isReady() {
        return state.ready();
    }

    /** Whether the stream is connected or reconnecting (false after a fatal failure). */
    public boolean isLive() {
        return live && !closed;
    }

    public StreamState streamState() {
        return closed ? StreamState.STOPPED : streamState;
    }

    /** The stream position the state reflects, or null before the first load. */
    public String position() {
        return state.position();
    }

    /** When the mirror last applied an event, by its clock; empty before the first one. */
    public Optional<Instant> lastEventAt() {
        return Optional.ofNullable(lastEventAt);
    }

    /** Events skipped because the loaded state was already at least as new. */
    public long skippedEvents() {
        return skipped.get();
    }

    /** Completes once every task queued before this call has been applied: a barrier over the applier. */
    public CompletableFuture<Void> sync() {
        CompletableFuture<Void> f = new CompletableFuture<>();
        if (!submit(() -> f.complete(null))) f.completeExceptionally(mirrorClosed());
        return f;
    }

    /**
     * Closes the stream and stops the applier, after saving the snapshot file when one is
     * configured. The client stays open. Idempotent.
     */
    @Override
    public void close() {
        if (closed) return;
        if (snapshotFile != null && state.ready()) {
            CompletableFuture<Void> saved = new CompletableFuture<>();
            if (submit(() -> {
                saveSnapshot();
                saved.complete(null);
            })) {
                try {
                    saved.get(loadTimeout.toMillis(), TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } catch (ExecutionException | TimeoutException e) {
                    Safe.log(logger, JunjoLogger.Level.WARN, "mirror snapshot was not saved at close", e);
                }
            }
        }
        closed = true;
        live = false;
        GameSubscription sub = subscription;
        if (sub != null) sub.close();
        applier.shutdownNow();
        started.completeExceptionally(mirrorClosed());
    }

    // ------------------------------------------------------------------ reads (lock-free)

    /**
     * Resolves a permission locally. A member who is not active, and a user with no membership in
     * the group, answer {@code allowed=false, source=none}; with
     * {@link Builder#defaultRoleForNonMembers(boolean)} a user with no membership is checked
     * against the group's default role instead. Empty when the group's graph or the member's
     * access is not loaded.
     */
    public Optional<PermissionCheckResult> check(String userId, String groupId, String permission) {
        return check(userId, groupId, permission, Context.GLOBAL);
    }

    /**
     * Resolves a permission locally in a context, as {@code permissions().check} does with the
     * same context: entries limited to a matching context apply, ranked by the game's context
     * inheritance. Otherwise as {@link #check(String, String, String)}.
     */
    public Optional<PermissionCheckResult> check(String userId, String groupId, String permission, Context context) {
        Objects.requireNonNull(context, "context");
        Lookup in = lookup(userId, groupId);
        if (in == null) return Optional.empty();
        if (in.access() == null) return Optional.of(nonMember(in.group(), permission, context));
        return Optional.of(in.group().resolver().check(in.access(), permission, context));
    }

    /** YES or NO, or UNKNOWN when the graph or the member is not loaded. */
    public Answer can(String userId, String groupId, String permission) {
        return can(userId, groupId, permission, Context.GLOBAL);
    }

    /** YES or NO in a context, or UNKNOWN when the graph or the member is not loaded. */
    public Answer can(String userId, String groupId, String permission, Context context) {
        return check(userId, groupId, permission, context).map(r -> Answer.of(r.allowed())).orElse(Answer.UNKNOWN);
    }

    /** A checker for repeated checks of one member with no context; see {@link MemberChecker}. */
    public MemberChecker checker(String userId, String groupId) {
        return checker(userId, groupId, Context.GLOBAL);
    }

    /**
     * A checker for repeated checks of one member in one context; see {@link MemberChecker}. When
     * the member's context changes, take a new checker.
     */
    public MemberChecker checker(String userId, String groupId, Context context) {
        return new MemberChecker(this, Objects.requireNonNull(userId, "userId"),
                Objects.requireNonNull(groupId, "groupId"), Objects.requireNonNull(context, "context"));
    }

    /**
     * The context inheritance checks resolve with: the explicit override when one is set, else the
     * server's ({@link #serverContextInheritance()}).
     */
    public ContextInheritance contextInheritance() {
        ContextInheritance o = override;
        return o != null ? o : state.contexts();
    }

    /**
     * The game's context inheritance as last read from the server, from a role graph or a
     * {@code permissions.config.updated} event, and kept in the snapshot file;
     * {@link ContextInheritance#NONE} before the first load and with a server that does not send
     * it.
     */
    public ContextInheritance serverContextInheritance() {
        return state.contexts();
    }

    /**
     * Sets an explicit context inheritance that checks resolve with instead of the server's. Only
     * needed with a server whose role graphs do not carry the game's inheritance; null removes the
     * override, so checks follow the server's again. Every loaded role graph is recompiled;
     * completes once checks answer with the new inheritance. Reported to {@code onChange} as a
     * {@link MirrorChange.Kind#ROLE_GRAPH} change with null ids.
     */
    public CompletableFuture<Void> setContextInheritance(ContextInheritance next) {
        CompletableFuture<Void> done = new CompletableFuture<>();
        boolean queued = submit(() -> {
            override = next;
            state = recompiled(state);
            changed(MirrorChange.Kind.ROLE_GRAPH, null, null);
            done.complete(null);
        });
        if (!queued) done.completeExceptionally(mirrorClosed());
        return done;
    }

    // Compiles a graph with the override, or else with the server inheritance given.
    GroupState compileGroup(RoleGraph graph, ContextInheritance server) {
        ContextInheritance o = override;
        return new GroupState(graph, PermissionResolver.compile(graph, o != null ? o : server));
    }

    // Every held graph compiled again with the state's effective inheritance.
    private State recompiled(State s) {
        State out = s;
        for (Map.Entry<String, GroupState> g : s.groups().entrySet()) {
            out = out.withGroup(g.getKey(), compileGroup(g.getValue().graph(), s.contexts()));
        }
        return out;
    }

    // Records the server inheritance in a state not published yet. When that changes what checks
    // resolve with, the held graphs are recompiled, and the change is reported by the next
    // reportInheritanceChange, once the state is published.
    private State withServerContexts(State s, ContextInheritance next) {
        if (next.equals(s.contexts())) return s;
        State out = s.withContexts(next);
        if (override != null) return out;
        inheritanceChanged = true;
        return recompiled(out);
    }

    private void reportInheritanceChange() {
        if (!inheritanceChanged) return;
        inheritanceChanged = false;
        changed(MirrorChange.Kind.ROLE_GRAPH, null, null);
    }

    /**
     * Answers from the full game ban list, with lazy expiry judged against the mirror's clock.
     * UNKNOWN before the first load, and for an id not resolved yet that is not itself banned.
     */
    public Answer isBanned(String userId) {
        State s = state;
        if (!s.ready()) return Answer.UNKNOWN;
        Ban ban = findBan(s, userId);
        if (ban != null && ban.isActiveAt(clock.instant())) return Answer.YES;
        return known(s, userId) ? Answer.NO : Answer.UNKNOWN;
    }

    /** The person's active game ban, when one is known. */
    public Optional<Ban> ban(String userId) {
        Ban ban = findBan(state, userId);
        return ban != null && ban.isActiveAt(clock.instant()) ? Optional.of(ban) : Optional.empty();
    }

    /** Every active game ban, keyed by the rendered id it was loaded under. */
    public Map<String, Ban> bans() {
        Instant now = clock.instant();
        Map<String, Ban> out = new HashMap<>();
        state.bans().forEach((id, ban) -> {
            if (ban.isActiveAt(now)) out.put(id, ban);
        });
        return Map.copyOf(out);
    }

    /**
     * The person's active sanction of a type. Expiry is judged against the mirror's clock, because
     * the server emits nothing when a sanction lapses.
     */
    public Optional<Sanction> sanction(String userId, String type) {
        Instant now = clock.instant();
        for (Sanction x : personSanctions(state, userId)) {
            if (x.type().equals(type) && x.isActiveAt(now)) return Optional.of(x);
        }
        return Optional.empty();
    }

    /**
     * YES or NO; UNKNOWN before the first load, and for an id not resolved yet that holds no such
     * sanction itself.
     */
    public Answer isSanctioned(String userId, String type) {
        State s = state;
        if (!s.ready()) return Answer.UNKNOWN;
        if (sanction(userId, type).isPresent()) return Answer.YES;
        return known(s, userId) ? Answer.NO : Answer.UNKNOWN;
    }

    /** The person's active sanctions, newest start first. */
    public List<Sanction> sanctions(String userId) {
        return active(personSanctions(state, userId));
    }

    /** Every active sanction in the game, newest start first. */
    public List<Sanction> sanctionsAll() {
        List<Sanction> all = new ArrayList<>();
        for (Map<String, Sanction> byType : state.sanctions().byUser().values()) all.addAll(byType.values());
        return active(all);
    }

    public Optional<RoleGraph> roleGraph(String groupId) {
        GroupState g = state.groups().get(groupId);
        return g == null ? Optional.empty() : Optional.of(g.graph());
    }

    /** The role, when the group's graph is loaded and holds it. */
    public Optional<Role> role(String groupId, String roleId) {
        return roleGraph(groupId).flatMap(g -> g.role(roleId));
    }

    /**
     * The member's directly held roles, highest priority first; empty when unknown, and an empty
     * list for a non-member.
     */
    public Optional<List<Role>> memberRoles(String userId, String groupId) {
        Lookup in = lookup(userId, groupId);
        if (in == null) return Optional.empty();
        if (in.access() == null) return Optional.of(List.of());
        List<Role> out = new ArrayList<>();
        for (Role r : in.group().graph().roles()) {
            if (in.access().roleIds().contains(r.id())) out.add(r);
        }
        return Optional.of(List.copyOf(out));
    }

    /** The loaded access, metadata included; empty when not loaded or not a member. */
    public Optional<MemberAccess> access(String userId, String groupId) {
        MemberEntry m = findMember(state, userId, groupId);
        return m == null || m.access() == null ? Optional.empty() : Optional.of(m.access());
    }

    /**
     * YES when the member's access is loaded (member or not), NO when tracked but still loading,
     * UNKNOWN when not tracked.
     */
    public Answer isLoaded(String userId, String groupId) {
        MemberEntry m = findMember(state, userId, groupId);
        return m == null ? Answer.UNKNOWN : Answer.of(m.loaded());
    }

    /** The ids of the members tracked in a group, as the mirror keys them. */
    public Set<String> trackedMembers(String groupId) {
        Set<String> out = new HashSet<>();
        for (MemberKey k : state.members().keySet()) if (k.groupId().equals(groupId)) out.add(k.userId());
        return Set.copyOf(out);
    }

    // ------------------------------------------------------------------ resolution and tracking

    /**
     * The id the mirror keys a person by: the id the server renders for them when the mirror has
     * seen it (in a list, an event or a member read), else the person's earliest-linked id, which
     * is what the server renders for a key without a namespace preference. Loads the person's ids
     * when they are not known yet, within the member load timeout.
     */
    public CompletableFuture<String> resolve(String userId) {
        Objects.requireNonNull(userId, "userId");
        CompletableFuture<String> done = new CompletableFuture<>();
        boolean queued = submit(() -> {
            try {
                done.complete(ensurePerson(userId).key());
            } catch (Throwable t) {
                done.completeExceptionally(Transport.unwrap(t));
            }
        });
        if (!queued) done.completeExceptionally(mirrorClosed());
        return done;
    }

    /**
     * Starts following one member: resolves the id, loads the access within the member load
     * timeout, and reloads it on every newer member event. Tracks issued close together are loaded
     * with one batched read per group. The group's role graph is loaded too when the mirror does
     * not hold it. Completes once the access is loaded.
     *
     * <p>A member held by {@link Builder#retainUntracked(Duration)} answers from the retained
     * access as soon as this call is applied, and is reported as an {@link MirrorChange.Kind#ACCESS}
     * change; the access is reloaded as for any other track. The future then completes once that
     * reload has succeeded or failed: a failure is reported to {@code onError} and retried, and
     * the retained access keeps answering until a reload succeeds.
     */
    public CompletableFuture<Void> track(String userId, String groupId) {
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(groupId, "groupId");
        CompletableFuture<Void> done = new CompletableFuture<>();
        boolean queued = submit(() -> {
            Person p;
            try {
                p = ensurePerson(userId);
            } catch (Throwable t) {
                done.completeExceptionally(Transport.unwrap(t));
                return;
            }
            State s = state;
            MemberKey key = findMemberKey(s, userId, groupId);
            if (key != null && s.members().get(key).loaded() && !trackWaiters.containsKey(key)) {
                done.complete(null);
                return;
            }
            boolean fresh = key == null;
            if (fresh) key = new MemberKey(groupId, p.key());
            trackWaiters.computeIfAbsent(key, k -> new ArrayList<>()).add(done);
            if (fresh) {
                RetainedMember kept = takeRetained(p, userId, groupId);
                s = state;
                if (kept != null) {
                    state = s.withMember(key, new MemberEntry(true, kept.access(), kept.version()));
                    changed(MirrorChange.Kind.ACCESS, key.userId(), groupId);
                    markDirty();
                } else {
                    state = s.withMember(key, MemberEntry.PENDING);
                }
                if (!s.groups().containsKey(groupId)) reloadGroup(groupId, 0);
                queueTrackLoad(key);
            }
        });
        if (!queued) done.completeExceptionally(mirrorClosed());
        return done;
    }

    /**
     * Stops following a member. Their state is dropped, or, with
     * {@link Builder#retainUntracked(Duration)}, kept as retained for that window when it was
     * loaded.
     */
    public void untrack(String userId, String groupId) {
        submit(() -> {
            State s = state;
            MemberKey key = findMemberKey(s, userId, groupId);
            if (key == null) return;
            MemberEntry m = s.members().get(key);
            s = s.withoutMember(key);
            if (retainWindow != null && m.loaded()) {
                s = s.withoutRetained(personKeys(s, key.userId(), groupId))
                        .withRetained(key, new RetainedMember(m.access(), clock.instant()));
            }
            state = s;
            failWaiters(key, new JunjoException(JunjoException.CANCELLED, "untracked", null));
            markDirty();
        });
    }

    // Removes and returns the person's retained entry in the group, or null when there is none
    // within the window. Every retained entry of the person in the group is removed.
    private RetainedMember takeRetained(Person p, String userId, String groupId) {
        State s = state;
        if (s.retained().isEmpty()) return null;
        Set<String> ids = new LinkedHashSet<>();
        ids.add(userId);
        ids.addAll(p.ids());
        List<MemberKey> keys = new ArrayList<>();
        RetainedMember newest = null;
        for (String id : ids) {
            MemberKey k = new MemberKey(groupId, id);
            RetainedMember r = s.retained().get(k);
            if (r == null) continue;
            keys.add(k);
            if (newest == null || r.lastConnectedAt().isAfter(newest.lastConnectedAt())) newest = r;
        }
        if (keys.isEmpty()) return null;
        state = s.withoutRetained(keys);
        markDirty();
        return newest != null && withinWindow(newest, clock.instant()) ? newest : null;
    }

    private boolean withinWindow(RetainedMember r, Instant now) {
        return retainWindow != null && r.lastConnectedAt().plus(retainWindow).isAfter(now);
    }

    // The keys the person holding this id could be retained under in the group.
    private static List<MemberKey> personKeys(State s, String userId, String groupId) {
        List<MemberKey> keys = new ArrayList<>();
        for (String id : idsWith(s, userId)) keys.add(new MemberKey(groupId, id));
        return keys;
    }

    // The retained members of a group, by the id each is kept under; read by tests.
    Map<String, RetainedMember> retainedMembers(String groupId) {
        Map<String, RetainedMember> out = new HashMap<>();
        state.retained().forEach((k, r) -> {
            if (k.groupId().equals(groupId)) out.put(k.userId(), r);
        });
        return Map.copyOf(out);
    }

    /** Starts following a group's role graph. Completes once the graph is loaded. */
    public CompletableFuture<Void> trackGroup(String groupId) {
        CompletableFuture<Void> done = new CompletableFuture<>();
        boolean queued = submit(() -> {
            try {
                state = loadGroup(state, groupId);
                reportInheritanceChange();
                changed(MirrorChange.Kind.ROLE_GRAPH, null, groupId);
                markDirty();
                done.complete(null);
            } catch (Throwable t) {
                done.completeExceptionally(Transport.unwrap(t));
            }
        });
        if (!queued) done.completeExceptionally(mirrorClosed());
        return done;
    }

    // ------------------------------------------------------------------ lookups shared with MemberChecker

    record Lookup(GroupState group, MemberAccess access) {}

    // Null when the group's graph or the member's access is not loaded.
    Lookup lookup(String userId, String groupId) {
        State s = state;
        if (!s.ready()) return null;
        GroupState g = s.groups().get(groupId);
        if (g == null) return null;
        MemberEntry m = findMember(s, userId, groupId);
        if (m == null || !m.loaded()) return null;
        return new Lookup(g, m.access());
    }

    boolean defaultRoleApplies(GroupState g) {
        return defaultRoleForNonMembers && g.graph().defaultRoleId() != null;
    }

    // The answer for a user with no membership row: none, or the default role when opted in.
    PermissionCheckResult nonMember(GroupState g, String permission, Context context) {
        if (!defaultRoleApplies(g)) return PermissionCheckResult.of(false, PermissionSource.NONE);
        return g.resolver().check(List.of(g.graph().defaultRoleId()), List.of(), permission, context);
    }

    private static Collection<String> idsOf(State s, String userId) {
        Person p = s.people().get(userId);
        return p == null ? List.of(userId) : p.ids();
    }

    private static Collection<String> idsWith(State s, String userId) {
        Set<String> ids = new LinkedHashSet<>();
        ids.add(userId);
        ids.addAll(idsOf(s, userId));
        return ids;
    }

    // Known: the mirror has resolved the id, or seen it where the server renders ids. Bans and
    // sanctions are keyed by rendered ids, so a rendered id missing from them holds none.
    private static boolean known(State s, String userId) {
        return s.people().containsKey(userId) || s.renderedIds().contains(userId);
    }

    private Ban findBan(State s, String userId) {
        Ban direct = s.bans().get(userId);
        if (direct != null) return direct;
        if (!known(s, userId)) requestResolve(userId);
        for (String id : idsOf(s, userId)) {
            Ban b = s.bans().get(id);
            if (b != null) return b;
        }
        return null;
    }

    private List<Sanction> personSanctions(State s, String userId) {
        if (!known(s, userId)) requestResolve(userId);
        List<Sanction> out = new ArrayList<>();
        for (String id : idsWith(s, userId)) {
            out.addAll(s.sanctions().byUser().getOrDefault(id, Map.of()).values());
        }
        return out;
    }

    private static MemberKey findMemberKey(State s, String userId, String groupId) {
        MemberKey direct = new MemberKey(groupId, userId);
        if (s.members().containsKey(direct)) return direct;
        for (String id : idsOf(s, userId)) {
            MemberKey k = new MemberKey(groupId, id);
            if (s.members().containsKey(k)) return k;
        }
        return null;
    }

    private static MemberEntry findMember(State s, String userId, String groupId) {
        MemberKey k = findMemberKey(s, userId, groupId);
        return k == null ? null : s.members().get(k);
    }

    private List<Sanction> active(Collection<Sanction> list) {
        Instant now = clock.instant();
        List<Sanction> out = new ArrayList<>();
        for (Sanction x : list) if (x.isActiveAt(now)) out.add(x);
        out.sort((a, b) -> b.startedAt().compareTo(a.startedAt()));
        return List.copyOf(out);
    }

    // Called from reads: queues one background resolution per unknown id.
    private void requestResolve(String userId) {
        if (closed || !resolving.add(userId)) return;
        boolean queued = submit(() -> {
            try {
                ensurePerson(userId);
            } catch (Throwable t) {
                report(Transport.unwrap(t));
            } finally {
                resolving.remove(userId);
            }
        });
        if (!queued) resolving.remove(userId);
    }

    // ------------------------------------------------------------------ applier

    private boolean submit(Runnable task) {
        if (closed) return false;
        try {
            applier.execute(() -> {
                if (closed) return;
                try {
                    task.run();
                } catch (Throwable t) {
                    report(Transport.unwrap(t));
                }
            });
            return true;
        } catch (RejectedExecutionException e) {
            return false;
        }
    }

    private void boot() {
        if (snapshotFile != null) loadSnapshot();
        if (state.ready()) started.complete(this);
        schedulePrune();
        attemptStart(0);
    }

    // Drops the retained members whose window has passed; with retention off, every one.
    private void pruneRetained() {
        State s = state;
        if (s.retained().isEmpty()) return;
        Instant now = clock.instant();
        List<MemberKey> expired = new ArrayList<>();
        s.retained().forEach((k, r) -> {
            if (!withinWindow(r, now)) expired.add(k);
        });
        if (expired.isEmpty()) return;
        state = s.withoutRetained(expired);
        markDirty();
    }

    private void schedulePrune() {
        if (retainWindow == null || closed) return;
        long every = Math.max(1, Math.min(retainWindow.toMillis(), RETAIN_PRUNE_MAX_MS));
        try {
            transport.schedule(() -> submit(() -> {
                pruneRetained();
                schedulePrune();
            }), every);
        } catch (RuntimeException rejected) {
            // The client is closed; nothing is pruned any more.
        }
    }

    private void attemptStart(int attempt) {
        if (closed) return;
        try {
            String position;
            if (resumeFromSnapshot) {
                position = state.position();
                State next = state;
                for (String groupId : initialGroups) {
                    if (!next.groups().containsKey(groupId)) next = loadGroup(next, groupId);
                }
                state = next;
                reportInheritanceChange();
            } else {
                position = await(client.events().position(), loadTimeout);
                state = fullLoad(position);
                reloadAllMembers();
                changedEverything();
            }
            subscribe(position);
            resumeFromSnapshot = false;
            started.complete(this);
            markDirty();
        } catch (Throwable t) {
            Throwable cause = Transport.unwrap(t);
            if (closed) return;
            if (resumeFromSnapshot && cause instanceof JunjoException je && je.status() == 410) {
                Safe.log(logger, JunjoLogger.Level.WARN,
                        "saved mirror position expired; reloading everything from the server", null);
                resumeFromSnapshot = false;
                attemptStart(attempt);
                return;
            }
            report(cause);
            retryLater(() -> attemptStart(attempt + 1), attempt + 1);
        }
    }

    // Builds a complete state at a position: every held and configured group, the ban and
    // sanction lists, and the tracked members carried over (reloaded by the caller). Resolved ids
    // are dropped, because links may have changed in a gap; they resolve again on demand. Retained
    // members are dropped for the same reason.
    private State fullLoad(String position) throws Exception {
        State old = state;
        State next = State.EMPTY.withPosition(position).withContexts(old.contexts());
        Set<String> groups = new LinkedHashSet<>(initialGroups);
        groups.addAll(old.groups().keySet());
        for (String groupId : groups) next = loadGroup(next, groupId);
        next = next.withBans(drainPages(c -> client.bans().list(new ListBansOptions(PAGE_SIZE, c, false))))
                .withSanctions(SanctionState.of(
                        drainPages(c -> client.sanctions().list(new ListSanctionsOptions(null, PAGE_SIZE, c)))));
        for (Map.Entry<MemberKey, MemberEntry> e : old.members().entrySet()) {
            next = next.withMember(e.getKey(), e.getValue());
        }
        return next.markReady();
    }

    private void subscribe(String position) throws Exception {
        streamOptions
                .types(EVENT_TYPES)
                .from(position)
                .onResync(newPosition -> submit(() -> resync(newPosition)))
                .onReconnecting(info -> streamState = StreamState.RECONNECTING)
                .onReconnected(p -> streamState = StreamState.CONNECTED)
                .onError(this::streamFailed);
        GameSubscription sub = await(
                client.events().subscribe((event, pos) -> submit(() -> apply(event, pos)), streamOptions.build()),
                loadTimeout);
        if (closed) {
            sub.close();
            return;
        }
        subscription = sub;
        live = true;
        streamState = StreamState.CONNECTED;
    }

    private void apply(JunjoEvent event, String position) {
        if (!state.ready()) return;
        lastEventAt = clock.instant();
        switch (event) {
            case JunjoEvent.RoleCreated e -> reloadGroupIfHeld(e.groupId());
            case JunjoEvent.RoleUpdated e -> reloadGroupIfHeld(e.groupId());
            case JunjoEvent.RoleDeleted e -> reloadGroupIfHeld(e.groupId());
            case JunjoEvent.PermissionGranted e -> reloadGroupIfHeld(e.groupId());
            case JunjoEvent.PermissionRevoked e -> reloadGroupIfHeld(e.groupId());
            case JunjoEvent.GroupUpdated e -> reloadGroupIfHeld(e.groupId());
            case JunjoEvent.GroupDeleted e -> {
                state = state.withoutGroup(e.groupId());
                changed(MirrorChange.Kind.ROLE_GRAPH, null, e.groupId());
            }
            case JunjoEvent.MemberScoped e -> applyMember(e);
            case JunjoEvent.GameUserBanned e -> applyBan(e.userId(), e.moderationVersion(), new Ban(
                    null, e.meta().gameId(), e.userId(), e.meta().occurredAt(), e.expiresAt(), e.reason(), null, null,
                    e.moderationVersion()));
            case JunjoEvent.GameUserUnbanned e -> applyBan(e.userId(), e.moderationVersion(), null);
            case JunjoEvent.GameUserSanctioned e ->
                    applySanction(e.userId(), e.sanctionType(), e.moderationVersion(), e);
            case JunjoEvent.GameUserUnsanctioned e ->
                    applySanction(e.userId(), e.sanctionType(), e.moderationVersion(), null);
            case JunjoEvent.IdentityUpdated e -> {
                Set<String> ids = new LinkedHashSet<>(idsWith(state, e.userId()));
                ids.addAll(idsWith(state, e.changedUserId()));
                reloadMembersOf(ids);
            }
            case JunjoEvent.IdentityLinked e -> relink(e.userId(), e.identities(), e.linkedUserId(), null);
            case JunjoEvent.IdentityUnlinked e ->
                    relink(e.userId(), e.identities(), e.unlinkedUserId(), e.unlinkedUserId());
            case JunjoEvent.PermissionsConfigUpdated e -> applyConfig(e);
            default -> {
                // Types outside the filter carry nothing the mirror holds.
            }
        }
        state = state.withPosition(position);
        markDirty();
    }

    // The event carries the new config: its inheritance applies at once. Graphs loaded in another
    // mode are reloaded, because their answers depend on the mode.
    private void applyConfig(JunjoEvent.PermissionsConfigUpdated e) {
        state = withServerContexts(state, e.contexts());
        reportInheritanceChange();
        List<String> stale = new ArrayList<>();
        for (Map.Entry<String, GroupState> g : state.groups().entrySet()) {
            if (g.getValue().graph().mode() != e.mode()) stale.add(g.getKey());
        }
        for (String groupId : stale) reloadGroupIfHeld(groupId);
    }

    private void applyMember(JunjoEvent.MemberScoped e) {
        MemberKey key = findMemberKey(state, e.userId(), e.groupId());
        if (key == null) {
            dropOutdatedRetained(e);
            return;
        }
        MemberEntry m = state.members().get(key);
        if (m.loaded() && e.memberVersion() > 0 && m.version() >= e.memberVersion()) {
            skipped.incrementAndGet();
            return;
        }
        reloadMember(key, 0);
    }

    // A retained member is never reloaded. An event that may be newer than its retained access
    // (a higher version, or none) drops it instead, so it cannot answer with an outdated access.
    private void dropOutdatedRetained(JunjoEvent.MemberScoped e) {
        State s = state;
        if (s.retained().isEmpty()) return;
        List<MemberKey> stale = new ArrayList<>();
        for (MemberKey k : personKeys(s, e.userId(), e.groupId())) {
            RetainedMember r = s.retained().get(k);
            if (r != null && (e.memberVersion() <= 0 || r.version() < e.memberVersion())) stale.add(k);
        }
        if (stale.isEmpty()) return;
        state = s.withoutRetained(stale);
    }

    // Drops every retained entry, in any group, kept under one of these ids.
    private void dropRetainedOf(Collection<String> ids) {
        State s = state;
        if (s.retained().isEmpty()) return;
        List<MemberKey> keys = new ArrayList<>();
        for (MemberKey k : s.retained().keySet()) if (ids.contains(k.userId())) keys.add(k);
        state = s.withoutRetained(keys);
    }

    private void applyBan(String userId, long version, Ban ban) {
        Long known = state.moderationVersions().get(userId);
        if (version > 0 && known != null && known >= version) {
            skipped.incrementAndGet();
            return;
        }
        state = state.withBan(userId, ban, version).withRendered(userId);
        changed(MirrorChange.Kind.BAN, userId, null);
    }

    private void applySanction(String userId, String type, long version, JunjoEvent.GameUserSanctioned e) {
        SanctionState current = state.sanctions();
        Long known = current.versions().get(userId);
        if (version > 0 && known != null && known >= version) {
            skipped.incrementAndGet();
            return;
        }
        Sanction next = null;
        if (e != null) {
            // A replacement keeps what the event does not carry: id, start and issuers.
            Sanction prior = current.byUser().getOrDefault(userId, Map.of()).get(type);
            next = new Sanction(
                    prior == null ? null : prior.id(),
                    userId,
                    type,
                    e.reason(),
                    prior == null ? null : prior.issuer(),
                    prior == null ? null : prior.issuedBy(),
                    prior == null ? e.meta().occurredAt() : prior.startedAt(),
                    e.expiresAt(),
                    version);
        }
        state = state.withSanctions(current.with(userId, type, next, version)).withRendered(userId);
        changed(MirrorChange.Kind.SANCTION, userId, null);
    }

    // A link or unlink changes which person an id names. The person's ids are recorded from the
    // event, and every cached answer keyed by one of them is reloaded: its ban, its sanctions and
    // every tracked membership. Retained members of every id involved, before or after the
    // change, are dropped.
    private void relink(String rendered, List<String> identities, String changedId, String splitOff) {
        Set<String> ids = new LinkedHashSet<>(identities);
        ids.add(rendered);
        if (splitOff == null) ids.add(changedId);
        else ids.remove(splitOff);
        State before = state;
        State s = before.withPerson(new Person(List.copyOf(ids), rendered));
        if (splitOff != null) s = s.withPerson(new Person(List.of(splitOff), splitOff));
        state = s;
        Set<String> affected = new LinkedHashSet<>(ids);
        affected.add(changedId);
        Set<String> involved = new HashSet<>();
        for (String id : affected) involved.addAll(idsWith(before, id));
        dropRetainedOf(involved);
        for (String id : affected) {
            reloadBan(id, 0);
            reloadSanctions(id, 0);
        }
        reloadMembersOf(affected);
    }

    private void resync(String newPosition) {
        Safe.log(logger, JunjoLogger.Level.WARN, "stream position expired; reloading the mirror at " + newPosition,
                null);
        try {
            state = fullLoad(newPosition);
            reloadAllMembers();
        } catch (Throwable t) {
            report(Transport.unwrap(t));
            retryLater(() -> resync(newPosition), 1);
            return;
        }
        streamState = StreamState.CONNECTED;
        changedEverything();
        markDirty();
        Safe.accept(logger, "onResync", onResync, newPosition);
    }

    private void streamFailed(Throwable err) {
        live = false;
        streamState = StreamState.STOPPED;
        report(err);
    }

    // ------------------------------------------------------------------ loads (applier thread)

    // The person an id belongs to, loading their ids when unknown. An id the game has never seen
    // is a person of its own, rendered as itself.
    private Person ensurePerson(String userId) throws Exception {
        Person p = state.people().get(userId);
        if (p != null) return p;
        List<LinkedIdentity> list = await(client.identities().list(userId), memberLoadTimeout).value();
        List<String> ids = new ArrayList<>();
        for (LinkedIdentity li : list) ids.add(li.userId());
        if (!ids.contains(userId)) ids.add(0, userId);
        State s = state;
        String rendered = list.isEmpty() ? userId : null;
        for (String id : ids) {
            if (rendered == null && s.renderedIds().contains(id)) rendered = id;
        }
        p = new Person(List.copyOf(ids), rendered);
        state = s.withPerson(p);
        markDirty();
        return p;
    }

    private void reloadGroupIfHeld(String groupId) {
        if (state.groups().containsKey(groupId)) reloadGroup(groupId, 0);
    }

    private void reloadGroup(String groupId, int attempt) {
        try {
            state = loadGroup(state, groupId);
            reportInheritanceChange();
            changed(MirrorChange.Kind.ROLE_GRAPH, null, groupId);
            markDirty();
        } catch (Throwable t) {
            report(Transport.unwrap(t));
            retryLater(() -> reloadGroup(groupId, attempt + 1), attempt + 1);
        }
    }

    // Every graph carries the game's inheritance, so the newest load sets the server's.
    private State loadGroup(State s, String groupId) throws Exception {
        try {
            RoleGraph graph = await(client.roles().getGraph(groupId), loadTimeout).value();
            State next = withServerContexts(s, graph.contexts());
            return next.withGroup(groupId, compileGroup(graph, next.contexts()));
        } catch (JunjoException e) {
            if ("not_found".equals(e.code())) {
                Safe.log(logger, JunjoLogger.Level.WARN,
                        "group " + groupId + " not found; dropping it from the mirror", null);
                return s.withoutGroup(groupId);
            }
            throw e;
        }
    }

    private void reloadAllMembers() {
        for (MemberKey key : new ArrayList<>(state.members().keySet())) reloadMember(key, 0);
    }

    // Coalesces the first loads of tracked members: every track queued within the window, per
    // group, goes out as one access batch of up to the server's cap.
    private void queueTrackLoad(MemberKey key) {
        pendingTracks.computeIfAbsent(key.groupId(), g -> new LinkedHashSet<>()).add(key);
        if (trackFlushScheduled) return;
        trackFlushScheduled = true;
        try {
            transport.schedule(() -> submit(this::flushTrackLoads), TRACK_BATCH_WINDOW_MS);
        } catch (RuntimeException rejected) {
            trackFlushScheduled = false;
        }
    }

    private void flushTrackLoads() {
        trackFlushScheduled = false;
        Map<String, Set<MemberKey>> batch = new HashMap<>(pendingTracks);
        pendingTracks.clear();
        for (Map.Entry<String, Set<MemberKey>> e : batch.entrySet()) {
            List<MemberKey> keys = new ArrayList<>(e.getValue());
            for (int i = 0; i < keys.size(); i += MembersApi.ACCESS_BATCH_MAX) {
                loadMembers(e.getKey(), keys.subList(i, Math.min(keys.size(), i + MembersApi.ACCESS_BATCH_MAX)));
            }
        }
    }

    // Results are matched to keys by position: each access names the rendered id, which may
    // differ from the id that was asked for.
    private void loadMembers(String groupId, List<MemberKey> requested) {
        List<MemberKey> keys = new ArrayList<>();
        for (MemberKey k : requested) if (state.members().containsKey(k)) keys.add(k);
        if (keys.isEmpty()) return;
        List<String> ids = new ArrayList<>();
        for (MemberKey k : keys) ids.add(k.userId());
        List<MemberEntry> entries = new ArrayList<>();
        try {
            try {
                for (Optional<MemberAccess> a : await(client.members().getAccessMany(groupId, ids), memberLoadTimeout)
                        .value()) {
                    entries.add(a.map(x -> new MemberEntry(true, x, x.version()))
                            .orElse(new MemberEntry(true, null, 0)));
                }
            } catch (JunjoException e) {
                // An unknown group has no members: every id reads as a non-member, as a single read would.
                if (!"not_found".equals(e.code())) throw e;
                for (int i = 0; i < keys.size(); i++) entries.add(new MemberEntry(true, null, 0));
            }
        } catch (Throwable t) {
            Throwable cause = Transport.unwrap(t);
            report(cause);
            for (MemberKey k : keys) {
                settleWaitersAfterFailure(k, cause);
                retryLater(() -> reloadMember(k, 1), 1);
            }
            return;
        }
        for (int i = 0; i < keys.size(); i++) applyLoaded(keys.get(i), entries.get(i));
    }

    private void reloadMember(MemberKey key, int attempt) {
        if (!state.members().containsKey(key)) return;
        MemberEntry entry;
        try {
            try {
                MemberAccess access =
                        await(client.members().getAccess(key.groupId(), key.userId()), memberLoadTimeout).value();
                entry = new MemberEntry(true, access, access.version());
            } catch (JunjoException e) {
                if (!"not_found".equals(e.code())) throw e;
                entry = new MemberEntry(true, null, 0);
            }
        } catch (Throwable t) {
            Throwable cause = Transport.unwrap(t);
            report(cause);
            settleWaitersAfterFailure(key, cause);
            retryLater(() -> reloadMember(key, attempt + 1), attempt + 1);
            return;
        }
        applyLoaded(key, entry);
    }

    // Publishes a loaded member, reports what changed, then completes its track
    // waiters, so a caller resuming from track() has already seen the change.
    private void applyLoaded(MemberKey key, MemberEntry entry) {
        MemberEntry old = state.members().get(key);
        if (old == null) return;
        State s = state.withMember(key, entry);
        if (entry.access() != null) {
            String rendered = entry.access().userId();
            if (!rendered.equals(key.userId())) s = s.withPersonMerged(key.userId(), rendered);
            s = s.withRendered(rendered);
        }
        // A tracked person needs no retained entry; the merge above may have shown one is theirs.
        state = s.withoutRetained(personKeys(s, key.userId(), key.groupId()));
        MemberAccess before = old.access();
        MemberAccess after = entry.access();
        if (!Objects.equals(withoutName(before), withoutName(after))) {
            changed(MirrorChange.Kind.ACCESS, key.userId(), key.groupId());
        }
        if (old.loaded() && !Objects.equals(nameOf(before), nameOf(after))) {
            changed(MirrorChange.Kind.DISPLAY_NAME, key.userId(), key.groupId());
        }
        markDirty();
        List<CompletableFuture<Void>> waiters = trackWaiters.remove(key);
        if (waiters != null) for (CompletableFuture<Void> w : waiters) w.complete(null);
    }

    private static String nameOf(MemberAccess a) {
        return a == null ? null : a.displayName();
    }

    private static MemberAccess withoutName(MemberAccess a) {
        return a == null ? null : new MemberAccess(
                a.groupId(), a.userId(), a.status(), a.roleIds(), a.overrides(), a.version(), null, a.metadata());
    }

    private void reloadMembersOf(Set<String> ids) {
        for (MemberKey key : new ArrayList<>(state.members().keySet())) {
            if (ids.contains(key.userId())) reloadMember(key, 0);
        }
    }

    private void failWaiters(MemberKey key, Throwable cause) {
        List<CompletableFuture<Void>> waiters = trackWaiters.remove(key);
        if (waiters != null) for (CompletableFuture<Void> w : waiters) w.completeExceptionally(cause);
    }

    // After a failed load: a member that still answers (restored from retention) completes its
    // track waiters; one with nothing loaded fails them.
    private void settleWaitersAfterFailure(MemberKey key, Throwable cause) {
        MemberEntry m = state.members().get(key);
        if (m == null || !m.loaded()) {
            failWaiters(key, cause);
            return;
        }
        List<CompletableFuture<Void>> waiters = trackWaiters.remove(key);
        if (waiters != null) for (CompletableFuture<Void> w : waiters) w.complete(null);
    }

    private void reloadBan(String userId, int attempt) {
        try {
            Optional<Ban> ban = await(client.bans().get(userId), loadTimeout);
            State s = state;
            Map<String, Ban> bans = new HashMap<>(s.bans());
            Map<String, Long> versions = new HashMap<>(s.moderationVersions());
            for (String id : idsWith(s, userId)) {
                bans.remove(id);
                versions.remove(id);
            }
            s = s.withBanMaps(bans, versions);
            if (ban.isPresent()) {
                Ban b = ban.get();
                s = s.withBan(b.userId(), b, b.version()).withRendered(b.userId());
            }
            state = s;
            changed(MirrorChange.Kind.BAN, userId, null);
            markDirty();
        } catch (Throwable t) {
            report(Transport.unwrap(t));
            retryLater(() -> reloadBan(userId, attempt + 1), attempt + 1);
        }
    }

    private void reloadSanctions(String userId, int attempt) {
        try {
            JunjoResponse<List<Sanction>> r = await(client.sanctions().forUser(userId), loadTimeout);
            long version = parseEtag(r.etag());
            State s = state;
            SanctionState next = s.sanctions();
            for (String id : idsWith(s, userId)) next = next.replaceUser(id, List.of(), 0);
            String owner = r.value().isEmpty() ? userId : r.value().get(0).userId();
            state = s.withSanctions(next.replaceUser(owner, r.value(), version));
            changed(MirrorChange.Kind.SANCTION, userId, null);
            markDirty();
        } catch (Throwable t) {
            report(Transport.unwrap(t));
            retryLater(() -> reloadSanctions(userId, attempt + 1), attempt + 1);
        }
    }

    static long parseEtag(String etag) {
        if (etag == null) return 0;
        String v = etag.startsWith("W/") ? etag.substring(2) : etag;
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) v = v.substring(1, v.length() - 1);
        try {
            return Long.parseLong(v);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    // Reads every page of a cursor-paged list. A repeated cursor would loop forever, so it fails
    // the load instead.
    private <T> List<T> drainPages(Function<String, CompletableFuture<JunjoResponse<Page<T>>>> fetch)
            throws Exception {
        List<T> all = new ArrayList<>();
        Set<String> seenCursors = new HashSet<>();
        String cursor = null;
        do {
            Page<T> page = await(fetch.apply(cursor), loadTimeout).value();
            all.addAll(page.items());
            cursor = page.nextCursor();
            if (cursor != null && !seenCursors.add(cursor)) {
                throw new JunjoException(JunjoException.INVALID_WIRE_DATA, "a list repeated a cursor", null);
            }
        } while (cursor != null);
        return all;
    }

    private void retryLater(Runnable task, int attempt) {
        if (closed) return;
        long delay = Math.max(retryBase.toMillis(), Backoff.fullJitterMillis(attempt, retryBase, retryMax));
        try {
            transport.schedule(() -> submit(task), delay);
        } catch (RuntimeException rejected) {
            // The client is closed; nothing can be reloaded any more.
        }
    }

    private static <T> T await(CompletableFuture<T> f, Duration timeout) throws Exception {
        try {
            return f.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (ExecutionException e) {
            Throwable cause = Transport.unwrap(e);
            if (cause instanceof Exception ex) throw ex;
            throw e;
        } catch (TimeoutException e) {
            f.cancel(true);
            throw new JunjoException(JunjoException.TIMEOUT, "mirror load timed out", e);
        }
    }

    private void report(Throwable err) {
        if (closed) return;
        Safe.log(logger, JunjoLogger.Level.WARN, "mirror: " + err.getMessage(), err);
        Safe.accept(logger, "onError", onError, err);
    }

    private void changed(MirrorChange.Kind kind, String userId, String groupId) {
        Safe.accept(logger, "onChange", onChange, new MirrorChange(kind, userId, groupId));
    }

    private void changedEverything() {
        inheritanceChanged = false;
        changed(MirrorChange.Kind.BAN, null, null);
        changed(MirrorChange.Kind.SANCTION, null, null);
        changed(MirrorChange.Kind.ROLE_GRAPH, null, null);
    }

    private static JunjoException mirrorClosed() {
        return new JunjoException(JunjoException.CANCELLED, CLOSED_MESSAGE, null);
    }

    // ------------------------------------------------------------------ snapshot file

    private void loadSnapshot() {
        try {
            Optional<State> loaded = MirrorSnapshot.load(snapshotFile, this::compileGroup);
            if (loaded.isEmpty()) return;
            state = loaded.get();
            pruneRetained();
            resumeFromSnapshot = true;
            Safe.log(logger, JunjoLogger.Level.INFO, "mirror loaded its snapshot at position " + state.position()
                    + "; answers may be stale until the stream catches up", null);
        } catch (IOException | RuntimeException e) {
            Safe.log(logger, JunjoLogger.Level.WARN, "mirror snapshot is unreadable and was ignored", e);
            report(e);
        }
    }

    // Saves are coalesced: a change schedules one save after the snapshot interval.
    private void markDirty() {
        if (snapshotFile == null) return;
        snapshotDirty = true;
        if (snapshotSaveScheduled || closed) return;
        snapshotSaveScheduled = true;
        try {
            transport.schedule(() -> submit(() -> {
                snapshotSaveScheduled = false;
                if (snapshotDirty) saveSnapshot();
            }), snapshotInterval.toMillis());
        } catch (RuntimeException rejected) {
            snapshotSaveScheduled = false;
        }
    }

    private void saveSnapshot() {
        State s = state;
        if (!s.ready()) return;
        try {
            MirrorSnapshot.save(snapshotFile, s, disk);
            snapshotDirty = false;
        } catch (IOException | RuntimeException e) {
            Safe.log(logger, JunjoLogger.Level.ERROR, "mirror snapshot save failed; the previous file is kept", e);
            report(e);
        }
    }

    // ------------------------------------------------------------------ state

    record MemberKey(String groupId, String userId) {}

    record MemberEntry(boolean loaded, MemberAccess access, long version) {
        static final MemberEntry PENDING = new MemberEntry(false, null, 0);
    }

    record GroupState(RoleGraph graph, GroupResolver resolver) {}

    /**
     * One person as far as the mirror knows them.
     *
     * @param ids every known id of the person, earliest-linked first
     * @param rendered the id the server renders for them, or null when not seen yet
     */
    record Person(List<String> ids, String rendered) {
        String key() {
            return rendered != null ? rendered : ids.get(0);
        }
    }

    /**
     * A member kept after untrack, for {@link Builder#retainUntracked(Duration)}.
     *
     * @param access the last loaded access, or null when the user had no membership
     * @param lastConnectedAt when the member was last tracked
     */
    record RetainedMember(MemberAccess access, Instant lastConnectedAt) {
        long version() {
            return access == null ? 0 : access.version();
        }
    }

    // An immutable snapshot. Every "with" returns a copy; the maps are never mutated after
    // construction, which is what makes lock-free reads safe.
    record State(
            boolean ready,
            String position,
            Map<String, GroupState> groups,
            Map<String, Ban> bans,
            Map<String, Long> moderationVersions,
            SanctionState sanctions,
            Map<MemberKey, MemberEntry> members,
            Map<String, Person> people,
            Set<String> renderedIds,
            Map<MemberKey, RetainedMember> retained,
            ContextInheritance contexts) {
        static final State EMPTY = new State(false, null, Map.of(), Map.of(), Map.of(), SanctionState.EMPTY, Map.of(),
                Map.of(), Set.of(), Map.of(), ContextInheritance.NONE);

        // The server's context inheritance.
        State withContexts(ContextInheritance c) {
            return new State(ready, position, groups, bans, moderationVersions, sanctions, members, people, renderedIds,
                    retained, c);
        }

        State markReady() {
            return new State(true, position, groups, bans, moderationVersions, sanctions, members, people, renderedIds,
                    retained, contexts);
        }

        State withPosition(String p) {
            return new State(ready, p, groups, bans, moderationVersions, sanctions, members, people, renderedIds,
                    retained, contexts);
        }

        State withGroup(String id, GroupState g) {
            Map<String, GroupState> m = new HashMap<>(groups);
            m.put(id, g);
            return new State(ready, position, Map.copyOf(m), bans, moderationVersions, sanctions, members, people,
                    renderedIds, retained, contexts);
        }

        State withoutGroup(String id) {
            Map<String, GroupState> m = new HashMap<>(groups);
            m.remove(id);
            Map<MemberKey, MemberEntry> mem = new HashMap<>(members);
            mem.keySet().removeIf(k -> k.groupId().equals(id));
            Map<MemberKey, RetainedMember> ret = new HashMap<>(retained);
            ret.keySet().removeIf(k -> k.groupId().equals(id));
            return new State(ready, position, Map.copyOf(m), bans, moderationVersions, sanctions, Map.copyOf(mem),
                    people, renderedIds, Map.copyOf(ret), contexts);
        }

        State withMember(MemberKey key, MemberEntry e) {
            Map<MemberKey, MemberEntry> m = new HashMap<>(members);
            m.put(key, e);
            return new State(ready, position, groups, bans, moderationVersions, sanctions, Map.copyOf(m), people,
                    renderedIds, retained, contexts);
        }

        State withoutMember(MemberKey key) {
            Map<MemberKey, MemberEntry> m = new HashMap<>(members);
            m.remove(key);
            return new State(ready, position, groups, bans, moderationVersions, sanctions, Map.copyOf(m), people,
                    renderedIds, retained, contexts);
        }

        State withRetained(MemberKey key, RetainedMember r) {
            Map<MemberKey, RetainedMember> m = new HashMap<>(retained);
            m.put(key, r);
            return new State(ready, position, groups, bans, moderationVersions, sanctions, members, people,
                    renderedIds, Map.copyOf(m), contexts);
        }

        // Drops the retained entries under any of these keys; returns this state when none is held.
        State withoutRetained(Collection<MemberKey> keys) {
            if (retained.isEmpty()) return this;
            Map<MemberKey, RetainedMember> m = new HashMap<>(retained);
            if (!m.keySet().removeAll(keys)) return this;
            return new State(ready, position, groups, bans, moderationVersions, sanctions, members, people,
                    renderedIds, Map.copyOf(m), contexts);
        }

        State withBans(Collection<Ban> list) {
            Map<String, Ban> b = new HashMap<>();
            Map<String, Long> v = new HashMap<>();
            Set<String> r = new HashSet<>(renderedIds);
            for (Ban ban : list) {
                b.put(ban.userId(), ban);
                r.add(ban.userId());
                if (ban.version() > 0) v.put(ban.userId(), ban.version());
            }
            return new State(ready, position, groups, Map.copyOf(b), Map.copyOf(v), sanctions, members, people,
                    Set.copyOf(r), retained, contexts);
        }

        State withBan(String userId, Ban ban, long version) {
            Map<String, Ban> b = new HashMap<>(bans);
            Map<String, Long> v = new HashMap<>(moderationVersions);
            if (ban == null) b.remove(userId);
            else b.put(userId, ban);
            if (version > 0) v.put(userId, version);
            return new State(ready, position, groups, Map.copyOf(b), Map.copyOf(v), sanctions, members, people,
                    renderedIds, retained, contexts);
        }

        State withBanMaps(Map<String, Ban> b, Map<String, Long> v) {
            return new State(ready, position, groups, Map.copyOf(b), Map.copyOf(v), sanctions, members, people,
                    renderedIds, retained, contexts);
        }

        State withSanctions(SanctionState next) {
            Set<String> r = new HashSet<>(renderedIds);
            r.addAll(next.byUser().keySet());
            return new State(ready, position, groups, bans, moderationVersions, next, members, people, Set.copyOf(r),
                    retained, contexts);
        }

        // Records the person under every id they hold, replacing what each id named before.
        State withPerson(Person p) {
            Map<String, Person> m = new HashMap<>(people);
            for (String id : p.ids()) m.put(id, p);
            Set<String> r = renderedIds;
            if (p.rendered() != null && !renderedIds.contains(p.rendered())) {
                Set<String> copy = new HashSet<>(renderedIds);
                copy.add(p.rendered());
                r = Set.copyOf(copy);
            }
            return new State(ready, position, groups, bans, moderationVersions, sanctions, members, Map.copyOf(m), r,
                    retained, contexts);
        }

        // Two ids name the same person, and the server renders that person as {@code rendered}.
        State withPersonMerged(String id, String rendered) {
            Set<String> ids = new LinkedHashSet<>();
            Person a = people.get(id);
            Person b = people.get(rendered);
            if (a != null) ids.addAll(a.ids());
            if (b != null) ids.addAll(b.ids());
            ids.add(id);
            ids.add(rendered);
            return withPerson(new Person(List.copyOf(ids), rendered));
        }

        // An id seen where the server renders ids; the person it belongs to learns its key.
        State withRendered(String id) {
            State s = this;
            if (!renderedIds.contains(id)) {
                Set<String> r = new HashSet<>(renderedIds);
                r.add(id);
                s = new State(ready, position, groups, bans, moderationVersions, sanctions, members, people,
                        Set.copyOf(r), retained, contexts);
            }
            Person p = s.people().get(id);
            if (p != null && !id.equals(p.rendered())) s = s.withPerson(new Person(p.ids(), id));
            return s;
        }
    }

    // Active sanctions by person and type, plus the moderation version each person's sanctions are
    // known at. Kept apart from the ban versions: the ban and sanction snapshots are read at
    // different moments, so a version learned from one says nothing about the other.
    record SanctionState(Map<String, Map<String, Sanction>> byUser, Map<String, Long> versions) {
        static final SanctionState EMPTY = new SanctionState(Map.of(), Map.of());

        static SanctionState of(Collection<Sanction> list) {
            Map<String, Map<String, Sanction>> by = new HashMap<>();
            Map<String, Long> v = new HashMap<>();
            for (Sanction x : list) {
                by.computeIfAbsent(x.userId(), k -> new HashMap<>()).put(x.type(), x);
                if (x.version() > 0) v.merge(x.userId(), x.version(), Math::max);
            }
            return new SanctionState(freeze(by), Map.copyOf(v));
        }

        SanctionState with(String userId, String type, Sanction sanction, long version) {
            Map<String, Map<String, Sanction>> by = new HashMap<>(byUser);
            Map<String, Sanction> types = new HashMap<>(by.getOrDefault(userId, Map.of()));
            if (sanction == null) types.remove(type);
            else types.put(type, sanction);
            if (types.isEmpty()) by.remove(userId);
            else by.put(userId, Map.copyOf(types));
            Map<String, Long> v = new HashMap<>(versions);
            if (version > 0) v.put(userId, version);
            return new SanctionState(Map.copyOf(by), Map.copyOf(v));
        }

        SanctionState replaceUser(String userId, Collection<Sanction> list, long version) {
            Map<String, Map<String, Sanction>> by = new HashMap<>(byUser);
            Map<String, Long> v = new HashMap<>(versions);
            by.remove(userId);
            v.remove(userId);
            Map<String, Sanction> types = new HashMap<>();
            for (Sanction x : list) types.put(x.type(), x);
            if (!types.isEmpty()) by.put(userId, Map.copyOf(types));
            if (version > 0) v.put(userId, version);
            return new SanctionState(Map.copyOf(by), Map.copyOf(v));
        }

        private static Map<String, Map<String, Sanction>> freeze(Map<String, Map<String, Sanction>> by) {
            Map<String, Map<String, Sanction>> out = new HashMap<>();
            by.forEach((k, v) -> out.put(k, Map.copyOf(v)));
            return Map.copyOf(out);
        }
    }

    // ------------------------------------------------------------------ builder

    /** Builds a {@link GameMirror}. */
    public static final class Builder {
        private final JunjoClient client;
        private final Set<String> groups = new LinkedHashSet<>();
        private Clock clock = Clock.systemUTC();
        private Duration loadTimeout = Duration.ofSeconds(60);
        private Duration memberLoadTimeout = Duration.ofSeconds(5);
        private Duration retryBase = Duration.ofSeconds(1);
        private Duration retryMax = Duration.ofSeconds(30);
        private Consumer<Throwable> onError;
        private Consumer<String> onResync;
        private Consumer<MirrorChange> onChange;
        private SubscribeOptions.Builder streamOptions = SubscribeOptions.builder();
        private boolean defaultRoleForNonMembers;
        private Path snapshotFile;
        private Duration snapshotInterval = Duration.ofSeconds(30);
        private DurableFiles.Disk disk = DurableFiles.Disk.SYSTEM;
        private ContextInheritance inheritance;
        private Duration retainWindow;

        private Builder(JunjoClient client) {
            this.client = Objects.requireNonNull(client, "client");
        }

        /** Groups whose role graphs are loaded at start and kept current. */
        public Builder groups(Collection<String> groupIds) {
            groups.addAll(groupIds);
            return this;
        }

        /** A group whose role graph is loaded at start and kept current. */
        public Builder group(String groupId) {
            groups.add(Objects.requireNonNull(groupId, "groupId"));
            return this;
        }

        /** The clock ban and sanction expiry is judged against. Default system UTC. */
        public Builder clock(Clock c) {
            this.clock = Objects.requireNonNull(c, "clock");
            return this;
        }

        /** The most one bulk load (a graph, a list, the stream's first connection) may take. Default 60 s. */
        public Builder loadTimeout(Duration timeout) {
            this.loadTimeout = Objects.requireNonNull(timeout, "timeout");
            return this;
        }

        /**
         * The most one member or identity load may take, so a stuck call cannot hold up the
         * applier for long. Default 5 s.
         */
        public Builder memberLoadTimeout(Duration timeout) {
            this.memberLoadTimeout = Objects.requireNonNull(timeout, "timeout");
            return this;
        }

        /** Full-jitter retry bounds for failed loads. Defaults 1 s and 30 s. */
        public Builder retryBackoff(Duration base, Duration max) {
            this.retryBase = Objects.requireNonNull(base, "base");
            this.retryMax = Objects.requireNonNull(max, "max");
            return this;
        }

        /** Receives load failures (each retried) and a fatal stream failure, on the applier thread. */
        public Builder onError(Consumer<Throwable> callback) {
            this.onError = callback;
            return this;
        }

        /**
         * Called on the applier thread after a full reload caused by an expired position, with the
         * new position.
         */
        public Builder onResync(Consumer<String> callback) {
            this.onResync = callback;
            return this;
        }

        /**
         * Called on the applier thread after each change is readable. It must not block: nothing
         * else is applied while it runs. A throwing listener is logged and ignored. A full load
         * reports one change per kind with null ids.
         */
        public Builder onChange(Consumer<MirrorChange> listener) {
            this.onChange = listener;
            return this;
        }

        /**
         * Stream settings (backoff, idle timeout, frame cap). The type filter, start position and
         * every callback are owned by the mirror and overwritten.
         */
        public Builder streamOptions(SubscribeOptions.Builder options) {
            this.streamOptions = Objects.requireNonNull(options, "options");
            return this;
        }

        /**
         * With true, a user with no membership row in a group is checked against the group's
         * default role. Off by default, because the server's {@code permissions().check} answers
         * {@code none} for such a user; with this on, the mirror and the server disagree for
         * non-members.
         */
        public Builder defaultRoleForNonMembers(boolean enabled) {
            this.defaultRoleForNonMembers = enabled;
            return this;
        }

        /**
         * Persists the state to this file and loads it at start. Saves are atomic (temporary file,
         * force, atomic move, directory force) and checksummed; an unreadable file is ignored and
         * reported. Loaded data may be stale until the stream catches up.
         */
        public Builder snapshotFile(Path file) {
            this.snapshotFile = Objects.requireNonNull(file, "file");
            return this;
        }

        /**
         * An explicit context inheritance that checks resolve with instead of the server's. Only
         * needed with a server whose role graphs do not carry the game's inheritance; pass the
         * same table the game's config holds, since with a different one contextual checks can
         * answer differently from {@code permissions().check}. By default, and with null, the
         * mirror follows the server's inheritance.
         */
        public Builder contextInheritance(ContextInheritance inheritance) {
            this.inheritance = inheritance;
            return this;
        }

        /**
         * Keeps an untracked member's last loaded access for this window after they were last
         * tracked, in memory and in the snapshot file, so a member tracked again within it is
         * answered at once, even while the server is unreachable. Each retained member records
         * when it was last tracked; the window is measured from then by the mirror's clock, and
         * expired entries are pruned at start and periodically. A retained member is not tracked:
         * reads answer UNKNOWN for it until it is tracked again, and stream events never reload
         * it. It is dropped when a member event shows a newer version of the membership, when an
         * identity event names one of the person's ids, when its group is deleted, and on a full
         * reload from the server.
         * Zero turns retention off, which is the default.
         *
         * @throws IllegalArgumentException when the window is negative
         */
        public Builder retainUntracked(Duration window) {
            Objects.requireNonNull(window, "window");
            if (window.isNegative()) throw new IllegalArgumentException("window must not be negative");
            this.retainWindow = window.isZero() ? null : window;
            return this;
        }

        /** The longest a change waits before it is saved to the snapshot file. Default 30 s. */
        public Builder snapshotInterval(Duration interval) {
            this.snapshotInterval = Objects.requireNonNull(interval, "interval");
            return this;
        }

        // A seam for tests that need a force to fail.
        Builder disk(DurableFiles.Disk d) {
            this.disk = Objects.requireNonNull(d, "disk");
            return this;
        }

        /** The mirror, not started. */
        public GameMirror build() {
            return new GameMirror(this);
        }
    }
}
