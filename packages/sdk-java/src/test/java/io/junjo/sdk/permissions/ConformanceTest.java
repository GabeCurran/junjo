package io.junjo.sdk.permissions;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.DynamicTest.dynamicTest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.MemberPermissionOverride;
import io.junjo.sdk.model.MemberStatus;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.PermissionMode;
import io.junjo.sdk.model.PermissionSource;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.model.RoleGraph;
import io.junjo.sdk.permissions.PermissionResolver.ResolverRole;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/** Runs the shared conformance vectors that the server's resolver also passes. */
class ConformanceTest {
    static JsonObject vectors() throws Exception {
        String path = System.getProperty("junjo.conformance.vectors");
        Path p = path != null ? Path.of(path) : Path.of("../shared/conformance/permission-vectors.json");
        return JsonParser.parseString(Files.readString(p, StandardCharsets.UTF_8)).getAsJsonObject();
    }

    static PermissionMode mode(String m) {
        return PermissionMode.fromWire(m);
    }

    static Map<String, Boolean> normalized(PermissionMode mode, JsonObject entries) {
        Map<String, Boolean> out = new HashMap<>();
        if (entries == null) return out;
        for (Map.Entry<String, JsonElement> e : entries.entrySet()) {
            out.put(PermissionResolver.normalizeKey(mode, e.getKey()), e.getValue().getAsBoolean());
        }
        return out;
    }

    static List<String> strings(JsonArray a) {
        List<String> out = new ArrayList<>();
        if (a != null) for (JsonElement e : a) out.add(e.getAsString());
        return out;
    }

    @Test
    void supportedVersion() throws Exception {
        assertEquals(1, vectors().get("version").getAsInt());
    }

