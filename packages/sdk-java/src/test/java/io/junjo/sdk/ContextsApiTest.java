package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.ImportMember;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.MemberImport;
import io.junjo.sdk.model.MemberPermissionOverride;
import io.junjo.sdk.model.PermissionCheckRequest;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.model.RoleGraph;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/** Contexts on the wire: what each call sends and how contextual answers decode. */
@Timeout(30)
class ContextsApiTest {
    static final Context CREATIVE = Context.of("world", "Creative");
    static final String ROLE = """
            {"id":"r1","groupId":"g1","name":"Admin","priority":10,"color":null,"isDefault":false,
             "permissions":["essentials.home"],"entries":[
               {"permission":"essentials.fly","value":false},
               {"permission":"essentials.*","value":true,"context":{"world":"creative"}}],
             "parents":[],"metadata":{},"createdAt":"2026-11-01T00:00:00Z"}""";
    static final String OVERRIDE = """
            {"groupId":"g1","userId":"ns:u","permission":"chat.color","grant":false,"context":{"world":"hub"},
             "setAt":"2026-11-01T00:00:00Z","setBy":null}""";

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

    static JsonObject body(FakeServer.Req req) {
        return JsonParser.parseString(req.body()).getAsJsonObject();
    }

    @Test
    void roleEntryWritesSendTheContext() throws Exception {
        server.onPrefix("POST", "/v1/roles/", (req, ex) -> FakeServer.json(ex, 200, ROLE));
        server.onPrefix("PUT", "/v1/roles/", (req, ex) -> FakeServer.json(ex, 200, ROLE));
        server.onPrefix("DELETE", "/v1/roles/", (req, ex) -> FakeServer.json(ex, 200, ROLE));

        Role r = join(client.roles().grantPermission("r1", "essentials.*", true, CREATIVE));
        FakeServer.Req grant = server.requests.get(0);
        assertEquals("/v1/roles/r1/permissions", grant.path());
        assertEquals(JsonParser.parseString(
                "{\"permission\":\"essentials.*\",\"value\":true,\"context\":{\"world\":\"creative\"}}"), body(grant));
        assertEquals(List.of(PermissionEntry.deny("essentials.fly"),
                PermissionEntry.grant("essentials.*", Context.of("world", "creative"))), r.entries());

        join(client.roles().grantPermission("r1", "essentials.home"));
        assertEquals(JsonParser.parseString("{\"permission\":\"essentials.home\",\"value\":true}"),
                body(server.requests.get(1)), "a global write sends no context");

        join(client.roles().revokePermission("r1", "essentials.*", Context.of("server", "EU", "world", "a b")));
        assertEquals("/v1/roles/r1/permissions/essentials.*?context.server=eu&context.world=a%20b",
                server.requests.get(2).pathAndQuery());
        join(client.roles().revokePermission("r1", "essentials.*"));
        assertNull(server.requests.get(3).query(), "a global revoke sends no context query");

        join(client.roles().setEntries("r1", List.of(
                PermissionEntry.deny("essentials.fly"), PermissionEntry.grant("essentials.*", CREATIVE))));
        assertEquals(JsonParser.parseString("""
                {"entries":[{"permission":"essentials.fly","value":false},
                 {"permission":"essentials.*","value":true,"context":{"world":"creative"}}]}"""),
                body(server.requests.get(4)));
    }

