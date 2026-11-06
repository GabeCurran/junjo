package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.events.EventType;
import io.junjo.sdk.events.GameSubscription;
import io.junjo.sdk.events.JunjoEvent;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.internal.Call;
import io.junjo.sdk.internal.HttpResult;
import io.junjo.sdk.internal.Paths;
import io.junjo.sdk.mirror.Answer;
import io.junjo.sdk.mirror.GameMirror;
import io.junjo.sdk.model.Ban;
import io.junjo.sdk.model.CreateBanInput;
import io.junjo.sdk.model.CreateRoleInput;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.ImportMember;
import io.junjo.sdk.model.ImportResult;
import io.junjo.sdk.model.Member;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.MemberImport;
import io.junjo.sdk.model.SetMemberNotesInput;
import io.junjo.sdk.model.Moderation;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.queue.QueuedWrite;
import io.junjo.sdk.queue.WriteQueue;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Safe-writes scenarios against a real server. Runs only when {@code JUNJO_IT_BASE_URL} and
 * {@code JUNJO_IT_API_KEY} are set; every test creates its own uniquely named groups and ids.
 */
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_API_KEY", matches = ".+")
@Timeout(90)
class LiveSafeWritesTest {
    @TempDir
    Path dir;

    JunjoClient client;

    @BeforeEach
    void setUp() {
        client = LiveSupport.client();
    }

    @AfterEach
    void tearDown() {
        client.close();
    }

    static String user() {
        return LiveSupport.user();
    }

    Group group() throws Exception {
        return LiveSupport.group(client, "it");
    }

    Role role(Group g, String name, long priority, PermissionEntry... entries) throws Exception {
        Role r = join(client.roles().create(g.id(), CreateRoleInput.builder(name, priority).build()));
        if (entries.length > 0) r = join(client.roles().setEntries(r.id(), List.of(entries)));
        return r;
    }

    @Test
    void idempotencyKeyReplaysTheStoredResultAndRefusesADifferentBody() throws Exception {
        Group g = group();
        String u = user();
        String key = "it-" + UUID.randomUUID();
        String path = "/v1/groups/" + Paths.seg(g.id()) + "/members";
        String body = "{\"userId\":\"" + u + "\"}";

        HttpResult first = join(TestSupport.transport(client).send(Call.write("POST", path, body,
                WriteOptions.idempotent(key))));
        HttpResult second = join(TestSupport.transport(client).send(Call.write("POST", path, body,
                WriteOptions.idempotent(key))));
        assertEquals(201, first.status());
        assertTrue(first.headers().firstValue("Idempotent-Replayed").isEmpty());
        assertEquals(first.status(), second.status());
        assertEquals("true", second.headers().firstValue("Idempotent-Replayed").orElse(null));
        assertEquals(first.bodyString(), second.bodyString());

        Member viaSdk = join(client.members().add(g.id(), u, null, null, WriteOptions.idempotent(key)));
        assertEquals(1, viaSdk.version(), "the replay returns the stored member, not a new write");

        JunjoException reused = failure(client.members().add(g.id(), user(), null, null, WriteOptions.idempotent(key)));
        assertEquals(422, reused.status());
        assertEquals("idempotency_key_reused", reused.code());
    }

