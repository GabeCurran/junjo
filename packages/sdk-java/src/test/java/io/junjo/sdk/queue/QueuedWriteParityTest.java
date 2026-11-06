package io.junjo.sdk.queue;

import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonParser;
import io.junjo.sdk.FakeServer;
import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.TestSupport;
import io.junjo.sdk.WriteOptions;
import io.junjo.sdk.model.AddSanctionInput;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.CreateBanInput;
import io.junjo.sdk.model.SetMemberNotesInput;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/** Every queued write sends exactly the request of the API call it is named after. */
@Timeout(30)
class QueuedWriteParityTest {
    static final String MEMBER = """
            {"id":"m","groupId":"g","userId":"u","status":"active","roles":[],"metadata":{},"notesPublic":null,
             "notesPrivate":null,"joinedAt":"2026-11-01T00:00:00Z","bannedUntil":null,"version":2}""";
    static final String OVERRIDE = """
            {"groupId":"g","userId":"u","permission":"p","grant":true,"setAt":"2026-11-01T00:00:00Z","setBy":null}""";
    static final String BAN = """
            {"id":"b","gameId":"gm","userId":"u","bannedAt":"2026-11-01T00:00:00Z","expiresAt":null,"reason":null,
             "bannedBy":null,"issuer":null,"version":1}""";
    static final String SANCTION = """
            {"id":"s","userId":"u","type":"mute","reason":null,"issuer":null,"issuedBy":null,
             "startedAt":"2026-11-01T00:00:00Z","expiresAt":null,"version":1}""";

