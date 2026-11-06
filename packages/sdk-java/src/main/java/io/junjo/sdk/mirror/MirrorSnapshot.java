package io.junjo.sdk.mirror;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import io.junjo.sdk.internal.DurableFiles;
import io.junjo.sdk.internal.Json;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.mirror.GameMirror.GroupState;
import io.junjo.sdk.mirror.GameMirror.MemberEntry;
import io.junjo.sdk.mirror.GameMirror.MemberKey;
import io.junjo.sdk.mirror.GameMirror.Person;
import io.junjo.sdk.mirror.GameMirror.RetainedMember;
import io.junjo.sdk.mirror.GameMirror.SanctionState;
import io.junjo.sdk.mirror.GameMirror.State;
import io.junjo.sdk.model.Ban;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.MemberPermissionOverride;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.model.RoleGraph;
import io.junjo.sdk.model.Sanction;
import io.junjo.sdk.permissions.ContextInheritance;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.BiFunction;

/**
 * The mirror's state file: one checksummed JSON line (see {@link DurableFiles}) holding the
 * position, role graphs, bans, sanctions, loaded tracked members, known people and the server's
 * context inheritance. Models are written in their wire shape, so the SDK's wire decoders read
 * them back. Members still loading are not saved. Retained members are saved apart from tracked
 * ones, each with the time it was last tracked. The retained members and the inheritance are
 * optional fields, so a file written without them loads with none retained and no inheritance.
 */
final class MirrorSnapshot {
    static final String FORMAT = "junjo-mirror";
    static final int VERSION = 1;

    private MirrorSnapshot() {}

    static void save(Path file, State s, DurableFiles.Disk disk) throws IOException {
        JsonObject o = new JsonObject();
        o.addProperty("format", FORMAT);
        o.addProperty("version", VERSION);
        o.addProperty("savedAt", Instant.now().toString());
        o.addProperty("position", s.position());
        o.add("contexts", Wire.contextsJson(s.contexts()));
        JsonArray groups = new JsonArray();
        for (GroupState g : s.groups().values()) groups.add(graph(g.graph()));
        o.add("groups", groups);
        JsonArray bans = new JsonArray();
        for (Ban b : s.bans().values()) bans.add(ban(b));
        o.add("bans", bans);
        o.add("banVersions", Json.toJson(s.moderationVersions()));
        JsonArray sanctions = new JsonArray();
        for (Map<String, Sanction> byType : s.sanctions().byUser().values()) {
            for (Sanction x : byType.values()) sanctions.add(sanction(x));
        }
        o.add("sanctions", sanctions);
        o.add("sanctionVersions", Json.toJson(s.sanctions().versions()));
        JsonArray members = new JsonArray();
        for (Map.Entry<MemberKey, MemberEntry> e : s.members().entrySet()) {
            if (!e.getValue().loaded()) continue;
            JsonObject m = new JsonObject();
            m.addProperty("groupId", e.getKey().groupId());
            m.addProperty("userId", e.getKey().userId());
            m.add("access", e.getValue().access() == null ? JsonNull.INSTANCE : access(e.getValue().access()));
            members.add(m);
        }
        o.add("members", members);
        JsonArray retained = new JsonArray();
        for (Map.Entry<MemberKey, RetainedMember> e : s.retained().entrySet()) {
            JsonObject m = new JsonObject();
            m.addProperty("groupId", e.getKey().groupId());
            m.addProperty("userId", e.getKey().userId());
            m.add("access", e.getValue().access() == null ? JsonNull.INSTANCE : access(e.getValue().access()));
            m.addProperty("lastConnectedAt", e.getValue().lastConnectedAt().toString());
            retained.add(m);
        }
        o.add("retained", retained);
        JsonArray people = new JsonArray();
        for (Person p : new HashSet<>(s.people().values())) {
            JsonObject j = new JsonObject();
            j.add("ids", Json.stringArray(p.ids()));
            j.addProperty("rendered", p.rendered());
            people.add(j);
        }
        o.add("people", people);
        o.add("renderedIds", Json.stringArray(s.renderedIds()));
        String text = DurableFiles.line(Json.GSON.toJson(o));
        DurableFiles.replaceAtomically(file, text.getBytes(StandardCharsets.UTF_8), disk);
    }

