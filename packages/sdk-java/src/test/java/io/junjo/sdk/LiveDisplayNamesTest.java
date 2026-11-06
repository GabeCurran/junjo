package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.events.EventType;
import io.junjo.sdk.events.GameSubscription;
import io.junjo.sdk.events.JunjoEvent;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.mirror.GameMirror;
import io.junjo.sdk.model.DisplayNameMatch;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.LinkedIdentity;
import io.junjo.sdk.model.MemberAccess;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

@EnabledIfEnvironmentVariable(named = "JUNJO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_API_KEY", matches = ".+")
@Timeout(90)
class LiveDisplayNamesTest {
    JunjoClient client;

    @BeforeEach
    void setUp() {
        client = LiveSupport.client();
    }

    @AfterEach
    void tearDown() {
        client.close();
    }

    @Test
    void namesAreSetFoundAndReachTheStreamAndTheMirror() throws Exception {
        Group g = LiveSupport.group(client, "it");
        String u = LiveSupport.user();
        String name = "Java" + LiveSupport.unique();
        join(client.members().add(g.id(), u));
        List<JunjoEvent.IdentityUpdated> updates = new CopyOnWriteArrayList<>();
        String start = join(client.events().position());
        GameSubscription sub = join(client.events().subscribe((e, p) -> {
            if (e instanceof JunjoEvent.IdentityUpdated iu && iu.changedUserId().equals(u)) updates.add(iu);
        }, SubscribeOptions.builder().from(start).types(EventType.IDENTITY_UPDATED).build()));
        try (GameMirror mirror = GameMirror.builder(client).group(g.id()).build()) {
            join(mirror.start());
            join(mirror.track(u, g.id()));
            assertNull(mirror.access(u, g.id()).orElseThrow().displayName());

            LinkedIdentity set = join(client.identities().setDisplayName(u, name));
            assertEquals(name, set.displayName());
            await(() -> !updates.isEmpty(), "identity.updated");
            assertEquals(name, updates.get(0).displayName());
            assertEquals(List.of("displayName"), updates.get(0).changed());
            await(() -> name.equals(mirror.access(u, g.id()).map(MemberAccess::displayName).orElse(null)),
                    "the mirror reloads the member's name");

            List<DisplayNameMatch> found = join(client.identities().findByName(name.toLowerCase(Locale.ROOT), "it"));
            assertEquals(List.of(u), found.stream().map(DisplayNameMatch::userId).toList());
            assertTrue(join(client.identities().findByName(name, "other")).isEmpty());
            assertEquals(name, join(client.members().get(g.id(), u)).orElseThrow().displayName());
            assertEquals(name, join(client.identities().list(u)).value().get(0).displayName());

            int before = updates.size();
            join(client.identities().setDisplayName(u, name));
            join(client.identities().setDisplayName(u, null));
            await(() -> updates.size() == before + 1, "the clearing event");
            assertNull(updates.get(updates.size() - 1).displayName(), "an unchanged name emitted nothing");
            assertTrue(join(client.identities().findByName(name, null)).isEmpty());
        } finally {
            sub.close();
        }
    }
}