    FakeServer server;
    JunjoClient client;

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeServer();
        server.onPrefix("POST", "/v1/", (req, ex) -> FakeServer.json(ex, 200, body(req.path())));
        server.onPrefix("PATCH", "/v1/", (req, ex) -> FakeServer.json(ex, 200, MEMBER));
        server.onPrefix("DELETE", "/v1/", (req, ex) -> FakeServer.json(ex, 200, MEMBER));
        client = TestSupport.client(server.baseUrl());
    }

    static String body(String path) {
        if (path.contains("/permissions/")) return OVERRIDE;
        if (path.equals("/v1/bans")) return BAN;
        if (path.equals("/v1/sanctions")) return SANCTION;
        return MEMBER;
    }

    @AfterEach
    void tearDown() {
        client.close();
        server.close();
    }

    void same(QueuedWrite w, Supplier<CompletableFuture<?>> call) throws Exception {
        server.requests.clear();
        join(call.get());
        FakeServer.Req req = server.requests.get(0);
        assertEquals(req.method(), w.method(), w.label());
        assertEquals(req.pathAndQuery(), w.path(), w.label());
        assertEquals(json(req.body()), json(w.body()), w.label());
    }

    static JsonElement json(String body) {
        return body == null || body.isEmpty() ? JsonNull.INSTANCE : JsonParser.parseString(body);
    }

    @Test
    void factoriesMatchTheApiCalls() throws Exception {
        Instant until = Instant.parse("2027-01-01T00:00:00Z");
        same(QueuedWrite.addMember("g", "ns:u", "r", "ns:mod"),
                () -> client.members().add("g", "ns:u", "r", "ns:mod", WriteOptions.none()));
        same(QueuedWrite.assignRole("g", "ns:u", "r", "ns:mod"),
                () -> client.members().assignRole("g", "ns:u", "r", "ns:mod", WriteOptions.none()));
        same(QueuedWrite.removeRole("g", "ns:u", "r", null), () -> client.members().removeRole("g", "ns:u", "r"));
        same(QueuedWrite.overridePermission("g", "ns:u", "a.*", false),
                () -> client.members().overridePermission("g", "ns:u", "a.*", false));
        same(QueuedWrite.clearPermissionOverride("g", "ns:u", "a.b"),
                () -> client.members().clearPermissionOverride("g", "ns:u", "a.b"));
        Context hub = Context.of("world", "Hub");
        same(QueuedWrite.overridePermission("g", "ns:u", "a.*", false, hub),
                () -> client.members().overridePermission("g", "ns:u", "a.*", false, hub));
        same(QueuedWrite.clearPermissionOverride("g", "ns:u", "a.b", hub),
                () -> client.members().clearPermissionOverride("g", "ns:u", "a.b", hub));
        same(QueuedWrite.overridePermission("g", "ns:u", "a.*", true, Context.GLOBAL),
                () -> client.members().overridePermission("g", "ns:u", "a.*", true));
        same(QueuedWrite.setMetadata("g", "ns:u", Map.of("rank", 2)),
                () -> client.members().setMetadata("g", "ns:u", Map.of("rank", 2)));
        SetMemberNotesInput notes = SetMemberNotesInput.builder().notesPrivate("n").build();
        same(QueuedWrite.setNotes("g", "ns:u", notes), () -> client.members().setNotes("g", "ns:u", notes));
        same(QueuedWrite.kick("g", "ns:u", "afk"), () -> client.groups().kick("g", "ns:u", "afk", WriteOptions.none()));
        same(QueuedWrite.groupBan("g", "ns:u", "grief", until, "ns:mod"),
                () -> client.groups().ban("g", "ns:u", "grief", until, "ns:mod", WriteOptions.none()));
        same(QueuedWrite.groupUnban("g", "ns:u", "ns:mod"),
                () -> client.groups().unban("g", "ns:u", "ns:mod", WriteOptions.none()));
        CreateBanInput ban = CreateBanInput.builder("ns:u").reason("x").actorUserId("ns:mod").build();
        same(QueuedWrite.addBan(ban), () -> client.bans().add(ban));
        same(QueuedWrite.removeBan("ns:u", "ns:mod"), () -> client.bans().remove("ns:u", "ns:mod",
                WriteOptions.none()));
        AddSanctionInput mute = AddSanctionInput.builder("ns:u", "mute").expiresAt(until).build();
        same(QueuedWrite.addSanction(mute), () -> client.sanctions().add(mute));
        same(QueuedWrite.removeSanction("ns:u", "trade.lock", "ns:mod"),
                () -> client.sanctions().remove("ns:u", "trade.lock", "ns:mod", WriteOptions.none()));
    }

    @Test
    void addMemberKeepsTheActor() {
        assertEquals("{\"userId\":\"u\",\"actorUserId\":\"ns:mod\"}",
                QueuedWrite.addMember("g", "u", null, "ns:mod").body());
    }

    @Test
    void onlyLiftsAreMarkedAsLifts() {
        assertTrue(QueuedWrite.removeBan("u", null).lift());
        assertTrue(QueuedWrite.removeSanction("u", "mute", null).lift());
        assertTrue(QueuedWrite.groupUnban("g", "u", null).lift());
        assertFalse(QueuedWrite.addBan(CreateBanInput.builder("u").build()).lift());
        assertFalse(QueuedWrite.kick("g", "u", null).lift());
    }

    @Test
    void customWritesValidateTheirPath() {
        assertThrows(IllegalArgumentException.class, () -> QueuedWrite.custom("POST", "/admin/x", null));
        assertThrows(IllegalArgumentException.class, () -> QueuedWrite.custom("GET", "/v1/x", null));
        QueuedWrite w = QueuedWrite.overridePermission("g", "ns:u", "a.*", false);
        assertEquals("/v1/groups/g/members/ns%3Au/permissions/a.*", w.path());
        assertEquals("{\"grant\":false}", w.body());
    }

    @Test
    void contextualOverridesCarryTheirContext() {
        Context both = Context.of("world", "Hub", "server", "EU");
        QueuedWrite set = QueuedWrite.overridePermission("g", "ns:u", "a.*", false, both);
        assertEquals("{\"grant\":false,\"context\":{\"server\":\"eu\",\"world\":\"hub\"}}", set.body());
        QueuedWrite clear = QueuedWrite.clearPermissionOverride("g", "ns:u", "a.b", both);
        assertEquals("/v1/groups/g/members/ns%3Au/permissions/a.b?context.server=eu&context.world=hub", clear.path());
        assertNull(clear.body());
    }
}