    @TestFactory
    Stream<DynamicTest> cases() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonElement el : vectors().getAsJsonArray("cases")) {
            JsonObject vc = el.getAsJsonObject();
            for (JsonElement m : vc.getAsJsonArray("modes")) {
                PermissionMode mode = mode(m.getAsString());
                tests.add(dynamicTest("[" + mode.wire() + "] " + vc.get("name").getAsString(),
                        () -> runCase(vc, mode)));
            }
        }
        assertFalse(tests.isEmpty());
        return tests.stream();
    }

    static void runCase(JsonObject vc, PermissionMode mode) {
        Map<String, ResolverRole> roles = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> r : vc.getAsJsonObject("roles").entrySet()) {
            JsonObject role = r.getValue().getAsJsonObject();
            roles.put(r.getKey(), new ResolverRole(
                    role.get("priority").getAsLong(),
                    normalized(mode, role.getAsJsonObject("entries")),
                    strings(role.getAsJsonArray("parents"))));
        }
        JsonObject member = vc.getAsJsonObject("member");
        Map<String, Boolean> overrides = normalized(mode, member.getAsJsonObject("overrides"));
        List<String> direct = strings(member.getAsJsonArray("roles"));
        for (JsonElement c : vc.getAsJsonArray("checks")) {
            JsonObject check = c.getAsJsonObject();
            String permission = check.get("permission").getAsString();
            PermissionCheckResult r = PermissionResolver.resolve(mode, overrides, direct, roles, permission);
            assertEquals(check.get("allowed").getAsBoolean(), r.allowed(), permission + " allowed");
            assertEquals(check.get("source").getAsString(), r.source().wire(), permission + " source");
            String via = check.has("via") ? check.get("via").getAsString() : null;
            assertEquals(via, r.viaRoleId(), permission + " via");

            // The compiled path (role graph + member access) must agree with the raw resolver.
            PermissionCheckResult compiled = compiledCheck(vc, mode, permission);
            assertEquals(r, compiled, permission + " compiled");
        }
    }

    static PermissionCheckResult compiledCheck(JsonObject vc, PermissionMode mode, String permission) {
        Instant t = Instant.EPOCH;
        List<Role> roles = new ArrayList<>();
        for (Map.Entry<String, JsonElement> r : vc.getAsJsonObject("roles").entrySet()) {
            JsonObject role = r.getValue().getAsJsonObject();
            List<PermissionEntry> entries = new ArrayList<>();
            for (Map.Entry<String, JsonElement> e : role.getAsJsonObject("entries").entrySet()) {
                entries.add(new PermissionEntry(e.getKey(), e.getValue().getAsBoolean()));
            }
            roles.add(new Role(r.getKey(), "g", r.getKey(), role.get("priority").getAsLong(), null, false, List.of(),
                    entries, strings(role.getAsJsonArray("parents")), Map.of(), t));
        }
        JsonObject member = vc.getAsJsonObject("member");
        List<MemberPermissionOverride> overrides = new ArrayList<>();
        JsonObject o = member.getAsJsonObject("overrides");
        if (o != null) {
            for (Map.Entry<String, JsonElement> e : o.entrySet()) {
                overrides.add(new MemberPermissionOverride("g", "u", e.getKey(), e.getValue().getAsBoolean(), t, null));
            }
        }
        MemberAccess access = new MemberAccess("g", "u", MemberStatus.ACTIVE, strings(member.getAsJsonArray("roles")),
                overrides, 1, null, null);
        return PermissionResolver.compile(new RoleGraph("g", mode, null, roles)).check(access, permission);
    }

    @TestFactory
    Stream<DynamicTest> keys() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonElement el : vectors().getAsJsonArray("keys")) {
            JsonObject kv = el.getAsJsonObject();
            PermissionMode mode = mode(kv.get("mode").getAsString());
            String key = kv.get("key").getAsString();
            boolean valid = kv.get("valid").getAsBoolean();
            tests.add(dynamicTest("[" + mode.wire() + "] key " + key + " valid=" + valid,
                    () -> assertEquals(valid, PermissionResolver.validateKey(mode, key).isEmpty())));
        }
        return tests.stream();
    }

    @TestFactory
    Stream<DynamicTest> graphs() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonElement el : vectors().getAsJsonArray("graphs")) {
            JsonObject gv = el.getAsJsonObject();
            Map<String, List<String>> parents = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> e : gv.getAsJsonObject("parents").entrySet()) {
                parents.put(e.getKey(), strings(e.getValue().getAsJsonArray()));
            }
            boolean valid = gv.get("valid").getAsBoolean();
            tests.add(dynamicTest("graph " + gv.get("name").getAsString(),
                    () -> assertEquals(valid, PermissionResolver.findRoleCycle(parents).isEmpty())));
        }
        return tests.stream();
    }

    @Test
    void candidateKeysMatchTheServer() {
        assertEquals(List.of("a.b.c", "a.b.*", "a.*", "*"),
                PermissionResolver.candidateKeys(PermissionMode.NODES, "A.b.C"));
        assertEquals(List.of("A.b.*"), PermissionResolver.candidateKeys(PermissionMode.EXACT, "A.b.*"));
        assertEquals(List.of("a.*", "*"), PermissionResolver.candidateKeys(PermissionMode.NODES, "a.*"));
        assertEquals(List.of("*"), PermissionResolver.candidateKeys(PermissionMode.NODES, "*"));
    }

    @Test
    void emptySegmentsAreRejectedInNodesMode() {
        for (String k : List.of("a..b", ".a", "a.")) {
            assertTrue(PermissionResolver.validateKey(PermissionMode.NODES, k).isPresent(), k);
            assertTrue(PermissionResolver.validateKey(PermissionMode.EXACT, k).isEmpty(), k);
        }
    }

    @Test
    void foldingIsAsciiOnlyAndLocaleIndependent() {
        Locale saved = Locale.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag("tr-TR"));
            assertEquals("title.item", PermissionResolver.normalizeKey(PermissionMode.NODES, "TITLE.ITEM"));
        } finally {
            Locale.setDefault(saved);
        }
        // KELVIN SIGN folds to 'k' under Locale.ROOT but not on the server; it must not match "kick".
        String kelvin = "Kick";
        assertEquals(kelvin, PermissionResolver.normalizeKey(PermissionMode.NODES, kelvin));
        Map<String, ResolverRole> roles = Map.of("r", new ResolverRole(1, Map.of("kick", true), List.of()));
        PermissionCheckResult r = PermissionResolver.resolve(PermissionMode.NODES, Map.of(), List.of("r"),
                roles, kelvin);
        assertEquals(PermissionSource.DEFAULT, r.source());
    }

    @Test
    void inactiveMemberAnswersNone() {
        RoleGraph g = new RoleGraph("g", PermissionMode.EXACT, null, List.of(new Role("r", "g", "R", 1, null, false,
                List.of("a"), List.of(PermissionEntry.grant("a")), List.of(), Map.of(), Instant.EPOCH)));
        MemberAccess left = new MemberAccess("g", "u", MemberStatus.LEFT, List.of("r"), List.of(), 2, null, null);
        PermissionCheckResult r = PermissionResolver.compile(g).check(left, "a");
        assertEquals(PermissionCheckResult.of(false, PermissionSource.NONE), r);
    }
}
