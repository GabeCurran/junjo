package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import io.junjo.sdk.model.DisplayNameMatch;
import io.junjo.sdk.model.LinkedIdentity;
import io.junjo.sdk.model.Member;
import io.junjo.sdk.model.MemberAccess;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

@Timeout(30)
class DisplayNamesTest {
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
    void namesAreSetLookedUpAndDecoded() throws Exception {
        server.on("PUT", "/v1/users/ns%3Au/display-name", (req, ex) -> FakeServer.json(ex, 200, """
                {"userId":"ns:u","namespace":"ns","linkedAt":"2026-11-01T00:00:00Z","displayName":null}"""));
        server.on("GET", "/v1/identities/by-name", (req, ex) -> FakeServer.json(ex, 200, """
                {"items":[{"userId":"ns:u","displayName":"Steve","displayNameUpdatedAt":"2026-11-09T12:00:00Z"}]}"""));
        server.on("GET", "/v1/groups/g/members/ns%3Au", (req, ex) -> FakeServer.json(ex, 200, """
                {"id":"m","groupId":"g","userId":"ns:u","status":"active","roles":[],"metadata":{},
                 "notesPublic":null,"notesPrivate":null,"joinedAt":"2026-11-01T00:00:00Z","bannedUntil":null,
                 "version":1,"displayName":"Steve"}"""));
        server.on("GET", "/v1/groups/g/members/ns%3Au/access", (req, ex) -> FakeServer.json(ex, 200, """
                {"groupId":"g","userId":"ns:u","status":"active","roleIds":[],"overrides":[],"version":1,
                 "displayName":"Steve"}"""));

        LinkedIdentity cleared = join(client.identities().setDisplayName("ns:u", null));
        assertNull(cleared.displayName());
        assertEquals("{\"displayName\":null}", server.requests.get(0).body(), "null clears the name");

        List<DisplayNameMatch> found = join(client.identities().findByName("Steve O", "ns"));
        assertEquals("name=Steve%20O&namespace=ns", server.requests.get(1).query());
        assertEquals("ns:u", found.get(0).userId());

        Member m = join(client.members().get("g", "ns:u")).orElseThrow();
        assertEquals("Steve", m.displayName());
        MemberAccess a = join(client.members().getAccess("g", "ns:u")).value();
        assertEquals("Steve", a.displayName());
    }
}
