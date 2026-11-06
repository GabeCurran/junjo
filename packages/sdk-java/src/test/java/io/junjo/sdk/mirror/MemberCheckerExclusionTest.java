package io.junjo.sdk.mirror;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import io.junjo.sdk.FakeServer;
import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.TestSupport;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionSource;
import io.junjo.sdk.permissions.ContextInheritance;
import io.junjo.sdk.permissions.PermissionResolver;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/** Checkers that treat some roles as not held: semantics, contexts, inheritance and overrides. */
@Timeout(30)
class MemberCheckerExclusionTest {
    static final Context WORLD = Context.of("world", "world");
    static final Context PVP = Context.of("world", "pvpworld");
    static final Context CREATIVE = Context.of("world", "creative");
    static final ContextInheritance WORLDS = ContextInheritance.builder().inherit("world", "pvpworld", "world").build();
    static final Set<String> STAFF = Set.of("staff");
    static final List<String> PERMISSIONS = List.of(
            "chat.color", "mod.kick", "mod.mute", "mod.ban", "essentials.fly", "cosmetic.hat", "warp.spawn", "x");

    FakeServer server;
    JunjoClient client;
    GameMirror mirror;
    final CountDownLatch hold = new CountDownLatch(1);
    final LinkedBlockingQueue<String> frames = new LinkedBlockingQueue<>();
    final Map<String, String> accessByUser = new ConcurrentHashMap<>();

    static String role(String id, int priority, String entries, String... parents) {
        StringBuilder p = new StringBuilder();
        for (String parent : parents) p.append(p.isEmpty() ? "" : ",").append('"').append(parent).append('"');
        return """
                {"id":"%s","groupId":"g1","name":"%s","priority":%d,"color":null,"isDefault":%b,"permissions":[],
                 "entries":[%s],"parents":[%s],"metadata":{},"createdAt":"2026-11-01T00:00:00Z"}"""
                .formatted(id, id, priority, id.equals("member"), entries, p);
    }

    // member is the default role; staff inherits member; helper inherits staff; vip inherits member.
    static String graph() {
        return "{\"groupId\":\"g1\",\"mode\":\"nodes\",\"defaultRoleId\":\"member\",\"roles\":["
                + String.join(",",
                        role("member", 1, "{\"permission\":\"chat.color\",\"value\":true},"
                                + "{\"permission\":\"warp.*\",\"value\":true,\"context\":{\"world\":\"world\"}}"),
                        role("staff", 50, "{\"permission\":\"mod.kick\",\"value\":true},"
                                + "{\"permission\":\"chat.color\",\"value\":false},"
                                + "{\"permission\":\"essentials.fly\",\"value\":true,\"context\":{\"world\":\"world\"}}",
                                "member"),
                        role("helper", 20, "{\"permission\":\"mod.mute\",\"value\":true}", "staff"),
                        role("vip", 10, "{\"permission\":\"cosmetic.*\",\"value\":true}", "member"))
                + "]}";
    }

    static String access(String userId, long version, String roles, String overrides) {
        return """
                {"groupId":"g1","userId":"%s","status":"active","roleIds":[%s],"overrides":[%s],"version":%d}"""
                .formatted(userId, roles, overrides, version);
    }

    static String override(String userId, String permission, boolean grant, String context) {
        return """
                {"groupId":"g1","userId":"%s","permission":"%s","grant":%b,%s"setAt":"2026-11-01T00:00:00Z",
                 "setBy":null}""".formatted(userId, permission, grant, context == null ? "" : "\"context\":" + context + ",");
    }

