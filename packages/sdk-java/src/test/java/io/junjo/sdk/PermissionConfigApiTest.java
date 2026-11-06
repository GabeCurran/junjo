package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.junjo.sdk.internal.Json;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.model.PermissionConfig;
import io.junjo.sdk.model.PermissionMode;
import io.junjo.sdk.model.RoleGraph;
import io.junjo.sdk.permissions.ContextInheritance;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/** The game's permission config on the wire: the config read and the role graph's inheritance. */
@Timeout(30)
class PermissionConfigApiTest {
    static final ContextInheritance WORLDS = ContextInheritance.builder()
            .inherit("world", "pvpworld", "world")
            .inherit("world", "nether", "world", "pvpworld")
            .inherit("server", "eu-1", "eu")
            .build();
    static final String WORLDS_JSON = """
            {"world":{"inherit":{"PvPWorld":["world"],"nether":["World","pvpworld","world"]}},
             "server":{"inherit":{"eu-1":["eu"]}}}""";

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

    static String graph(String contexts) {
        return """
                {"groupId":"g1","mode":"nodes","defaultRoleId":null,"roles":[]%s}"""
                .formatted(contexts == null ? "" : ",\"contexts\":" + contexts);
    }

    @Test
    void configReadsTheModeAndTheFoldedInheritance() throws Exception {
        server.on("GET", "/v1/permissions/config", (req, ex) ->
                FakeServer.json(ex, 200, "{\"mode\":\"nodes\",\"contexts\":" + WORLDS_JSON + "}"));
        PermissionConfig c = join(client.permissions().config());
        assertEquals(PermissionMode.NODES, c.mode());
        assertEquals(WORLDS, c.contexts(), "values fold and repeated parents collapse");
        assertEquals("/v1/permissions/config", server.requests.get(0).pathAndQuery());

        server.on("GET", "/v1/permissions/config", (req, ex) ->
                FakeServer.json(ex, 200, "{\"mode\":\"exact\",\"contexts\":{}}"));
        assertEquals(new PermissionConfig(PermissionMode.EXACT, ContextInheritance.NONE),
                join(client.permissions().config()));
    }

    @Test
    void aMalformedConfigIsInvalidWireData() throws Exception {
        server.on("GET", "/v1/permissions/config", (req, ex) ->
                FakeServer.json(ex, 200, "{\"mode\":\"fuzzy\",\"contexts\":{}}"));
        assertEquals(JunjoException.INVALID_WIRE_DATA, failure(client.permissions().config()).code());
        server.on("GET", "/v1/permissions/config", (req, ex) ->
                FakeServer.json(ex, 200, "{\"contexts\":{}}"));
        assertEquals(JunjoException.INVALID_WIRE_DATA, failure(client.permissions().config()).code());
    }

    @Test
    void theRoleGraphCarriesTheInheritance() throws Exception {
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> FakeServer.json(ex, 200, graph(WORLDS_JSON)));
        RoleGraph g = join(client.roles().getGraph("g1")).value();
        assertEquals(WORLDS, g.contexts());
        assertEquals(PermissionMode.NODES, g.mode());
    }

    @Test
    void anOlderServerWithoutContextsReadsAsNone() throws Exception {
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> FakeServer.json(ex, 200, graph(null)));
        assertEquals(ContextInheritance.NONE, join(client.roles().getGraph("g1")).value().contexts());
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> FakeServer.json(ex, 200, graph("null")));
        assertEquals(ContextInheritance.NONE, join(client.roles().getGraph("g1")).value().contexts());
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> FakeServer.json(ex, 200, graph("{}")));
        assertEquals(ContextInheritance.NONE, join(client.roles().getGraph("g1")).value().contexts());
    }

    @Test
    void unknownFieldsAreIgnoredAndAKeyWithoutInheritDeclaresNothing() {
        ContextInheritance c = Wire.contexts(Json.parseObject("""
                {"contexts":{"world":{"inherit":{"pvpworld":["world"]},"future":1},"server":{},
                 "region":{"inherit":{}}}}"""));
        assertEquals(ContextInheritance.builder().inherit("world", "pvpworld", "world").build(), c);
    }

    @Test
    void anInheritanceTheServerWouldRefuseIsInvalidWireData() {
        for (String bad : List.of(
                "{\"world\":{\"inherit\":{\"a\":[\"b\"],\"b\":[\"a\"]}}}",
                "{\"world\":{\"inherit\":{\"a\":[1]}}}",
                "{\"world\":{\"inherit\":{\"a\":\"b\"}}}",
                "{\"world\":[]}",
                "[]")) {
            JunjoException e = assertThrows(JunjoException.class,
                    () -> Wire.contexts(Json.parseObject("{\"contexts\":" + bad + "}")), bad);
            assertEquals(JunjoException.INVALID_WIRE_DATA, e.code(), bad);
        }
    }

    @Test
    void theWireShapeRoundTrips() {
        assertEquals(WORLDS, Wire.contexts(Json.parseObject(
                "{\"contexts\":" + Wire.contextsJson(WORLDS) + "}")));
        assertEquals("{}", Wire.contextsJson(ContextInheritance.NONE).toString());
    }

    @Test
    void graphsBuiltWithoutContextsHaveNone() {
        assertEquals(ContextInheritance.NONE, new RoleGraph("g1", PermissionMode.EXACT, null, List.of()).contexts());
        assertEquals(ContextInheritance.NONE,
                new RoleGraph("g1", PermissionMode.EXACT, null, List.of(), null).contexts());
        assertEquals(ContextInheritance.NONE, new PermissionConfig(PermissionMode.EXACT, null).contexts());
    }
}