    @Test
    void overrideWritesSendTheContext() throws Exception {
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, OVERRIDE));
        server.onPrefix("DELETE", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 204, ""));
        Context hub = Context.of("world", "HUB");
        MemberPermissionOverride o = join(client.members().overridePermission("g1", "ns:u", "chat.color", false, hub));
        assertEquals(hub, o.context());
        assertEquals(JsonParser.parseString("{\"grant\":false,\"context\":{\"world\":\"hub\"}}"),
                body(server.requests.get(0)));
        join(client.members().clearPermissionOverride("g1", "ns:u", "chat.color", hub));
        assertEquals("/v1/groups/g1/members/ns%3Au/permissions/chat.color?context.world=hub",
                server.requests.get(1).pathAndQuery());
    }

    @Test
    void importRowsCarryContextualOverrides() throws Exception {
        server.on("POST", "/v1/groups/g1/members/import", (req, ex) -> FakeServer.json(ex, 200,
                "{\"created\":1,\"reactivated\":0,\"updated\":0,\"unchanged\":0,\"items\":[]}"));
        join(client.members().importMembers("g1", MemberImport.builder()
                .add(ImportMember.builder("ns:u").overrides(List.of(
                        PermissionEntry.deny("fly", Context.of("world", "Spawn")),
                        PermissionEntry.grant("fly"))).build())
                .build()));
        JsonElement overrides = body(server.requests.get(0)).getAsJsonArray("members").get(0)
                .getAsJsonObject().get("overrides");
        assertEquals(JsonParser.parseString("""
                [{"permission":"fly","value":false,"context":{"world":"spawn"}},{"permission":"fly","value":true}]"""),
                overrides);
    }

    @Test
    void checksSendTheContextAndReportTheDecidingOne() throws Exception {
        server.on("GET", "/v1/permissions/check", (req, ex) -> FakeServer.json(ex, 200,
                "{\"allowed\":true,\"source\":\"role\",\"viaRoleId\":\"r1\",\"context\":{\"world\":\"creative\"}}"));
        PermissionCheckResult r = join(client.permissions().check("ns:u", "g1", "essentials.fly", CREATIVE));
        assertEquals("userId=ns%3Au&groupId=g1&permission=essentials.fly&context.world=creative",
                server.requests.get(0).query());
        assertEquals(Context.of("world", "creative"), r.context());
        join(client.permissions().check("ns:u", "g1", "essentials.fly", true, Context.of("world", "x")));
        assertEquals("userId=ns%3Au&groupId=g1&permission=essentials.fly&inherit=true&context.world=x",
                server.requests.get(1).query());

        server.on("POST", "/v1/permissions/check-batch", (req, ex) -> FakeServer.json(ex, 200, """
                {"results":[{"allowed":false,"source":"default"},
                 {"allowed":true,"source":"override","context":{"world":"hub"}}]}"""));
        List<PermissionCheckResult> batch = join(client.permissions().checkBatch(List.of(
                new PermissionCheckRequest("ns:u", "g1", "a"),
                new PermissionCheckRequest("ns:u", "g1", "a", Context.of("world", "Hub")))));
        assertEquals(JsonParser.parseString("""
                {"checks":[{"userId":"ns:u","groupId":"g1","permission":"a"},
                 {"userId":"ns:u","groupId":"g1","permission":"a","context":{"world":"hub"}}]}"""),
                body(server.requests.get(2)));
        assertEquals(Context.GLOBAL, batch.get(0).context());
        assertEquals(Context.of("world", "hub"), batch.get(1).context());
    }

    @Test
    void readsDecodeContextualEntriesAndOverrides() throws Exception {
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> FakeServer.json(ex, 200,
                "{\"groupId\":\"g1\",\"mode\":\"nodes\",\"defaultRoleId\":null,\"roles\":[" + ROLE + "]}"));
        server.on("GET", "/v1/groups/g1/members/ns%3Au/access", (req, ex) -> FakeServer.json(ex, 200,
                "{\"groupId\":\"g1\",\"userId\":\"ns:u\",\"status\":\"active\",\"roleIds\":[\"r1\"],"
                        + "\"overrides\":[" + OVERRIDE + "],\"version\":3}"));
        RoleGraph g = join(client.roles().getGraph("g1")).value();
        assertEquals(Context.of("world", "creative"), g.roles().get(0).entries().get(1).context());
        assertEquals(Context.GLOBAL, g.roles().get(0).entries().get(0).context());
        MemberAccess a = join(client.members().getAccess("g1", "ns:u")).value();
        assertEquals(Context.of("world", "hub"), a.overrides().get(0).context());
    }
}
