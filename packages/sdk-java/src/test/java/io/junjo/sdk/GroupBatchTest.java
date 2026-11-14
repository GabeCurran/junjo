package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.GroupBatchOp;
import io.junjo.sdk.model.GroupBatchResponse;
import io.junjo.sdk.model.GroupBatchResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.SetMemberNotesInput;
import io.junjo.sdk.model.UpdateGroupInput;
import io.junjo.sdk.queue.QueuedWrite;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.OptionalInt;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/** {@code groups().batch}: the body of every op, If-Match, typed results, op errors and the op limit. */
@Timeout(30)
class GroupBatchTest {
    static final String ROLE = """
            {"id":"r1","groupId":"g1","name":"Mod","priority":10,"color":null,"isDefault":false,
             "permissions":["chat.mute"],"entries":[{"permission":"chat.mute","value":true}],"parents":[],
             "metadata":{},"createdAt":"2026-11-01T00:00:00Z"}""";
    static final String RELATIONSHIP = """
            {"groupAId":"g1","groupBId":"g2","type":"ally","since":"2026-11-01T00:00:00Z","setBy":null}""";

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

    void answer(String version, String... results) {
        server.on("POST", "/v1/groups/g1/batch", (req, ex) -> FakeServer.json(ex, 200,
                "{\"version\":\"" + version + "\",\"results\":[" + String.join(",", results) + "]}",
                Map.of("ETag", "\"" + version + "\"")));
    }

    JsonArray sentOps() {
        FakeServer.Req req = server.requests.get(server.requests.size() - 1);
        JsonObject body = JsonParser.parseString(req.body()).getAsJsonObject();
        assertEquals(1, body.size(), "the envelope holds only ops");
        return body.getAsJsonArray("ops");
    }

    static JsonObject json(String text) {
        return JsonParser.parseString(text).getAsJsonObject();
    }

    @Test
    void everyOpIsSentInTheServerFieldNames() throws Exception {
        Instant until = Instant.parse("2026-12-01T00:00:00Z");
        Map<String, Object> meta = new HashMap<>();
        meta.put("rank", 3);
        List<GroupBatchOp> ops = List.of(
                GroupBatchOp.memberAdd("ns:a"),
                GroupBatchOp.memberAdd("ns:a", "r1", "ns:mod", true),
                GroupBatchOp.memberKick("ns:b", "afk", "ns:mod"),
                GroupBatchOp.memberKick("ns:b", null, null),
                GroupBatchOp.memberLeave("ns:c"),
                GroupBatchOp.memberBan("ns:d", "grief", until, "ns:mod"),
                GroupBatchOp.memberBan("ns:d", null, null, null),
                GroupBatchOp.memberUnban("ns:d", "ns:mod"),
                GroupBatchOp.memberMetadata("ns:e", meta),
                GroupBatchOp.memberNotes("ns:e", SetMemberNotesInput.builder().notesPublic(null).build()),
                GroupBatchOp.memberRoleAdd("ns:f", "r1", "ns:mod"),
                GroupBatchOp.memberRoleRemove("ns:f", "r1", null),
                GroupBatchOp.groupUpdate(UpdateGroupInput.builder().name("B").defaultRoleId(null).actorUserId("ns:mod")
                        .build()),
                GroupBatchOp.roleEntrySet("r1", PermissionEntry.deny("fly", Context.of("world", "hub"))),
                GroupBatchOp.roleEntrySet("r1", PermissionEntry.grant("chat")),
                GroupBatchOp.roleEntryRemove("r1", "fly", Context.of("world", "hub")),
                GroupBatchOp.roleEntryRemove("r1", "chat", null),
                GroupBatchOp.relationshipSet("g2", "ally", true, "ns:mod"),
                GroupBatchOp.relationshipSet("g2", "rival", false, null),
                GroupBatchOp.relationshipClear("g2", true, "ns:mod"),
                GroupBatchOp.relationshipClear("g2", false, null));
        List<String> results = new ArrayList<>();
        for (int i = 0; i < 12; i++) results.add(ClientTest.MEMBER_JSON);
        results.add(ClientTest.GROUP_JSON);
        for (int i = 0; i < 4; i++) results.add(ROLE);
        results.add(RELATIONSHIP);
        results.add(RELATIONSHIP);
        results.add("null");
        results.add("null");
        answer("8", results.toArray(String[]::new));
        join(client.groups().batch("g1", ops));

        String[] expected = {
            "{\"op\":\"member.add\",\"userId\":\"ns:a\"}",
            "{\"op\":\"member.add\",\"userId\":\"ns:a\",\"roleId\":\"r1\",\"actorUserId\":\"ns:mod\",\"createOnly\":true}",
            "{\"op\":\"member.kick\",\"userId\":\"ns:b\",\"reason\":\"afk\",\"actorUserId\":\"ns:mod\"}",
            "{\"op\":\"member.kick\",\"userId\":\"ns:b\"}",
            "{\"op\":\"member.leave\",\"userId\":\"ns:c\"}",
            "{\"op\":\"member.ban\",\"userId\":\"ns:d\",\"reason\":\"grief\",\"expiresAt\":\"2026-12-01T00:00:00Z\","
                    + "\"actorUserId\":\"ns:mod\"}",
            "{\"op\":\"member.ban\",\"userId\":\"ns:d\"}",
            "{\"op\":\"member.unban\",\"userId\":\"ns:d\",\"actorUserId\":\"ns:mod\"}",
            "{\"op\":\"member.update\",\"userId\":\"ns:e\",\"metadata\":{\"rank\":3}}",
            "{\"op\":\"member.update\",\"userId\":\"ns:e\",\"notesPublic\":null}",
            "{\"op\":\"member.role.add\",\"userId\":\"ns:f\",\"roleId\":\"r1\",\"actorUserId\":\"ns:mod\"}",
            "{\"op\":\"member.role.remove\",\"userId\":\"ns:f\",\"roleId\":\"r1\"}",
            "{\"op\":\"group.update\",\"name\":\"B\",\"defaultRoleId\":null,\"actorUserId\":\"ns:mod\"}",
            "{\"op\":\"role.entry.set\",\"roleId\":\"r1\",\"permission\":\"fly\",\"value\":false,"
                    + "\"context\":{\"world\":\"hub\"}}",
            "{\"op\":\"role.entry.set\",\"roleId\":\"r1\",\"permission\":\"chat\",\"value\":true}",
            "{\"op\":\"role.entry.remove\",\"roleId\":\"r1\",\"permission\":\"fly\",\"context\":{\"world\":\"hub\"}}",
            "{\"op\":\"role.entry.remove\",\"roleId\":\"r1\",\"permission\":\"chat\"}",
            "{\"op\":\"relationship.set\",\"otherGroupId\":\"g2\",\"type\":\"ally\",\"mutual\":true,"
                    + "\"actorUserId\":\"ns:mod\"}",
            "{\"op\":\"relationship.set\",\"otherGroupId\":\"g2\",\"type\":\"rival\"}",
            "{\"op\":\"relationship.clear\",\"otherGroupId\":\"g2\",\"mutual\":true,\"actorUserId\":\"ns:mod\"}",
            "{\"op\":\"relationship.clear\",\"otherGroupId\":\"g2\"}",
        };
        JsonArray sent = sentOps();
        assertEquals(expected.length, sent.size());
        for (int i = 0; i < expected.length; i++) {
            assertEquals(json(expected[i]), sent.get(i), "op " + i);
            assertEquals(ops.get(i).op(), sent.get(i).getAsJsonObject().get("op").getAsString());
        }
    }

