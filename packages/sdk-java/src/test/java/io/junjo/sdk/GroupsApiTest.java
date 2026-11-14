package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.junjo.sdk.model.BanHistoryEntry;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.GroupRelationship;
import io.junjo.sdk.model.Invitation;
import io.junjo.sdk.model.ListInvitationsOptions;
import io.junjo.sdk.model.Page;
import io.junjo.sdk.model.PageOptions;
import io.junjo.sdk.model.UpdateGroupInput;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/** The request every group, membership, relationship and invitation call sends, and how it reads the answer. */
@Timeout(30)
class GroupsApiTest {
    static final String GROUP_V = ClientTest.GROUP_JSON.replace("\"softDeletedAt\":null", "\"softDeletedAt\":null,\"version\":\"12345678901234567\"");
    static final String INVITATION = """
            {"id":"i1","groupId":"g1","code":"ABC","roleId":"r1","targetUserId":null,"createdBy":null,
             "createdAt":"2026-11-01T00:00:00Z","expiresAt":null,"usedAt":null,"usedBy":null}""";
    static final String RELATIONSHIP = """
            {"groupAId":"g1","groupBId":"g2","type":"ally","since":"2026-11-01T00:00:00Z","setBy":"ns:mod"}""";

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

    FakeServer.Req last() {
        return server.requests.get(server.requests.size() - 1);
    }

    static JsonObject body(FakeServer.Req req) {
        return JsonParser.parseString(req.body()).getAsJsonObject();
    }

    @Test
    void groupVersionIsReadWhenPresentAndNullWhenAbsent() throws Exception {
        server.on("GET", "/v1/groups/g1", (req, ex) ->
                FakeServer.json(ex, 200, GROUP_V, Map.of("ETag", "\"12345678901234567\"")));
        server.on("GET", "/v1/groups", (req, ex) ->
                FakeServer.json(ex, 200, "{\"items\":[" + ClientTest.GROUP_JSON + "],\"nextCursor\":null}"));
        assertEquals("12345678901234567", join(client.groups().get("g1")).orElseThrow().version());
        assertNull(join(client.groups().list(null)).value().items().get(0).version(), "lists carry no version");
    }

    @Test
    void updateSendsOnlyTheSetFieldsWithTheActorAndIfMatch() throws Exception {
        server.on("PATCH", "/v1/groups/g1", (req, ex) -> FakeServer.json(ex, 200, GROUP_V));
        UpdateGroupInput input = UpdateGroupInput.builder().name("B").passcode(null).actorUserId("ns:mod").build();
        Group g = join(client.groups().update("g1", input, WriteOptions.none().withIfMatch("12345678901234567")));
        assertEquals("12345678901234567", g.version());
        FakeServer.Req req = last();
        assertEquals("12345678901234567", req.header("If-Match"));
        JsonObject b = body(req);
        assertEquals("B", b.get("name").getAsString());
        assertTrue(b.get("passcode").isJsonNull(), "an explicit null clears the passcode");
        assertEquals("ns:mod", b.get("actorUserId").getAsString());
        assertFalse(b.has("visibility"));
        assertEquals(3, b.size());
    }

    @Test
    void anUpdateNeedsAFieldBesidesTheActor() {
        assertThrows(IllegalStateException.class, () -> UpdateGroupInput.builder().build());
        assertThrows(IllegalStateException.class, () -> UpdateGroupInput.builder().actorUserId("ns:mod").build());
    }

    @Test
    void aStaleUpdateSurfacesTheCurrentVersion() throws Exception {
        server.on("PATCH", "/v1/groups/g1", (req, ex) -> FakeServer.json(ex, 412, """
                {"code":"precondition_failed","status":412,"message":"stale","details":{"version":"99"}}"""));
        JunjoException e = failure(client.groups().update("g1", UpdateGroupInput.builder().name("B").build(),
                WriteOptions.none().withIfMatch(98)));
        assertEquals("precondition_failed", e.code());
        assertEquals("99", e.details().orElseThrow().get("version"));
        assertEquals("\"98\"", last().header("If-Match"));
    }

    @Test
    void deleteSendsHardAndTheActorAsQueryParameters() throws Exception {
        server.onPrefix("DELETE", "/v1/groups/", (req, ex) -> {
            if (req.query() != null && req.query().contains("hard=true")) FakeServer.json(ex, 204, "");
            else FakeServer.json(ex, 200, GROUP_V);
        });
        join(client.groups().delete("g 1"));
        assertEquals("/v1/groups/g%201", last().pathAndQuery());
        assertNull(last().header("If-Match"));

        join(client.groups().delete("g1", true, "ns:mod", WriteOptions.none().withIfMatch("\"7\"")));
        assertEquals("/v1/groups/g1?hard=true&actorUserId=ns%3Amod", last().pathAndQuery());
        assertEquals("\"7\"", last().header("If-Match"));
        assertEquals("", last().body(), "a delete sends no body");

        join(client.groups().delete("g1", false, "ns:mod", WriteOptions.none()));
        assertEquals("/v1/groups/g1?actorUserId=ns%3Amod", last().pathAndQuery());
    }

