package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.mirror.Answer;
import io.junjo.sdk.mirror.GameMirror;
import io.junjo.sdk.mirror.MirrorChange;
import io.junjo.sdk.model.CreateBanInput;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.LinkCode;
import io.junjo.sdk.model.MemberAccess;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

@EnabledIfEnvironmentVariable(named = "JUNJO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_API_KEY", matches = ".+")
@Timeout(90)
class LiveMirrorTest {
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
    void aBanUnderOneLinkedIdAnswersForTheOther() throws Exception {
        String first = LiveSupport.user();
        String second = LiveSupport.user();
        List<Throwable> errors = new CopyOnWriteArrayList<>();
        try (GameMirror mirror = GameMirror.builder(client).onError(errors::add).build()) {
            join(mirror.start());
            // Resolved before the link, so the mirror has to learn of the link afterwards.
            assertEquals(second, join(mirror.resolve(second)));
            assertEquals(Answer.NO, mirror.isBanned(second));

            LinkCode code = join(client.identities().requestLinkCode(first));
            join(client.identities().redeemLinkCode(code.code(), second));
            await(() -> Set.of(first, second).contains(join0(mirror.resolve(first)))
                    && join0(mirror.resolve(second)).equals(join0(mirror.resolve(first))), "the link event");

            join(client.bans().add(CreateBanInput.builder(first).reason("linked").build()));
            await(() -> mirror.isBanned(second) == Answer.YES, "the ban answers for the linked id");
            assertEquals(Answer.YES, mirror.isBanned(first));
            assertEquals("linked", mirror.ban(second).orElseThrow().reason());
        }
        assertTrue(errors.isEmpty(), errors.toString());
    }

    @Test
    void theChangeListenerSeesARealBan() throws Exception {
        String u = LiveSupport.user();
        List<MirrorChange> changes = new CopyOnWriteArrayList<>();
        try (GameMirror mirror = GameMirror.builder(client).onChange(changes::add).build()) {
            join(mirror.start());
            join(client.bans().add(CreateBanInput.builder(u).reason("listener").build()));
            await(() -> changes.contains(new MirrorChange(MirrorChange.Kind.BAN, u, null)), "the ban change");
            assertEquals(Answer.YES, mirror.isBanned(u), "the change is readable when the listener runs");
            join(client.bans().remove(u));
            await(() -> mirror.isBanned(u) == Answer.NO, "the lift");
            long banChanges = changes.stream()
                    .filter(c -> c.kind() == MirrorChange.Kind.BAN && u.equals(c.userId()))
                    .count();
            assertTrue(banChanges >= 2);
        }
    }

    @Test
    void anAccessBatchMixesMembersNonMembersAndALinkedAlt() throws Exception {
        Group g = LiveSupport.group(client, "it");
        String m1 = LiveSupport.user();
        String m2 = LiveSupport.user();
        String outsider = LiveSupport.user();
        String alt = LiveSupport.user();
        join(client.members().add(g.id(), m1));
        join(client.members().add(g.id(), m2));
        LinkCode code = join(client.identities().requestLinkCode(m1));
        join(client.identities().redeemLinkCode(code.code(), alt));

        JunjoResponse<List<Optional<MemberAccess>>> r =
                join(client.members().getAccessMany(g.id(), List.of(m1, outsider, alt, m2)));
        assertNotNull(r.streamPosition());
        List<Optional<MemberAccess>> items = r.value();
        assertEquals(4, items.size());
        assertTrue(items.get(0).isPresent());
        assertTrue(items.get(1).isEmpty(), "a non-member reads as empty");
        assertEquals(items.get(0).orElseThrow().userId(), items.get(2).orElseThrow().userId(),
                "the alt finds the same person, named by the rendered id");
        assertEquals(m2, items.get(3).orElseThrow().userId());

        try (GameMirror mirror = GameMirror.builder(client).group(g.id()).build()) {
            join(mirror.start());
            join(CompletableFuture.allOf(mirror.track(alt, g.id()), mirror.track(outsider, g.id()),
                    mirror.track(m2, g.id())));
            assertTrue(mirror.access(alt, g.id()).isPresent());
            assertTrue(mirror.access(m1, g.id()).isPresent(), "the batch result linked the alt to the person");
            assertTrue(mirror.access(outsider, g.id()).isEmpty());
            assertEquals(Answer.YES, mirror.isLoaded(outsider, g.id()));
        }
    }

    private static String join0(CompletableFuture<String> f) {
        try {
            return join(f);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