    @Test
    void resultsAreTypedByTheirOp() throws Exception {
        answer("12345678901234567", ClientTest.MEMBER_JSON, ClientTest.GROUP_JSON, ROLE, RELATIONSHIP, "null",
                "null");
        GroupBatchResponse r = join(client.groups().batch("g1", List.of(
                GroupBatchOp.memberRoleAdd("ns:u1", "r1", null),
                GroupBatchOp.groupUpdate(UpdateGroupInput.builder().name("B").build()),
                GroupBatchOp.roleEntrySet("r1", PermissionEntry.grant("chat.mute")),
                GroupBatchOp.relationshipSet("g2", "ally", false, null),
                GroupBatchOp.relationshipClear("g3", false, null),
                GroupBatchOp.memberKick("ns:u1", null, null))));
        assertEquals("12345678901234567", r.version());
        assertEquals(6, r.results().size());

        assertEquals(7, r.result(0).asMember().orElseThrow().version());
        assertTrue(r.result(0).asGroup().isEmpty());
        assertEquals("A", r.result(1).asGroup().orElseThrow().name());
        assertNull(r.result(1).asGroup().orElseThrow().version(), "a batch's group result carries no version");
        assertEquals("Mod", r.result(2).asRole().orElseThrow().name());
        assertEquals("ally", r.result(3).asRelationship().orElseThrow().type());
        assertSame(GroupBatchResult.NONE, r.result(4));
        assertSame(GroupBatchResult.NONE, r.result(5), "a null result reads as none whatever the op");
        assertTrue(r.result(4).asMember().isEmpty());

        switch (r.result(0)) {
            case GroupBatchResult.MemberResult m -> assertEquals("ns:u1", m.member().userId());
            default -> throw new AssertionError("expected a member result");
        }
    }