    @Test
    void ifMatchRefusesAStaleMemberVersionAndBumpsOnSuccess() throws Exception {
        Group g = group();
        Role r = role(g, "Helper", 5);
        String u = user();
        Member m = join(client.members().add(g.id(), u));
        long v = m.version();
        assertTrue(v >= 1);

        Member updated = join(client.members().setNotes(g.id(), u,
                SetMemberNotesInput.builder().notesPublic("one").build(), WriteOptions.none().withIfMatch(v)));
        assertEquals(v + 1, updated.version());

        JunjoException stale = failure(client.members().setNotes(g.id(), u,
                SetMemberNotesInput.builder().notesPublic("two").build(), WriteOptions.none().withIfMatch(v)));
        assertEquals(412, stale.status());
        assertEquals("precondition_failed", stale.code());
        assertEquals("one", join(client.members().get(g.id(), u)).orElseThrow().notesPublic(), "nothing was written");

        JunjoException staleAssign = failure(client.members().assignRole(g.id(), u, r.id(), null,
                WriteOptions.none().withIfMatch(v)));
        assertEquals("precondition_failed", staleAssign.code());

        Member assigned = join(client.members().assignRole(g.id(), u, r.id(), null,
                WriteOptions.idempotent().withIfMatch(updated.version())));
        assertEquals(updated.version() + 1, assigned.version());
        assertTrue(assigned.roles().contains(r.id()));

        JunjoResponse<MemberAccess> access = join(client.members().getAccess(g.id(), u));
        assertEquals(assigned.version(), access.value().version());
        assertEquals(WriteOptions.etag(assigned.version()), access.etag());
    }

    @Test
    void writeQueueAppliesConflictsAndTreatsInactiveLiftsAsSuccessWithoutReplayingTwice() throws Exception {
        Group g = group();
        Role r = role(g, "Vip", 10);
        String u = user();
        long v1 = join(client.members().add(g.id(), u)).version();
        String neverBanned = user();

        Path journal = dir.resolve("queue.jsonl");
        List<WriteQueue.Outcome> ok = new CopyOnWriteArrayList<>();
        List<WriteQueue.Outcome> conflicts = new CopyOnWriteArrayList<>();
        List<WriteQueue.Outcome> rejected = new CopyOnWriteArrayList<>();
        WriteQueue.Builder builder = WriteQueue.builder(client, journal)
                .retryBackoff(Duration.ofMillis(100), Duration.ofSeconds(1))
                .onSuccess(ok::add)
                .onConflict(conflicts::add)
                .onRejected(rejected::add);

        List<String> puts;
        try (WriteQueue q = builder.open()) {
            q.enqueue(QueuedWrite.assignRole(g.id(), u, r.id(), null).ifMatch(v1));
            // Decided against version v1, but the assign above moves the member past it.
            q.enqueue(QueuedWrite.overridePermission(g.id(), u, "it.fly", true).ifMatch(v1));
            q.enqueue(QueuedWrite.removeBan(neverBanned, null));
            assertTrue(q.flush(Duration.ofSeconds(30)));
            puts = Files.readAllLines(journal).stream().filter(l -> l.contains("\"op\":\"put\"")).toList();
        }
        assertEquals(List.of("assign role", "remove ban"),
                ok.stream().map(o -> o.entry().write().label()).toList());
        assertEquals(1, conflicts.size());
        assertEquals("override permission", conflicts.get(0).entry().write().label());
        assertEquals(412, conflicts.get(0).status());
        assertTrue(rejected.isEmpty(), rejected.toString());

        MemberAccess after = join(client.members().getAccess(g.id(), u)).value();
        assertEquals(List.of(r.id()), after.roleIds());
        assertTrue(after.overrides().isEmpty(), "the stale override was not written");
        assertEquals(v1 + 1, after.version());

        // Reopening the finished journal sends nothing.
        ok.clear();
        try (WriteQueue q = builder.open()) {
            assertEquals(0, q.size());
            assertTrue(q.flush(Duration.ofSeconds(2)));
        }
        assertTrue(ok.isEmpty());

        // A crash before the done records reached disk leaves every entry pending. Replaying them
        // resends the same idempotency keys, so nothing applies twice.
        Path crashed = dir.resolve("crashed.jsonl");
        Files.write(crashed, puts);
        ok.clear();
        conflicts.clear();
        try (WriteQueue q = WriteQueue.builder(client, crashed)
                .onSuccess(ok::add).onConflict(conflicts::add).onRejected(rejected::add).open()) {
            assertTrue(q.flush(Duration.ofSeconds(30)));
        }
        assertEquals(2, ok.size());
        assertEquals(1, conflicts.size());
        assertTrue(rejected.isEmpty(), rejected.toString());
        assertEquals(v1 + 1, join(client.members().getAccess(g.id(), u)).value().version(), "no write applied twice");
    }

