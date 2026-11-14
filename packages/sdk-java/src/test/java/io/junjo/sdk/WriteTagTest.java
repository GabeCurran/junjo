package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/** {@code Junjo-Write-Tag}: validation, the client-level default and the per-write override. */
@Timeout(30)
class WriteTagTest {
    FakeServer server;

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeServer();
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, ClientTest.MEMBER_JSON));
        server.onPrefix("GET", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, ClientTest.GROUP_JSON));
    }

    @AfterEach
    void tearDown() {
        server.close();
    }

    JunjoClient client(String tag) {
        JunjoClient.Builder b = JunjoClient.builder().baseUrl(server.baseUrl()).apiKey("k")
                .requestTimeout(Duration.ofSeconds(5));
        if (tag != null) b.writeTag(tag);
        return b.build();
    }

    FakeServer.Req last() {
        return server.requests.get(server.requests.size() - 1);
    }

    @Test
    void writeOptionsValidateTheTagAndKeepItAcrossCopies() {
        String max = "t".repeat(WriteOptions.WRITE_TAG_MAX_LENGTH);
        assertEquals(max, WriteOptions.none().withWriteTag(max).writeTag());
        for (String bad : List.of("", "has space", "t".repeat(WriteOptions.WRITE_TAG_MAX_LENGTH + 1), "tab\t",
                "café", "del\u007f")) {
            assertThrows(IllegalArgumentException.class, () -> WriteOptions.none().withWriteTag(bad), bad);
        }
        WriteOptions opts = WriteOptions.none().withWriteTag("a").withIdempotencyKey("k").withIfMatch(2)
                .withIfNoneMatchAny().withTimeout(Duration.ofSeconds(1));
        assertEquals("a", opts.writeTag());
        assertNull(WriteOptions.none().writeTag());
        assertNull(new WriteOptions("k", null, null, null).writeTag());
        assertNull(WriteOptions.none().withWriteTag("a").withWriteTag(null).writeTag(), "null falls back to the client");
    }

    @Test
    void theBuilderRefusesAnInvalidTag() {
        JunjoClient.Builder b = JunjoClient.builder().baseUrl(server.baseUrl()).apiKey("k");
        assertThrows(IllegalArgumentException.class, () -> b.writeTag("two words"));
        assertThrows(IllegalArgumentException.class, () -> b.writeTag(""));
        assertThrows(IllegalArgumentException.class, () -> b.writeTag("x".repeat(129)));
        assertThrows(NullPointerException.class, () -> b.writeTag(null));
    }

    @Test
    void theClientTagGoesOnEveryRequestAndAWriteTagOverridesIt() throws Exception {
        try (JunjoClient client = client("shard-1")) {
            join(client.groups().kick("g1", "u1"));
            assertEquals("shard-1", last().header("Junjo-Write-Tag"));

            join(client.groups().get("g1"));
            assertEquals("shard-1", last().header("Junjo-Write-Tag"), "reads carry it too");

            join(client.groups().kick("g1", "u1", null, null, WriteOptions.none().withWriteTag("sync-job")));
            assertEquals("sync-job", last().header("Junjo-Write-Tag"));
            assertEquals(1, last().headers().entrySet().stream()
                    .filter(e -> e.getKey() != null && e.getKey().equalsIgnoreCase("Junjo-Write-Tag"))
                    .mapToInt(e -> e.getValue().size()).sum(), "the override replaces the default");
        }
    }

    @Test
    void withoutAClientTagOnlyTaggedWritesCarryOne() throws Exception {
        try (JunjoClient client = client(null)) {
            join(client.groups().kick("g1", "u1"));
            assertNull(last().header("Junjo-Write-Tag"));
            join(client.groups().kick("g1", "u1", null, null, WriteOptions.idempotent().withWriteTag("x")));
            assertEquals("x", last().header("Junjo-Write-Tag"));
        }
    }
}