    @Test
    void ifMatchAndTheIdempotencyKeyAreSent() throws Exception {
        answer("9", ClientTest.MEMBER_JSON);
        join(client.groups().batch("g1", List.of(GroupBatchOp.memberLeave("ns:u")),
                WriteOptions.idempotent("k1").withIfMatch("8")));
        FakeServer.Req req = server.requests.get(0);
        assertEquals("8", req.header("If-Match"));
        assertEquals("k1", req.header("Idempotency-Key"));
        join(client.groups().batch("g1", List.of(GroupBatchOp.memberLeave("ns:u"))));
        assertNull(server.requests.get(1).header("If-Match"));
    }

    @Test
    void aStaleBatchCarriesTheCurrentVersionAndNoOpIndex() throws Exception {
        server.on("POST", "/v1/groups/g1/batch", (req, ex) -> FakeServer.json(ex, 412, """
                {"code":"precondition_failed","status":412,"message":"stale","details":{"version":"10"}}"""));
        JunjoException e = failure(client.groups().batch("g1", List.of(GroupBatchOp.memberLeave("ns:u")),
                WriteOptions.none().withIfMatch(9)));
        assertEquals("precondition_failed", e.code());
        assertEquals("10", e.details().orElseThrow().get("version"));
        assertEquals(OptionalInt.empty(), e.opIndex());
    }

    @Test
    void aFailingOpIsNamedByItsIndex() throws Exception {
        server.on("POST", "/v1/groups/g1/batch", (req, ex) -> FakeServer.json(ex, 403, """
                {"code":"banned","status":403,"message":"user is banned","details":{"opIndex":2}}"""));
        JunjoException e = failure(client.groups().batch("g1", List.of(
                GroupBatchOp.memberLeave("ns:a"), GroupBatchOp.memberLeave("ns:b"), GroupBatchOp.memberAdd("ns:c"))));
        assertEquals("banned", e.code());
        assertEquals(OptionalInt.of(2), e.opIndex());
        assertEquals(OptionalInt.empty(), new JunjoException("x", "m", null).opIndex());
    }

    @Test
    void aResultCountThatDiffersFromTheOpsIsInvalidWireData() throws Exception {
        answer("9", ClientTest.MEMBER_JSON, ClientTest.MEMBER_JSON);
        JunjoException e = failure(client.groups().batch("g1", List.of(GroupBatchOp.memberLeave("ns:u"))));
        assertEquals(JunjoException.INVALID_WIRE_DATA, e.code());
    }

    @Test
    void theOpCountIsCheckedBeforeSending() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> client.groups().batch("g1", List.of()));
        List<GroupBatchOp> tooMany = Collections.nCopies(GroupBatchOp.MAX_OPS + 1, GroupBatchOp.memberLeave("ns:u"));
        assertThrows(IllegalArgumentException.class, () -> client.groups().batch("g1", tooMany));
        assertThrows(IllegalArgumentException.class, () -> QueuedWrite.groupBatch("g1", tooMany));
        assertTrue(server.requests.isEmpty());

        List<String> results = Collections.nCopies(GroupBatchOp.MAX_OPS, ClientTest.MEMBER_JSON);
        answer("9", results.toArray(String[]::new));
        List<GroupBatchOp> max = Collections.nCopies(GroupBatchOp.MAX_OPS, GroupBatchOp.memberLeave("ns:u"));
        assertEquals(GroupBatchOp.MAX_OPS, join(client.groups().batch("g1", max)).results().size());
    }

    @Test
    void opsRefuseWhatTheServerWouldRefuse() {
        assertThrows(IllegalArgumentException.class, () ->
                GroupBatchOp.groupUpdate(UpdateGroupInput.builder().passcode("1234").build()));
        assertThrows(IllegalArgumentException.class, () -> new GroupBatchOp.MemberUpdate("ns:u", null, null));
        assertThrows(NullPointerException.class, () -> GroupBatchOp.memberLeave(null));
        assertThrows(NullPointerException.class, () -> GroupBatchOp.memberRoleAdd("ns:u", null, null));
        assertEquals(Context.GLOBAL, GroupBatchOp.roleEntryRemove("r", "p", null).context());
    }

    @Test
    void theQueuedBatchSendsTheSameRequest() throws Exception {
        List<GroupBatchOp> ops = List.of(GroupBatchOp.memberKick("ns:u", "afk", "ns:mod"),
                GroupBatchOp.relationshipClear("g2", true, null));
        QueuedWrite w = QueuedWrite.groupBatch("g1", ops).ifMatch("\"8\"");
        answer("9", ClientTest.MEMBER_JSON, "null");
        join(client.groups().batch("g1", ops));
        FakeServer.Req req = server.requests.get(0);
        assertEquals(req.method(), w.method());
        assertEquals(req.pathAndQuery(), w.path());
        JsonElement sent = JsonParser.parseString(req.body());
        assertEquals(sent, JsonParser.parseString(w.body()));
        assertEquals("\"8\"", w.ifMatch());
        assertFalse(w.lift());
    }
}
