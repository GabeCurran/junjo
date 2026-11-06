package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.failure;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Duration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

@Timeout(30)
class KindLimitsTest {
    FakeServer server;
    JunjoClient client;

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeServer();
        client = TestSupport.client(server.baseUrl());
    }

    @AfterEach
    void tearDown() {
        client.close();
        server.close();
    }

    @Test
    void limitCodesPassThrough() throws Exception {
        server.on("POST", "/v1/groups/g/members", (req, ex) ->
                FakeServer.json(ex, 409, FakeServer.error("group_full", 409, "full")));
        server.on("POST", "/v1/groups/h/members", (req, ex) ->
                FakeServer.json(ex, 409, FakeServer.error("group_limit_reached", 409, "limit")));
        JunjoException full = failure(client.members().add("g", "u"));
        assertEquals("group_full", full.code());
        assertEquals(409, full.status());
        assertEquals("group_limit_reached", failure(client.members().add("h", "u")).code());
    }
}
