package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.model.CreateRoleInput;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.Member;
import io.junjo.sdk.model.MemberStatus;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.queue.QueuedWrite;
import io.junjo.sdk.queue.WriteQueue;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Create-only member adds against a real server. Runs only when {@code JUNJO_IT_BASE_URL} and
 * {@code JUNJO_IT_API_KEY} are set.
 */
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_API_KEY", matches = ".+")
@Timeout(90)
class LiveCreateOnlyAddTest {
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

    Role role(Group g, String name, long priority) throws Exception {
        return join(client.roles().create(g.id(), CreateRoleInput.builder(name, priority).build()));
    }

    @Test
    void createOnlyAddNeverTouchesAnExistingMembership() throws Exception {
        Group g = LiveSupport.group(client, "it");
        Role base = role(g, "Base", 0);
        Role mod = role(g, "Mod", 50);
        WriteOptions createOnly = WriteOptions.idempotent().withIfNoneMatchAny();

        String fresh = LiveSupport.user();
        Member added = join(client.members().add(g.id(), fresh, base.id(), null, createOnly));
        assertEquals(MemberStatus.ACTIVE, added.status());
        assertEquals(List.of(base.id()), added.roles());
        assertEquals(1, added.version());

        // A member who holds another role keeps exactly that role.
        String promoted = LiveSupport.user();
        join(client.members().add(g.id(), promoted, mod.id(), null, WriteOptions.none()));
        JunjoException refused = failure(client.members().add(g.id(), promoted, base.id(), null,
                WriteOptions.idempotent().withIfNoneMatchAny()));
        assertEquals("precondition_failed", refused.code());
        assertEquals(412, refused.status());
        assertEquals("active", refused.details().orElseThrow().get("memberStatus"));
        Member after = join(client.members().get(g.id(), promoted)).orElseThrow();
        assertEquals(List.of(mod.id()), after.roles());
        assertEquals(1, after.version());

        // A kicked member is not reactivated.
        join(client.groups().kick(g.id(), fresh));
        JunjoException kicked = failure(client.members().add(g.id(), fresh, null, null,
                WriteOptions.none().withIfNoneMatchAny()));
        assertEquals("kicked", kicked.details().orElseThrow().get("memberStatus"));
        assertEquals(MemberStatus.KICKED, join(client.members().get(g.id(), fresh)).orElseThrow().status());

        // The same call without the option keeps the default behaviour.
        Member merged = join(client.members().add(g.id(), promoted, base.id(), null, WriteOptions.none()));
        assertTrue(merged.roles().containsAll(List.of(mod.id(), base.id())));
    }

    @Test
    void queuedCreateOnlyAddReportsAnExistingMemberAsAConflict() throws Exception {
        Group g = LiveSupport.group(client, "it");
        Role base = role(g, "Base", 0);
        Role mod = role(g, "Mod", 50);
        String existing = LiveSupport.user();
        String fresh = LiveSupport.user();
        join(client.members().add(g.id(), existing, mod.id(), null, WriteOptions.none()));

        List<WriteQueue.Outcome> ok = new CopyOnWriteArrayList<>();
        List<WriteQueue.Outcome> conflicts = new CopyOnWriteArrayList<>();
        List<WriteQueue.Outcome> rejected = new CopyOnWriteArrayList<>();
        try (WriteQueue q = WriteQueue.builder(client, dir.resolve("adds.jsonl"))
                .onSuccess(ok::add).onConflict(conflicts::add).onRejected(rejected::add).open()) {
            q.enqueue(QueuedWrite.addMemberIfAbsent(g.id(), existing, base.id(), null));
            q.enqueue(QueuedWrite.addMemberIfAbsent(g.id(), fresh, base.id(), null));
            assertTrue(q.flush(Duration.ofSeconds(30)));
        }
        assertEquals(1, ok.size());
        assertEquals(201, ok.get(0).status());
        assertEquals(1, conflicts.size());
        assertEquals("precondition_failed", conflicts.get(0).error().code());
        assertTrue(rejected.isEmpty());
        assertEquals(List.of(mod.id()), join(client.members().get(g.id(), existing)).orElseThrow().roles());
        assertEquals(List.of(base.id()), join(client.members().get(g.id(), fresh)).orElseThrow().roles());
    }
}