    @BeforeEach
    void setUp() throws Exception {
        accessByUser.put("ns:u1", access("ns:u1", 5, "\"staff\",\"vip\"",
                override("ns:u1", "mod.ban", true, null) + ","
                        + override("ns:u1", "essentials.fly", false, "{\"world\":\"pvpworld\"}")));
        accessByUser.put("ns:u2", access("ns:u2", 3, "\"helper\",\"vip\"", ""));
        server = new FakeServer();
        server.on("GET", "/v1/events/position", (req, ex) -> FakeServer.json(ex, 200, "{\"position\":\"10\"}"));
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> FakeServer.json(ex, 200, graph()));
        server.on("GET", "/v1/bans", (req, ex) -> FakeServer.json(ex, 200, "{\"items\":[],\"nextCursor\":null}"));
        server.on("GET", "/v1/sanctions", (req, ex) ->
                FakeServer.json(ex, 200, "{\"items\":[],\"nextCursor\":null}"));
        server.onPrefix("GET", "/v1/users/", (req, ex) ->
                FakeServer.json(ex, 200, "{\"items\":[]}", Map.of("ETag", "\"0\"")));
        server.onPrefix("GET", "/v1/groups/g1/members/", (req, ex) -> {
            String a = accessByUser.get(URLDecoder.decode(req.path().split("/")[5], StandardCharsets.UTF_8));
            if (a == null) FakeServer.json(ex, 404, FakeServer.error("not_found", 404, "no member"));
            else FakeServer.json(ex, 200, a);
        });
        server.on("POST", "/v1/groups/g1/members/access", (req, ex) -> {
            List<String> items = new ArrayList<>();
            for (JsonElement id : JsonParser.parseString(req.body()).getAsJsonObject().getAsJsonArray("userIds")) {
                items.add(accessByUser.getOrDefault(id.getAsString(), "null"));
            }
            FakeServer.json(ex, 200, "{\"items\":[" + String.join(",", items) + "]}");
        });
        server.on("GET", "/v1/events", (req, ex) -> {
            String last = req.header("Last-Event-ID");
            OutputStream out = FakeServer.openSse(ex, last == null ? "50" : last);
            while (hold.getCount() > 0) {
                String f = frames.poll(50, TimeUnit.MILLISECONDS);
                if (f != null) FakeServer.write(out, f);
            }
        });
        client = TestSupport.client(server.baseUrl());
        mirror = builder().build();
        join(mirror.start());
        join(mirror.track("ns:u1", "g1"));
        join(mirror.track("ns:u2", "g1"));
    }

    GameMirror.Builder builder() {
        return GameMirror.builder(client)
                .group("g1")
                .contextInheritance(WORLDS)
                .retryBackoff(Duration.ofMillis(20), Duration.ofMillis(100))
                .streamOptions(SubscribeOptions.builder().backoff(Duration.ofMillis(10), Duration.ofMillis(30)));
    }

    @AfterEach
    void tearDown() {
        hold.countDown();
        mirror.close();
        client.close();
        server.close();
    }

    void push(String type, String position, String fields) {
        frames.add("event: " + type + "\ndata: {\"id\":\"e" + position + "\",\"type\":\"" + type + "\","
                + "\"gameId\":\"gm\",\"occurredAt\":\"2026-11-06T12:00:00.000Z\"," + fields + "}\nid: " + position
                + "\n\n");
    }

    // What the server's check answers for the member with the excluded roles removed from their access.
    PermissionCheckResult withRolesRemoved(String userId, Set<String> excluded, String permission, Context context) {
        MemberAccess a = mirror.access(userId, "g1").orElseThrow();
        List<String> kept = a.roleIds().stream().filter(r -> !excluded.contains(r)).toList();
        MemberAccess without = new MemberAccess(
                a.groupId(), a.userId(), a.status(), kept, a.overrides(), a.version(), a.displayName(), a.metadata());
        return PermissionResolver.compile(mirror.roleGraph("g1").orElseThrow(), WORLDS)
                .check(without, permission, context);
    }

    @Test
    void anExcludedRoleStopsCountingAndTheRemainingRolesStillApply() {
        MemberChecker base = mirror.checker("ns:u1", "g1", WORLD);
        MemberChecker capped = base.excludingRoles(STAFF);
        assertEquals(Answer.YES, base.can("mod.kick"));
        assertEquals(Answer.NO, base.can("chat.color"), "staff's deny decides on the first layer");
        assertEquals(Answer.YES, base.can("essentials.fly"));

        PermissionCheckResult kick = capped.check("mod.kick").orElseThrow();
        assertEquals(PermissionSource.DEFAULT, kick.source());
        assertEquals(Answer.NO, capped.can("essentials.fly"), "the excluded role's contextual entries go too");
        PermissionCheckResult chat = capped.check("chat.color").orElseThrow();
        assertTrue(chat.allowed(), "member, reached through vip, now decides");
        assertEquals("member", chat.viaRoleId());
        assertEquals(Answer.YES, capped.can("cosmetic.hat"));
        assertEquals(Answer.YES, capped.can("warp.spawn"), "a remaining role's contextual entry applies");
    }

    @Test
    void overridesApplyAsBefore() {
        MemberChecker capped = mirror.checker("ns:u1", "g1", PVP).excludingRoles(STAFF);
        PermissionCheckResult ban = capped.check("mod.ban").orElseThrow();
        assertEquals(PermissionSource.OVERRIDE, ban.source());
        assertTrue(ban.allowed());
        PermissionCheckResult fly = capped.check("essentials.fly").orElseThrow();
        assertEquals(PermissionSource.OVERRIDE, fly.source(), "the contextual override still decides in pvpworld");
        assertFalse(fly.allowed());
        assertEquals(Answer.YES, capped.can("warp.spawn"), "pvpworld inherits world's entry from member");
    }

    @Test
    void anExcludedRoleReachedAsAParentOfAHeldRoleStillApplies() {
        MemberChecker capped = mirror.checker("ns:u2", "g1", WORLD).excludingRoles(STAFF);
        PermissionCheckResult kick = capped.check("mod.kick").orElseThrow();
        assertTrue(kick.allowed(), "helper still holds staff as its parent");
        assertEquals("staff", kick.viaRoleId());

        MemberChecker both = capped.excludingRoles(Set.of("helper"));
        assertEquals(Set.of("staff", "helper"), both.excludedRoles(), "exclusions accumulate");
        assertEquals(Answer.NO, both.can("mod.kick"));
        assertEquals(Answer.NO, both.can("mod.mute"));
        assertEquals(Answer.YES, both.can("chat.color"), "vip's parent member decides now");
        assertEquals(Answer.YES, capped.can("mod.mute"), "the checker it came from is unchanged");
    }

    @Test
    void answersEqualTheResolverForAnAccessWithoutTheRoles() {
        List<Set<String>> exclusions = List.of(Set.of(), STAFF, Set.of("staff", "helper"), Set.of("vip"),
                Set.of("member"), Set.of("staff", "vip", "helper", "member"), Set.of("no-such-role"));
        for (String user : List.of("ns:u1", "ns:u2")) {
            for (Context c : Arrays.asList(Context.GLOBAL, WORLD, PVP, CREATIVE)) {
                for (Set<String> excluded : exclusions) {
                    MemberChecker checker = mirror.checker(user, "g1", c).excludingRoles(excluded);
                    for (String p : PERMISSIONS) {
                        assertEquals(withRolesRemoved(user, excluded, p, c), checker.check(p).orElseThrow(),
                                user + " without " + excluded + ": " + p + " in " + c);
                    }
                }
            }
        }
    }

    @Test
    void grantedKeysLeaveOutTheExcludedRoles() {
        assertEquals(Set.of("chat.color", "cosmetic.*", "mod.ban", "warp.*"),
                mirror.checker("ns:u1", "g1", WORLD).excludingRoles(STAFF).grantedKeys().orElseThrow());
        assertEquals(Set.of("cosmetic.*", "essentials.fly", "mod.ban", "mod.kick", "warp.*"),
                mirror.checker("ns:u1", "g1", WORLD).grantedKeys().orElseThrow());
    }

    @Test
    void theExclusionFollowsAccessReloads() throws Exception {
        MemberChecker capped = mirror.checker("ns:u1", "g1").excludingRoles(Set.of("staff", "helper"));
        accessByUser.put("ns:u1", access("ns:u1", 6, "\"helper\",\"vip\"", ""));
        push("member.updated", "11", "\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"changed\":[\"roles\"],"
                + "\"memberVersion\":6");
        await(() -> mirror.access("ns:u1", "g1").map(a -> a.version() == 6).orElse(false), "the reload");
        assertEquals(Answer.NO, capped.can("mod.mute"), "a newly held excluded role does not count either");
        assertEquals(Answer.YES, mirror.checker("ns:u1", "g1").can("mod.mute"));
    }

    @Test
    void theDefaultRoleOfANonMemberCanBeExcluded() throws Exception {
        mirror.close();
        mirror = builder().defaultRoleForNonMembers(true).build();
        join(mirror.start());
        join(mirror.track("ns:ghost", "g1"));
        MemberChecker ghost = mirror.checker("ns:ghost", "g1");
        assertEquals(Answer.YES, ghost.can("chat.color"));
        PermissionCheckResult none = ghost.excludingRoles(Set.of("member")).check("chat.color").orElseThrow();
        assertEquals(PermissionSource.DEFAULT, none.source());
        assertEquals(Set.of(), ghost.excludingRoles(Set.of("member")).grantedKeys().orElseThrow());
        assertEquals(Answer.YES, ghost.excludingRoles(STAFF).can("chat.color"));
    }

    @Test
    void theDerivedCheckerKeepsTheBaseShape() {
        MemberChecker base = mirror.checker("ns:u1", "g1", PVP);
        MemberChecker capped = base.excludingRoles(STAFF);
        assertEquals(PVP, capped.context());
        assertEquals("ns:u1", capped.userId());
        assertEquals("g1", capped.groupId());
        assertEquals(Set.of(), base.excludedRoles());
        assertSame(base, base.excludingRoles(Set.of()), "nothing new to exclude");
        assertSame(capped, capped.excludingRoles(STAFF));
        assertTrue(mirror.checker("ns:nobody", "g1").excludingRoles(STAFF).check("x").isEmpty(), "unknown stays unknown");
        assertThrows(NullPointerException.class, () -> base.excludingRoles(null));
        assertThrows(NullPointerException.class, () -> base.excludingRoles(Arrays.asList("staff", null)));
    }

    // What the server's check answers for the member with no overrides and the excluded roles removed.
    PermissionCheckResult withoutOverrides(String userId, Set<String> excluded, String permission, Context context) {
        MemberAccess a = mirror.access(userId, "g1").orElseThrow();
        List<String> kept = a.roleIds().stream().filter(r -> !excluded.contains(r)).toList();
        MemberAccess without = new MemberAccess(
                a.groupId(), a.userId(), a.status(), kept, List.of(), a.version(), a.displayName(), a.metadata());
        return PermissionResolver.compile(mirror.roleGraph("g1").orElseThrow(), WORLDS)
                .check(without, permission, context);
    }

    @Test
    void excludingOverridesEqualsTheResolverWithNoOverridesInEitherOrder() {
        List<Set<String>> exclusions = List.of(Set.of(), STAFF, Set.of("staff", "helper"), Set.of("vip"),
                Set.of("staff", "vip", "helper", "member"));
        for (String user : List.of("ns:u1", "ns:u2")) {
            for (Context c : Arrays.asList(Context.GLOBAL, WORLD, PVP, CREATIVE)) {
                for (Set<String> excluded : exclusions) {
                    MemberChecker base = mirror.checker(user, "g1", c);
                    MemberChecker rolesFirst = base.excludingRoles(excluded).excludingOverrides();
                    MemberChecker overridesFirst = base.excludingOverrides().excludingRoles(excluded);
                    for (String p : PERMISSIONS) {
                        PermissionCheckResult expected = withoutOverrides(user, excluded, p, c);
                        String what = user + " without overrides and " + excluded + ": " + p + " in " + c;
                        assertEquals(expected, rolesFirst.check(p).orElseThrow(), what);
                        assertEquals(expected, overridesFirst.check(p).orElseThrow(), what);
                    }
                }
            }
        }
    }

    @Test
    void excludingOverridesDropsOnlyTheOverridesLayer() {
        MemberChecker base = mirror.checker("ns:u1", "g1", PVP);
        MemberChecker plain = base.excludingOverrides();
        assertEquals(PermissionSource.OVERRIDE, base.check("mod.ban").orElseThrow().source());
        assertEquals(PermissionSource.DEFAULT, plain.check("mod.ban").orElseThrow().source());
        assertEquals(Answer.NO, base.can("essentials.fly"), "the contextual override denies in pvpworld");
        PermissionCheckResult fly = plain.check("essentials.fly").orElseThrow();
        assertTrue(fly.allowed(), "pvpworld inherits staff's entry for world");
        assertEquals("staff", fly.viaRoleId());
        assertEquals(WORLD, fly.context());
        assertEquals(Answer.YES, base.can("mod.ban"), "the checker it came from is unchanged");
        assertEquals(Answer.NO, plain.excludingRoles(STAFF).can("essentials.fly"));
    }

    @Test
    void excludingOverridesKeepsTheShapeAndComposes() {
        MemberChecker base = mirror.checker("ns:u1", "g1", PVP);
        MemberChecker plain = base.excludingOverrides();
        assertFalse(base.excludesOverrides());
        assertTrue(plain.excludesOverrides());
        assertSame(plain, plain.excludingOverrides());
        assertEquals(PVP, plain.context());
        assertEquals("ns:u1", plain.userId());
        assertEquals("g1", plain.groupId());
        assertEquals(Set.of(), plain.excludedRoles());

        MemberChecker capped = base.excludingRoles(STAFF);
        MemberChecker both = capped.excludingOverrides();
        assertFalse(capped.excludesOverrides());
        assertTrue(both.excludesOverrides());
        assertEquals(STAFF, both.excludedRoles());
        assertTrue(plain.excludingRoles(STAFF).excludesOverrides(), "excluding roles keeps the override exclusion");
        assertEquals(STAFF, plain.excludingRoles(STAFF).excludedRoles());
        assertTrue(mirror.checker("ns:nobody", "g1").excludingOverrides().check("x").isEmpty(),
                "unknown stays unknown");
    }

    @Test
    void grantedKeysLeaveOutKeysOnlyTheOverridesNamed() {
        assertEquals(Set.of("cosmetic.*", "essentials.fly", "mod.kick", "warp.*"),
                mirror.checker("ns:u1", "g1", WORLD).excludingOverrides().grantedKeys().orElseThrow());
        assertEquals(Set.of("chat.color", "cosmetic.*", "warp.*"),
                mirror.checker("ns:u1", "g1", WORLD).excludingRoles(STAFF).excludingOverrides().grantedKeys()
                        .orElseThrow());
        assertEquals(Set.of("cosmetic.*", "mod.ban", "mod.kick", "warp.*"),
                mirror.checker("ns:u1", "g1", PVP).grantedKeys().orElseThrow());
        assertEquals(Set.of("cosmetic.*", "essentials.fly", "mod.kick", "warp.*"),
                mirror.checker("ns:u1", "g1", PVP).excludingOverrides().grantedKeys().orElseThrow());
    }

    @Test
    void excludingOverridesKeepsTheStatusGate() throws Exception {
        accessByUser.put("ns:u3", """
                {"groupId":"g1","userId":"ns:u3","status":"banned","roleIds":["staff"],"overrides":[%s],
                 "version":1}""".formatted(override("ns:u3", "mod.ban", true, null)));
        join(mirror.track("ns:u3", "g1"));
        PermissionCheckResult r = mirror.checker("ns:u3", "g1").excludingOverrides().check("mod.kick").orElseThrow();
        assertFalse(r.allowed());
        assertEquals(PermissionSource.NONE, r.source());
        assertEquals(Answer.NO, mirror.checker("ns:u3", "g1").excludingOverrides().can("mod.ban"));
    }
}
