package io.junjo.sdk.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.JunjoException;
import io.junjo.sdk.events.EventType;
import io.junjo.sdk.events.JunjoEvent;
import io.junjo.sdk.model.PermissionMode;
import io.junjo.sdk.permissions.ContextInheritance;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

class SseAndDecoderTest {
    static SseReader reader(String text) {
        return new SseReader(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)), 4096);
    }

    @Test
    void parsesEventAndHeartbeatFrames() throws IOException {
        SseReader r = reader("event: game.user.banned\ndata: {\"a\":1}\nid: 42\n\n"
                + ":heartbeat\nid: 57\n\n"
                + ":heartbeat\n\n"
                + "data: one\ndata: two\n\n");
        SseReader.Frame f1 = r.next();
        assertEquals("game.user.banned", f1.event());
        assertEquals("{\"a\":1}", f1.data());
        assertEquals("42", f1.id());
        SseReader.Frame hb = r.next();
        assertNull(hb.data());
        assertNull(hb.event());
        assertEquals("57", hb.id(), "a heartbeat's id-only frame carries the position");
        SseReader.Frame multi = r.next();
        assertEquals("one\ntwo", multi.data(), "a comment-only heartbeat yields no frame");
        assertNull(r.next());
    }

    @Test
    void acceptsCrLfAndBareCrAndNoSpaceAfterColon() throws IOException {
        SseReader r = reader("id:5\r\ndata:x\r\n\r\nid: 6\rdata: y\r\r");
        SseReader.Frame a = r.next();
        assertEquals("5", a.id());
        assertEquals("x", a.data());
        SseReader.Frame b = r.next();
        assertEquals("6", b.id());
        assertEquals("y", b.data());
        assertNull(r.next());
    }

    @Test
    void discardsAPartialTrailingFrame() throws IOException {
        SseReader r = reader("id: 1\n\nid: 2\ndata: half");
        assertEquals("1", r.next().id());
        assertNull(r.next());
    }

    @Test
    void capsTheFrameSize() {
        StringBuilder big = new StringBuilder("data: ");
        big.append("x".repeat(5000));
        SseReader r = reader(big + "\n\n");
        JunjoException e = assertThrows(JunjoException.class, r::next);
        assertEquals(JunjoException.INVALID_WIRE_DATA, e.code());
    }

    static String event(String type, String fields) {
        return """
                {"type":"%s","id":"e1","gameId":"gm","occurredAt":"2026-11-06T12:00:00.000Z",%s}"""
                .formatted(type, fields);
    }

    @Test
    void decodesKnownTypesWithVersions() {
        JunjoEvent.MemberUpdated mu = assertInstanceOf(JunjoEvent.MemberUpdated.class, EventDecoder.decode(event(
                "member.updated", """
                "groupId":"g","userId":"ns:u","changed":["overrides"],"memberVersion":9""")));
        assertEquals(9, mu.memberVersion());
        assertEquals(List.of("overrides"), mu.changed());
        assertEquals("e1", mu.id());
        assertEquals(EventType.MEMBER_UPDATED, mu.type());

        JunjoEvent.GameUserBanned gb = assertInstanceOf(JunjoEvent.GameUserBanned.class, EventDecoder.decode(event(
                "game.user.banned", """
                "junjoUserId":"j","userId":"ns:u","reason":"r","expiresAt":null,"moderationVersion":3""")));
        assertEquals(3, gb.moderationVersion());
        assertNull(gb.expiresAt());

        JunjoEvent.RoleChanged rc = assertInstanceOf(JunjoEvent.RoleChanged.class, EventDecoder.decode(event(
                "role.changed", """
                "groupId":"g","userId":"u","added":["r"],"removed":[],"actorUserId":null""")));
        assertEquals(0, rc.memberVersion(), "an event without a member version reads as 0");
    }

    @Test
    void decodesSanctionAndIdentityEvents() {
        JunjoEvent.GameUserSanctioned s = assertInstanceOf(JunjoEvent.GameUserSanctioned.class,
                EventDecoder.decode(event("game.user.sanctioned", """
                        "userId":"ns:u","sanctionType":"mute","reason":null,"expiresAt":"2026-11-09T13:00:00Z",
                        "moderationVersion":5""")));
        assertEquals("mute", s.sanctionType());
        assertEquals(5, s.moderationVersion());
        JunjoEvent.GameUserUnsanctioned u = assertInstanceOf(JunjoEvent.GameUserUnsanctioned.class,
                EventDecoder.decode(event("game.user.unsanctioned", """
                        "userId":"ns:u","sanctionType":"mute","moderationVersion":6""")));
        assertEquals(6, u.moderationVersion());
        JunjoEvent.IdentityUpdated i = assertInstanceOf(JunjoEvent.IdentityUpdated.class,
                EventDecoder.decode(event("identity.updated", """
                        "userId":"ns:u","changedUserId":"web:u","displayName":"Steve","changed":["displayName"]""")));
        assertEquals("web:u", i.changedUserId());
        assertEquals(List.of("displayName"), i.changed());
    }

    @Test
    void decodesThePermissionConfigEvent() {
        JunjoEvent.PermissionsConfigUpdated c = assertInstanceOf(JunjoEvent.PermissionsConfigUpdated.class,
                EventDecoder.decode(event("permissions.config.updated", """
                        "mode":"nodes","contexts":{"world":{"inherit":{"PvPWorld":["world"]}}}""")));
        assertEquals(EventType.PERMISSIONS_CONFIG_UPDATED, c.type());
        assertEquals(PermissionMode.NODES, c.mode());
        assertEquals(ContextInheritance.builder().inherit("world", "pvpworld", "world").build(), c.contexts());
        assertEquals("gm", c.meta().gameId());
        JunjoEvent.PermissionsConfigUpdated none = assertInstanceOf(JunjoEvent.PermissionsConfigUpdated.class,
                EventDecoder.decode(event("permissions.config.updated", "\"mode\":\"exact\",\"contexts\":{}")));
        assertEquals(PermissionMode.EXACT, none.mode());
        assertEquals(ContextInheritance.NONE, none.contexts());
        assertEquals(JunjoException.INVALID_WIRE_DATA, assertThrows(JunjoException.class, () ->
                EventDecoder.decode(event("permissions.config.updated", "\"contexts\":{}"))).code());
    }

    static final String GROUP = """
            "group":{"id":"g","gameId":"gm","kind":"party","name":"A","visibility":"public","metadata":{},
             "defaultRoleId":null,"parentGroupId":null,"memberCount":1,"hasPasscode":false,
             "createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-01T00:00:00Z","softDeletedAt":null}""";

    @Test
    void decodesTheOriginWhenPresentAndReadsItsAbsenceAsNone() {
        JunjoEvent tagged = EventDecoder.decode(event("group.deleted",
                "\"groupId\":\"g\",\"origin\":{\"apiKeyId\":\"key_1\",\"tag\":\"shard-1\"}"));
        assertEquals("key_1", tagged.origin().apiKeyId());
        assertEquals("shard-1", tagged.origin().tag());
        assertEquals(tagged.origin(), tagged.meta().origin());

        JunjoEvent admin = EventDecoder.decode(event("group.deleted",
                "\"groupId\":\"g\",\"origin\":{\"apiKeyId\":null,\"tag\":null}"));
        assertEquals(JunjoEvent.EventOrigin.NONE, admin.origin());

        JunjoEvent partial = EventDecoder.decode(event("group.deleted", "\"groupId\":\"g\",\"origin\":{\"tag\":\"t\"}"));
        assertNull(partial.origin().apiKeyId());
        assertEquals("t", partial.origin().tag());

        JunjoEvent older = EventDecoder.decode(event("group.deleted", "\"groupId\":\"g\""));
        assertEquals(JunjoEvent.EventOrigin.NONE, older.origin(), "an older server sends no origin");
        assertEquals(JunjoEvent.EventOrigin.NONE,
                EventDecoder.decode(event("group.deleted", "\"groupId\":\"g\",\"origin\":null")).origin());
        assertEquals(JunjoEvent.EventOrigin.NONE, new JunjoEvent.EventMeta("e", "gm", null).origin());
        assertEquals(JunjoEvent.EventOrigin.NONE, new JunjoEvent.EventMeta("e", "gm", null, null).origin());
    }

    @Test
    void decodesTheActorOfGroupEventsAndTheKicker() {
        JunjoEvent.GroupUpdated u = assertInstanceOf(JunjoEvent.GroupUpdated.class, EventDecoder.decode(event(
                "group.updated", "\"groupId\":\"g\",\"actorUserId\":\"ns:mod\"," + GROUP)));
        assertEquals("ns:mod", u.actorUserId());
        assertNull(u.group().version(), "event payloads carry no group version");
        JunjoEvent.GroupUpdated u0 = assertInstanceOf(JunjoEvent.GroupUpdated.class, EventDecoder.decode(event(
                "group.updated", "\"groupId\":\"g\"," + GROUP)));
        assertNull(u0.actorUserId(), "absent on older servers");

        JunjoEvent.GroupDeleted d = assertInstanceOf(JunjoEvent.GroupDeleted.class, EventDecoder.decode(event(
                "group.deleted", "\"groupId\":\"g\",\"actorUserId\":\"ns:mod\"")));
        assertEquals("ns:mod", d.actorUserId());
        assertNull(assertInstanceOf(JunjoEvent.GroupDeleted.class, EventDecoder.decode(event(
                "group.deleted", "\"groupId\":\"g\",\"actorUserId\":null"))).actorUserId());

        JunjoEvent.GroupRelationshipChanged r = assertInstanceOf(JunjoEvent.GroupRelationshipChanged.class,
                EventDecoder.decode(event("group.relationship.changed", """
                        "groupId":"g","otherGroupId":"h","actorUserId":"ns:mod","relationship":{"groupAId":"g",
                        "groupBId":"h","type":"ally","since":"2026-11-01T00:00:00Z","setBy":"ns:mod"}""")));
        assertEquals("ns:mod", r.actorUserId());
        assertEquals("ns:mod", r.relationship().setBy());
        JunjoEvent.GroupRelationshipChanged cleared = assertInstanceOf(JunjoEvent.GroupRelationshipChanged.class,
                EventDecoder.decode(event("group.relationship.changed",
                        "\"groupId\":\"g\",\"otherGroupId\":\"h\",\"relationship\":null")));
        assertNull(cleared.relationship());
        assertNull(cleared.actorUserId());

        JunjoEvent.MemberLeft kicked = assertInstanceOf(JunjoEvent.MemberLeft.class, EventDecoder.decode(event(
                "member.left", "\"groupId\":\"g\",\"userId\":\"u\",\"reason\":\"kicked\",\"kickedBy\":\"ns:mod\"")));
        assertEquals("ns:mod", kicked.kickedBy());
        JunjoEvent.MemberLeft unattributed = assertInstanceOf(JunjoEvent.MemberLeft.class, EventDecoder.decode(event(
                "member.left", "\"groupId\":\"g\",\"userId\":\"u\",\"reason\":\"kicked\"")));
        assertNull(unattributed.kickedBy());
    }

    @Test
    void everyEventTypeRoundTripsItsWireName() {
        for (EventType t : EventType.values()) assertEquals(t, EventType.fromWire(t.wire()).orElseThrow());
        assertTrue(EventType.fromWire("future.thing").isEmpty());
    }

    @Test
    void unknownTypeDecodesToNull() {
        assertNull(EventDecoder.decode(event("future.thing", "\"x\":1")));
    }

    @Test
    void malformedEventIsInvalidWireData() {
        JunjoException e = assertThrows(JunjoException.class,
                () -> EventDecoder.decode(event("member.updated", "\"x\":1")));
        assertEquals(JunjoException.INVALID_WIRE_DATA, e.code());
    }
}
