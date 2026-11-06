package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.events.GameSubscription;
import io.junjo.sdk.events.JunjoEvent;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.mirror.Answer;
import io.junjo.sdk.mirror.GameMirror;
import io.junjo.sdk.model.CreateBanInput;
import io.junjo.sdk.model.CreateGroupInput;
import io.junjo.sdk.model.CreateRoleInput;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.Role;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Runs against a real server when {@code JUNJO_IT_BASE_URL} and {@code JUNJO_IT_API_KEY} are set;
 * skipped otherwise. It creates a uniquely named group and test-only ids in the key's game.
 */
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_API_KEY", matches = ".+")
@Timeout(120)
class LiveIntegrationTest {
    @Test
    void endToEnd() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String user = LiveSupport.user();
        try (JunjoClient c = LiveSupport.client()) {
            String start = join(c.events().position());
            assertNotNull(start);

            LinkedBlockingQueue<JunjoEvent> seen = new LinkedBlockingQueue<>();
            GameSubscription sub = join(c.events().subscribe((e, p) -> seen.add(e),
                    SubscribeOptions.builder().from(start).build()));

            Group group = join(c.groups().create(CreateGroupInput.builder("it", "java-it-" + suffix).build()));
            Role role = join(c.roles().create(group.id(), CreateRoleInput.builder("Member", 10).build()));
            join(c.roles().setEntries(role.id(), List.of(PermissionEntry.grant("it.read"),
                    PermissionEntry.deny("it.write"))));
            join(c.members().add(group.id(), user, role.id(), null, WriteOptions.none()));

            try (GameMirror mirror = GameMirror.builder(c).group(group.id()).build()) {
                join(mirror.start());
                join(mirror.track(user, group.id()));
                for (String perm : List.of("it.read", "it.write", "it.other")) {
                    PermissionCheckResult server = join(c.permissions().check(user, group.id(), perm));
                    Optional<PermissionCheckResult> local = mirror.check(user, group.id(), perm);
                    assertEquals(server.allowed(), local.orElseThrow().allowed(), perm);
                    assertEquals(server.source(), local.orElseThrow().source(), perm);
                }

                join(c.bans().add(CreateBanInput.builder(user).reason("java it").build()));
                await(() -> mirror.isBanned(user) == Answer.YES, "mirror sees the ban");
                join(c.bans().remove(user));
                await(() -> mirror.isBanned(user) == Answer.NO, "mirror sees the unban");
            }

            JunjoEvent first = seen.poll(30, TimeUnit.SECONDS);
            assertNotNull(first, "the stream delivered events");
            assertTrue(Long.parseLong(sub.position()) > Long.parseLong(start));
            sub.close();
        }
    }
}