    /**
     * Empty when the file does not exist. Each graph is compiled with the saved server inheritance.
     *
     * @throws IOException when it cannot be read
     * @throws RuntimeException when it fails its checksum, is not a mirror snapshot of this
     *     version, or is malformed
     */
    static Optional<State> load(Path file, BiFunction<RoleGraph, ContextInheritance, GroupState> compile)
            throws IOException {
        if (!Files.exists(file)) return Optional.empty();
        String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8).strip();
        JsonObject o = DurableFiles.parseLine(text);
        if (!FORMAT.equals(Json.optStr(o, "format")) || Json.optLong(o, "version", -1) != VERSION) {
            throw new IllegalStateException("not a version " + VERSION + " mirror snapshot");
        }
        // One draft for the whole file, so each map is built once rather than copied per entry.
        ContextInheritance contexts = Wire.contexts(o);
        GameMirror.Draft d = State.EMPTY.edit().position(Json.str(o, "position")).contexts(contexts);
        for (JsonObject g : Json.objects(Json.arr(o, "groups"), "groups")) {
            RoleGraph graph = Wire.roleGraph(g);
            d.putGroup(graph.groupId(), compile.apply(graph, contexts));
        }
        List<Ban> bans = new ArrayList<>();
        for (JsonObject b : Json.objects(Json.arr(o, "bans"), "bans")) bans.add(ban(b));
        Map<String, Long> banVersions = longs(Json.obj(o, "banVersions"));
        // The bans record their ids as rendered; the saved versions then replace the derived ones.
        d.replaceBans(bans);
        Map<String, Ban> byUser = new HashMap<>();
        for (Ban b : bans) byUser.put(b.userId(), b);
        d.banMaps(byUser, banVersions);
        List<Sanction> sanctions = new ArrayList<>();
        for (JsonObject x : Json.objects(Json.arr(o, "sanctions"), "sanctions")) sanctions.add(sanction(x));
        SanctionState st = SanctionState.of(sanctions);
        d.sanctions(new SanctionState(st.byUser(), longs(Json.obj(o, "sanctionVersions"))));
        for (JsonObject m : Json.objects(Json.arr(o, "members"), "members")) {
            JsonObject a = Json.optObj(m, "access");
            MemberAccess access = a == null ? null : Wire.access(a);
            d.putMember(new MemberKey(Json.str(m, "groupId"), Json.str(m, "userId")),
                    new MemberEntry(true, access, access == null ? 0 : access.version()));
        }
        JsonArray retained = Json.optArr(o, "retained");
        if (retained != null) {
            for (JsonObject m : Json.objects(retained, "retained")) {
                JsonObject a = Json.optObj(m, "access");
                d.putRetained(new MemberKey(Json.str(m, "groupId"), Json.str(m, "userId")),
                        new RetainedMember(a == null ? null : Wire.access(a), Json.instant(m, "lastConnectedAt")));
            }
        }
        for (JsonObject p : Json.objects(Json.arr(o, "people"), "people")) {
            d.person(new Person(Json.strList(p, "ids"), Json.optStr(p, "rendered")));
        }
        for (String id : Json.strList(o, "renderedIds")) d.rendered(id);
        return Optional.of(d.markReady().freeze());
    }

    private static Map<String, Long> longs(JsonObject o) {
        Map<String, Long> out = new HashMap<>();
        for (String k : o.keySet()) out.put(k, Json.lng(o, k));
        return out;
    }

    private static JsonObject graph(RoleGraph g) {
        JsonObject o = new JsonObject();
        o.addProperty("groupId", g.groupId());
        o.addProperty("mode", g.mode().wire());
        o.addProperty("defaultRoleId", g.defaultRoleId());
        JsonArray roles = new JsonArray();
        for (Role r : g.roles()) {
            JsonObject j = new JsonObject();
            j.addProperty("id", r.id());
            j.addProperty("groupId", r.groupId());
            j.addProperty("name", r.name());
            j.addProperty("priority", r.priority());
            j.addProperty("color", r.color());
            j.addProperty("isDefault", r.isDefault());
            j.add("permissions", Json.stringArray(r.permissions()));
            JsonArray entries = new JsonArray();
            for (PermissionEntry e : r.entries()) {
                JsonObject en = new JsonObject();
                en.addProperty("permission", e.permission());
                en.addProperty("value", e.value());
                if (!e.context().isGlobal()) en.add("context", Json.toJson(e.context()));
                entries.add(en);
            }
            j.add("entries", entries);
            j.add("parents", Json.stringArray(r.parents()));
            j.add("metadata", Json.toJson(r.metadata()));
            j.addProperty("createdAt", r.createdAt().toString());
            roles.add(j);
        }
        o.add("roles", roles);
        o.add("contexts", Wire.contextsJson(g.contexts()));
        return o;
    }

    private static JsonObject access(MemberAccess a) {
        JsonObject o = new JsonObject();
        o.addProperty("groupId", a.groupId());
        o.addProperty("userId", a.userId());
        o.addProperty("status", a.status().wire());
        o.add("roleIds", Json.stringArray(a.roleIds()));
        JsonArray overrides = new JsonArray();
        for (MemberPermissionOverride x : a.overrides()) {
            JsonObject j = new JsonObject();
            j.addProperty("groupId", x.groupId());
            j.addProperty("userId", x.userId());
            j.addProperty("permission", x.permission());
            j.addProperty("grant", x.grant());
            if (!x.context().isGlobal()) j.add("context", Json.toJson(x.context()));
            j.addProperty("setAt", x.setAt().toString());
            j.addProperty("setBy", x.setBy());
            overrides.add(j);
        }
        o.add("overrides", overrides);
        o.addProperty("version", a.version());
        o.addProperty("displayName", a.displayName());
        o.add("metadata", Json.toJson(a.metadata()));
        return o;
    }

    private static JsonObject ban(Ban b) {
        JsonObject o = new JsonObject();
        o.addProperty("id", b.id());
        o.addProperty("gameId", b.gameId());
        o.addProperty("userId", b.userId());
        o.addProperty("bannedAt", text(b.bannedAt()));
        o.addProperty("expiresAt", text(b.expiresAt()));
        o.addProperty("reason", b.reason());
        o.addProperty("bannedBy", b.bannedBy());
        o.addProperty("issuer", b.issuer());
        o.addProperty("version", b.version());
        return o;
    }

    // Bans and sanctions built from events have no id, so these are read leniently.
    private static Ban ban(JsonObject o) {
        return new Ban(Json.optStr(o, "id"), Json.optStr(o, "gameId"), Json.str(o, "userId"),
                Json.optInstant(o, "bannedAt"), Json.optInstant(o, "expiresAt"), Json.optStr(o, "reason"),
                Json.optStr(o, "bannedBy"), Json.optStr(o, "issuer"), Json.optLong(o, "version", 0));
    }

    private static JsonObject sanction(Sanction x) {
        JsonObject o = new JsonObject();
        o.addProperty("id", x.id());
        o.addProperty("userId", x.userId());
        o.addProperty("type", x.type());
        o.addProperty("reason", x.reason());
        o.addProperty("issuer", x.issuer());
        o.addProperty("issuedBy", x.issuedBy());
        o.addProperty("startedAt", text(x.startedAt()));
        o.addProperty("expiresAt", text(x.expiresAt()));
        o.addProperty("version", x.version());
        return o;
    }

    private static Sanction sanction(JsonObject o) {
        return new Sanction(Json.optStr(o, "id"), Json.str(o, "userId"), Json.str(o, "type"), Json.optStr(o, "reason"),
                Json.optStr(o, "issuer"), Json.optStr(o, "issuedBy"), Json.instant(o, "startedAt"),
                Json.optInstant(o, "expiresAt"), Json.optLong(o, "version", 0));
    }

    private static String text(Instant t) {
        return t == null ? null : t.toString();
    }
}