    @Test
    void restoreAndParentAndChildren() throws Exception {
        server.on("POST", "/v1/groups/g1/restore", (req, ex) -> FakeServer.json(ex, 200, GROUP_V));
        server.on("PUT", "/v1/groups/g1/parent", (req, ex) -> FakeServer.json(ex, 200, ClientTest.GROUP_JSON));
        server.on("GET", "/v1/groups/g1/children", (req, ex) ->
                FakeServer.json(ex, 200, "[" + ClientTest.GROUP_JSON + "]"));
        assertEquals("12345678901234567", join(client.groups().restore("g1")).version());
        assertEquals("POST", last().method());

        join(client.groups().setParent("g1", null));
        assertTrue(body(last()).get("parentGroupId").isJsonNull(), "null clears the parent and is sent");
        join(client.groups().setParent("g1", "g0"));
        assertEquals("g0", body(last()).get("parentGroupId").getAsString());

        List<Group> children = join(client.groups().listChildren("g1"));
        assertEquals(1, children.size());
        assertEquals("g1", children.get(0).id());
    }

    @Test
    void invitationsAreCreatedAcceptedAndDeclined() throws Exception {
        server.on("POST", "/v1/groups/g1/invitations", (req, ex) -> FakeServer.json(ex, 201, INVITATION));
        server.on("POST", "/v1/invitations/A%2FB/accept", (req, ex) -> FakeServer.json(ex, 200, ClientTest.MEMBER_JSON));
        server.on("POST", "/v1/invitations/ABC/decline", (req, ex) -> FakeServer.json(ex, 204, ""));

        Invitation inv = join(client.groups().inviteByUserId("g1", "ns:u", "r1", WriteOptions.idempotent("k1")));
        assertEquals("ABC", inv.code());
        assertEquals("k1", last().header("Idempotency-Key"));
        JsonObject direct = body(last());
        assertEquals("ns:u", direct.get("targetUserId").getAsString());
        assertEquals("r1", direct.get("roleId").getAsString());
        assertEquals(2, direct.size());

        join(client.groups().inviteByUserId("g1", "ns:u"));
        assertEquals(1, body(last()).size(), "no role, no roleId field");

        join(client.groups().inviteByCode("g1", "r1", "7d", WriteOptions.none()));
        JsonObject open = body(last());
        assertFalse(open.has("targetUserId"), "an open invitation is addressed to nobody");
        assertEquals("7d", open.get("expiresIn").getAsString());
        join(client.groups().inviteByCode("g1"));
        assertEquals("{}", last().body());

        assertEquals("ns:u1", join(client.groups().acceptInvitation("A/B", "ns:u1")).userId());
        assertEquals("ns:u1", body(last()).get("userId").getAsString());

        join(client.groups().declineInvitation("ABC"));
        assertEquals("{}", last().body(), "decline always sends a JSON body");
        join(client.groups().declineInvitation("ABC", "ns:u", WriteOptions.none()));
        assertEquals("ns:u", body(last()).get("userId").getAsString());
    }

    @Test
    void joinAndLeave() throws Exception {
        server.on("POST", "/v1/groups/g1/join", (req, ex) -> FakeServer.json(ex, 200, ClientTest.MEMBER_JSON));
        server.on("POST", "/v1/groups/g1/leave", (req, ex) -> FakeServer.json(ex, 200, ClientTest.MEMBER_JSON));
        join(client.groups().join("g1", "ns:u"));
        assertEquals(1, body(last()).size());
        join(client.groups().join("g1", "ns:u", "1234", WriteOptions.none()));
        assertEquals("1234", body(last()).get("passcode").getAsString());
        join(client.groups().leave("g1", "ns:u"));
        assertEquals("ns:u", body(last()).get("userId").getAsString());
    }

    @Test
    void kickCarriesTheActorOnlyWhenGiven() throws Exception {
        server.on("POST", "/v1/groups/g1/members/u1/kick", (req, ex) -> FakeServer.json(ex, 200, ClientTest.MEMBER_JSON));
        join(client.groups().kick("g1", "u1", "afk", "ns:mod", WriteOptions.none().withIfMatch(7)));
        JsonObject b = body(last());
        assertEquals("afk", b.get("reason").getAsString());
        assertEquals("ns:mod", b.get("actorUserId").getAsString());
        assertEquals("\"7\"", last().header("If-Match"));
        join(client.groups().kick("g1", "u1", "afk", WriteOptions.none()));
        assertFalse(body(last()).has("actorUserId"));
        join(client.groups().kick("g1", "u1"));
        assertEquals("{}", last().body());
    }

