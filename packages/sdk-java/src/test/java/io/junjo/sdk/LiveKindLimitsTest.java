package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;

import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.ImportMember;
import io.junjo.sdk.model.MemberImport;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/** Needs {@code JUNJO_IT_ADMIN_TOKEN} as well: it changes the game's {@code groups.kinds} config and restores it. */
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_API_KEY", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_ADMIN_TOKEN", matches = ".+")
@Timeout(90)
class LiveKindLimitsTest {
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
    void limitsRefuseWithGroupFullAndGroupLimitReached() throws Exception {
        String gameId = LiveSupport.gameId(client);
        String kind = "itk-" + LiveSupport.unique();
        LiveSupport.admin("PATCH", "/v1/admin/games/" + gameId + "/config",
                "{\"config\":{\"groups\":{\"kinds\":{\"" + kind + "\":{\"maxMembers\":2,\"maxPerUser\":1}}}}}");
        try {
            Group a = LiveSupport.group(client, kind);
            Group b = LiveSupport.group(client, kind);
            String u1 = LiveSupport.user();
            String u2 = LiveSupport.user();
            join(client.members().add(a.id(), u1));
            join(client.members().add(a.id(), u2));
            join(client.members().add(a.id(), u1));

            JunjoException full = failure(client.members().add(a.id(), LiveSupport.user()));
            assertEquals("group_full", full.code());
            assertEquals(409, full.status());

            assertEquals("group_limit_reached", failure(client.members().add(b.id(), u1)).code());

            JunjoException importFull = failure(client.members().importMembers(a.id(), MemberImport.builder()
                    .add(ImportMember.builder(LiveSupport.user()).build()).build()));
            assertEquals("group_full", importFull.code());
            assertEquals(0, importFull.importRowErrors().get(0).index());
            assertEquals("group_full", importFull.importRowErrors().get(0).code());
        } finally {
            LiveSupport.admin("PATCH", "/v1/admin/games/" + gameId + "/config",
                    "{\"config\":{\"groups\":{\"kinds\":{}}}}");
        }
    }
}