    @Test
    void bulkImportIsIdempotentAndReportsBadRowsByIndex() throws Exception {
        Group g = group();
        Role r = role(g, "Imported", 3, PermissionEntry.grant("it.read"));
        List<ImportMember> rows = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            rows.add(ImportMember.builder(user())
                    .roleIds(List.of(r.id()))
                    .overrides(i % 5 == 0 ? List.of(PermissionEntry.deny("it.read")) : List.of())
                    .metadata(Map.of("rank", i))
                    .build());
        }
        MemberImport request = MemberImport.builder().addAll(rows).build();

        ImportResult first = join(client.members().importMembers(g.id(), request));
        assertEquals(50, first.created());
        assertEquals(50, first.items().size());
        assertTrue(first.items().stream().allMatch(i -> i.version() >= 1));

        ImportResult again = join(client.members().importMembers(g.id(), request));
        assertEquals(50, again.unchanged());
        assertEquals(0, again.created() + again.updated() + again.reactivated());
        assertTrue(again.items().stream().allMatch(i -> i.status().equals("unchanged")));
        for (int i = 0; i < 50; i++) assertEquals(first.items().get(i).version(), again.items().get(i).version());

        List<ImportMember> withBad = new ArrayList<>(rows);
        withBad.set(17, ImportMember.builder(user()).roleIds(List.of("role-that-does-not-exist")).build());
        JunjoException e = failure(client.members().importMembers(g.id(),
                MemberImport.builder().addAll(withBad).build()));
        assertEquals("bad_request", e.code());
        List<JunjoException.ImportRowError> bad = e.importRowErrors();
        assertEquals(1, bad.size(), bad.toString());
        assertEquals(17, bad.get(0).index());
        assertEquals("not_found", bad.get(0).code());
    }

    @Test
    void queuedUnbanWithAnOldModerationVersionIsRefusedAfterAReBan() throws Exception {
        String u = user();
        Ban ban = join(client.bans().add(CreateBanInput.builder(u).reason("first").build(), WriteOptions.idempotent()));
        long old = ban.version();
        assertTrue(old >= 1);
        JunjoResponse<Moderation> mod = join(client.bans().moderation(u));
        assertEquals(old, mod.value().version());
        assertEquals(WriteOptions.etag(old), mod.etag());

        Ban reBan = join(client.bans().add(CreateBanInput.builder(u).reason("second").build()));
        assertTrue(reBan.version() > old, "a ban change bumps the moderation version");

        List<WriteQueue.Outcome> ok = new CopyOnWriteArrayList<>();
        List<WriteQueue.Outcome> conflicts = new CopyOnWriteArrayList<>();
        try (WriteQueue q = WriteQueue.builder(client, dir.resolve("mod.jsonl"))
                .onSuccess(ok::add).onConflict(conflicts::add).open()) {
            q.enqueue(QueuedWrite.removeBan(u, null).ifMatch(old));
            assertTrue(q.flush(Duration.ofSeconds(30)));
        }
        assertTrue(ok.isEmpty());
        assertEquals(1, conflicts.size());
        assertEquals("precondition_failed", conflicts.get(0).error().code());
        assertTrue(join(client.bans().get(u)).isPresent(), "the newer ban is still in force");

        join(client.bans().remove(u, null, WriteOptions.none().withIfMatch(reBan.version())));
        assertTrue(join(client.bans().get(u)).isEmpty());
        assertEquals(reBan.version() + 1, join(client.bans().moderation(u)).value().version());
    }

    @Test
    void mirrorSeesBansAndRoleChangesAndAgreesWithTheServer() throws Exception {
        Group g = group();
        Role member = role(g, "Member", 10, PermissionEntry.grant("it.read"), PermissionEntry.deny("it.write"));
        // Explicit keys as well as the wildcard, so the scenario holds in either permission mode.
        Role mod = role(g, "Mod", 50, PermissionEntry.grant("it.*"), PermissionEntry.grant("it.other"));
        String u = user();
        join(client.members().add(g.id(), u, member.id(), null, WriteOptions.none()));
        List<Throwable> errors = new CopyOnWriteArrayList<>();
        List<String> perms = List.of("it.read", "it.write", "it.other", "elsewhere");

        try (GameMirror mirror = GameMirror.builder(client).group(g.id()).onError(errors::add).build()) {
            join(mirror.start());
            String banned = user();
            join(mirror.resolve(banned));
            assertEquals(Answer.NO, mirror.isBanned(banned));
            join(client.bans().add(CreateBanInput.builder(banned).reason("mirror").build()));
            await(() -> mirror.isBanned(banned) == Answer.YES, "the mirror sees the ban");

            join(mirror.track(u, g.id()));
            assertMatchesServer(mirror, g, u, perms);
            assertEquals(Answer.NO, mirror.can(u, g.id(), "it.write"));

            join(client.members().assignRole(g.id(), u, mod.id()));
            await(() -> mirror.can(u, g.id(), "it.other") == Answer.YES, "the mirror sees the new role");
            assertMatchesServer(mirror, g, u, perms);

            join(client.members().overridePermission(g.id(), u, "it.read", false));
            await(() -> mirror.can(u, g.id(), "it.read") == Answer.NO, "the mirror sees the override");
            assertMatchesServer(mirror, g, u, perms);
        }
        assertTrue(errors.isEmpty(), errors.toString());
    }

    void assertMatchesServer(GameMirror mirror, Group g, String u, List<String> perms) throws Exception {
        for (String p : perms) {
            PermissionCheckResult server = join(client.permissions().check(u, g.id(), p));
            PermissionCheckResult local = mirror.check(u, g.id(), p).orElseThrow();
            assertEquals(server.allowed(), local.allowed(), p);
            assertEquals(server.source(), local.source(), p);
            assertEquals(server.viaRoleId(), local.viaRoleId(), p);
        }
    }

    @Test
    void resumingFromASavedPositionDeliversExactlyTheMissedEvents() throws Exception {
        Group g = group();
        List<String> seen = new CopyOnWriteArrayList<>();
        SubscribeOptions.Builder opts = SubscribeOptions.builder().types(EventType.MEMBER_JOINED);

        String start = join(client.events().position());
        GameSubscription first = join(client.events().subscribe((e, p) -> {
            if (e instanceof JunjoEvent.MemberJoined j && j.groupId().equals(g.id())) seen.add(j.userId());
        }, opts.from(start).build()));
        String before = user();
        join(client.members().add(g.id(), before));
        await(() -> seen.contains(before), "the first event");
        first.close();
        String saved = first.position();
        assertNotNull(saved);

        List<String> missed = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            String u = user();
            missed.add(u);
            join(client.members().add(g.id(), u));
        }

        List<String> resumed = new CopyOnWriteArrayList<>();
        List<Long> positions = new CopyOnWriteArrayList<>();
        GameSubscription second = join(client.events().subscribe((e, p) -> {
            if (e instanceof JunjoEvent.MemberJoined j && j.groupId().equals(g.id())) {
                resumed.add(j.userId());
                positions.add(Long.parseLong(p));
            }
        }, opts.from(saved).build()));
        try {
            await(() -> resumed.size() >= 3, "the missed events");
            // A later event is a barrier: once it arrives, every earlier one has been delivered.
            String marker = user();
            join(client.members().add(g.id(), marker));
            await(() -> resumed.contains(marker), "the marker event");
            assertEquals(marker, resumed.remove(resumed.size() - 1));
            positions.remove(positions.size() - 1);
            assertEquals(missed, resumed, "exactly the missed events, in order, no repeats");
            assertFalse(resumed.contains(before));
            assertTrue(positions.stream().allMatch(p -> p > Long.parseLong(saved)));
            assertEquals(positions, positions.stream().sorted().collect(Collectors.toList()));
        } finally {
            second.close();
        }
    }
}
