package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import io.junjo.sdk.export.ExportRecord;
import io.junjo.sdk.export.ExportSummary;
import io.junjo.sdk.model.AddSanctionInput;
import io.junjo.sdk.model.Group;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/** Needs {@code JUNJO_IT_ADMIN_TOKEN} as well: it mints, then revokes, a key with {@code canExport}. */
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_API_KEY", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_ADMIN_TOKEN", matches = ".+")
@Timeout(90)
class LiveExportTest {
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
    void streamsTheGameWithAKeyThatCanExport() throws Exception {
        assertEquals("permission_denied", failure(client.export().read(r -> { })).code());

        Group g = LiveSupport.group(client, "party");
        String u = LiveSupport.user();
        String name = "Exp" + LiveSupport.unique();
        join(client.members().add(g.id(), u));
        join(client.identities().setDisplayName(u, name));
        join(client.sanctions().add(AddSanctionInput.builder(u, "mute").build()));

        String gameId = LiveSupport.gameId(client);
        JsonObject minted = LiveSupport.admin("POST", "/v1/admin/games/" + gameId + "/api-keys",
                "{\"name\":\"java-it-export-" + LiveSupport.unique() + "\",\"canExport\":true}");
        String keyId = minted.get("id").getAsString();
        try (JunjoClient exporter = LiveSupport.client(minted.get("key").getAsString())) {
            List<ExportRecord> records = new CopyOnWriteArrayList<>();
            ExportSummary summary = join(exporter.export().read(records::add));
            assertEquals(gameId, summary.gameId());
            assertNotNull(summary.position());
            assertEquals("header", records.get(0).kind());
            assertEquals("end", records.get(records.size() - 1).kind());
            assertTrue(records.stream().anyMatch(r -> r.kind().equals("group") && g.id().equals(r.get("id"))
                    && "party".equals(r.get("groupKind"))));
            assertTrue(records.stream().anyMatch(r -> r.kind().equals("sanction") && u.equals(r.get("userId"))));
            assertTrue(records.stream().anyMatch(r -> r.kind().equals("person") && r.json().contains(name)));
            long members = records.stream().filter(r -> r.kind().equals("member")).count();
            assertEquals(members, summary.counts().getOrDefault("member", 0L));
            assertFalse(records.stream().anyMatch(r -> r.json().contains(minted.get("key").getAsString())),
                    "keys are never exported");
        } finally {
            LiveSupport.admin("POST", "/v1/admin/games/" + gameId + "/api-keys/" + keyId + "/revoke", null);
        }
    }
}