    @Test
    void banHistoryPagesThroughTheGroupTimeline() throws Exception {
        server.on("GET", "/v1/groups/g1/bans/history", (req, ex) -> FakeServer.json(ex, 200, """
                {"items":[{"id":"h1","gameId":"gm","userId":"ns:u","scope":"group","groupId":"g1","kind":"set",
                 "reason":"grief","expiresAt":null,"eventAt":"2026-11-02T00:00:00Z","actorUserId":"ns:mod",
                 "issuer":null}],"nextCursor":"h1"}"""));
        Page<BanHistoryEntry> page = join(client.groups().banHistory("g1", null)).value();
        assertEquals("/v1/groups/g1/bans/history", last().pathAndQuery());
        BanHistoryEntry e = page.items().get(0);
        assertEquals("group", e.scope());
        assertEquals("g1", e.groupId());
        assertEquals("set", e.kind());
        assertEquals("ns:mod", e.actorUserId());
        assertNull(e.expiresAt());
        assertEquals("h1", page.nextCursor());

        join(client.groups().banHistory("g1", new PageOptions(10, null).withCursor("h1")));
        assertEquals("/v1/groups/g1/bans/history?limit=10&cursor=h1", last().pathAndQuery());
    }

    @Test
    void relationshipsAreSetClearedReadAndListed() throws Exception {
        server.on("PUT", "/v1/groups/g1/relationships/g2", (req, ex) -> FakeServer.json(ex, 200, RELATIONSHIP));
        server.on("DELETE", "/v1/groups/g1/relationships/g2", (req, ex) -> FakeServer.json(ex, 204, ""));
        server.on("GET", "/v1/groups/g1/relationships/g2", (req, ex) -> FakeServer.json(ex, 200, RELATIONSHIP));
        server.on("GET", "/v1/groups/g1/relationships", (req, ex) -> FakeServer.json(ex, 200, "[" + RELATIONSHIP + "]"));

        GroupRelationship rel = join(client.groups().setRelationship("g1", "g2", "ally", true, "ns:mod",
                WriteOptions.idempotent("k")));
        assertEquals("ns:mod", rel.setBy());
        JsonObject b = body(last());
        assertEquals("ally", b.get("type").getAsString());
        assertTrue(b.get("mutual").getAsBoolean());
        assertEquals("ns:mod", b.get("actorUserId").getAsString());
        join(client.groups().setRelationship("g1", "g2", "rival"));
        assertEquals("{\"type\":\"rival\"}", last().body());

        join(client.groups().clearRelationship("g1", "g2", true, "ns:mod", WriteOptions.none()));
        assertEquals("/v1/groups/g1/relationships/g2?mutual=true&actorUserId=ns%3Amod", last().pathAndQuery());
        join(client.groups().clearRelationship("g1", "g2"));
        assertEquals("/v1/groups/g1/relationships/g2", last().pathAndQuery());

        assertEquals("ally", join(client.groups().getRelationship("g1", "g2")).orElseThrow().type());
        assertEquals(Optional.empty(), join(client.groups().getRelationship("g1", "g3")), "404 reads as empty");

        List<GroupRelationship> all = join(client.groups().listRelationships("g1"));
        assertEquals(1, all.size());
        assertEquals("g2", all.get(0).groupBId());
    }

    @Test
    void invitationsApiListsLooksUpAndRevokes() throws Exception {
        server.on("GET", "/v1/groups/g1/invitations", (req, ex) ->
                FakeServer.json(ex, 200, "{\"items\":[" + INVITATION + "],\"nextCursor\":null}"));
        server.on("GET", "/v1/invitations/ABC", (req, ex) -> FakeServer.json(ex, 200, INVITATION));
        server.on("DELETE", "/v1/invitations/ABC", (req, ex) -> FakeServer.json(ex, 204, ""));

        assertEquals("ABC", join(client.invitations().list("g1", null)).value().items().get(0).code());
        assertEquals("/v1/groups/g1/invitations", last().pathAndQuery());
        join(client.invitations().list("g1", new ListInvitationsOptions(5, "c", true, true)));
        assertEquals("/v1/groups/g1/invitations?limit=5&cursor=c&includeExpired=true&includeUsed=true",
                last().pathAndQuery());

        assertEquals("r1", join(client.invitations().get("ABC")).orElseThrow().roleId());
        assertTrue(join(client.invitations().get("NOPE")).isEmpty());

        join(client.invitations().revoke("ABC"));
        assertEquals("DELETE", last().method());
        assertEquals("/v1/invitations/ABC", last().path());
    }
}
