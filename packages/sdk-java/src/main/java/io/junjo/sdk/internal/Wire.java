package io.junjo.sdk.internal;

import static io.junjo.sdk.internal.Json.arr;
import static io.junjo.sdk.internal.Json.bool;
import static io.junjo.sdk.internal.Json.instant;
import static io.junjo.sdk.internal.Json.lng;
import static io.junjo.sdk.internal.Json.map;
import static io.junjo.sdk.internal.Json.objects;
import static io.junjo.sdk.internal.Json.optArr;
import static io.junjo.sdk.internal.Json.optInstant;
import static io.junjo.sdk.internal.Json.optLong;
import static io.junjo.sdk.internal.Json.optObj;
import static io.junjo.sdk.internal.Json.optStr;
import static io.junjo.sdk.internal.Json.str;
import static io.junjo.sdk.internal.Json.strList;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.junjo.sdk.model.Ban;
import io.junjo.sdk.model.BanHistoryEntry;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.DisplayNameMatch;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.GroupBatchOp;
import io.junjo.sdk.model.GroupBatchResponse;
import io.junjo.sdk.model.GroupBatchResult;
import io.junjo.sdk.model.GroupRelationship;
import io.junjo.sdk.model.IdentityLinkResult;
import io.junjo.sdk.model.IdentityUnlinkResult;
import io.junjo.sdk.model.ImportResult;
import io.junjo.sdk.model.Invitation;
import io.junjo.sdk.model.LinkCode;
import io.junjo.sdk.model.LinkedIdentity;
import io.junjo.sdk.model.Member;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.MemberPermissionOverride;
import io.junjo.sdk.model.MemberStatus;
import io.junjo.sdk.model.Moderation;
import io.junjo.sdk.model.Page;
import io.junjo.sdk.model.PermissionConfig;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.PermissionMode;
import io.junjo.sdk.model.PermissionSource;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.model.RoleGraph;
import io.junjo.sdk.model.Sanction;
import io.junjo.sdk.model.SanctionHistoryEntry;
import io.junjo.sdk.permissions.ContextInheritance;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Decoders from wire JSON to the model records. Fields added by newer servers are tolerated;
 * fields a newer server added that older ones omit (versions, issuer) default to 0 or null.
 *
 * <p>Internal: not part of the supported API.
 */
public final class Wire {
    private Wire() {}

    /** Decodes a group. */
    public static Group group(JsonObject o) {
        return new Group(
                str(o, "id"),
                str(o, "gameId"),
                str(o, "kind"),
                str(o, "name"),
                str(o, "visibility"),
                map(o, "metadata"),
                optStr(o, "defaultRoleId"),
                optStr(o, "parentGroupId"),
                optLong(o, "memberCount", 0),
                Json.optBool(o, "hasPasscode", false),
                instant(o, "createdAt"),
                instant(o, "updatedAt"),
                optInstant(o, "softDeletedAt"),
                optStr(o, "version"));
    }

    /** Decodes a member. */
    public static Member member(JsonObject o) {
        return new Member(
                str(o, "id"),
                str(o, "groupId"),
                str(o, "userId"),
                MemberStatus.fromWire(str(o, "status")),
                strList(o, "roles"),
                map(o, "metadata"),
                optStr(o, "notesPublic"),
                optStr(o, "notesPrivate"),
                instant(o, "joinedAt"),
                optInstant(o, "bannedUntil"),
                optLong(o, "version", 0),
                optStr(o, "displayName"));
    }

    /** Decodes a member override. */
    public static MemberPermissionOverride override(JsonObject o) {
        return new MemberPermissionOverride(
                str(o, "groupId"),
                str(o, "userId"),
                str(o, "permission"),
                bool(o, "grant"),
                instant(o, "setAt"),
                optStr(o, "setBy"),
                context(o));
    }

    /** Decodes a member's access. */
    public static MemberAccess access(JsonObject o) {
        return new MemberAccess(
                str(o, "groupId"),
                str(o, "userId"),
                MemberStatus.fromWire(str(o, "status")),
                strList(o, "roleIds"),
                list(arr(o, "overrides"), "overrides", Wire::override),
                optLong(o, "version", 0),
                optStr(o, "displayName"),
                map(o, "metadata"));
    }

    /** Decodes a role. */
    public static Role role(JsonObject o) {
        List<PermissionEntry> entries = new ArrayList<>();
        JsonArray rawEntries = optArr(o, "entries");
        if (rawEntries != null) {
            for (JsonObject e : objects(rawEntries, "entries")) {
                entries.add(new PermissionEntry(str(e, "permission"), bool(e, "value"), context(e)));
            }
        }
        return new Role(
                str(o, "id"),
                str(o, "groupId"),
                str(o, "name"),
                lng(o, "priority"),
                optStr(o, "color"),
                Json.optBool(o, "isDefault", false),
                strList(o, "permissions"),
                entries,
                strList(o, "parents"),
                map(o, "metadata"),
                instant(o, "createdAt"));
    }

    /**
     * Decodes a role graph. An absent {@code contexts} field, as older servers send, reads as
     * {@link ContextInheritance#NONE}.
     */
    public static RoleGraph roleGraph(JsonObject o) {
        return new RoleGraph(str(o, "groupId"), mode(o), optStr(o, "defaultRoleId"),
                list(arr(o, "roles"), "roles", Wire::role), contexts(o));
    }

    /** Decodes a game's permission config. */
    public static PermissionConfig permissionConfig(JsonObject o) {
        return new PermissionConfig(mode(o), contexts(o));
    }

    /** Decodes the required {@code mode} field. */
    public static PermissionMode mode(JsonObject o) {
        try {
            return PermissionMode.fromWire(str(o, "mode"));
        } catch (IllegalArgumentException e) {
            throw Json.wire("unknown permission mode '" + optStr(o, "mode") + "'");
        }
    }

    /**
     * Decodes an optional {@code contexts} field: context key to {@code { inherit: { value:
     * [parents] } }}. Absent, null or empty is {@link ContextInheritance#NONE}; a key without an
     * {@code inherit} map declares nothing. Fields beside {@code inherit} are ignored. A table the
     * server's config rules refuse is malformed wire data.
     */
    public static ContextInheritance contexts(JsonObject o) {
        JsonObject c = optObj(o, "contexts");
        if (c == null || c.isEmpty()) return ContextInheritance.NONE;
        Map<String, Map<String, List<String>>> table = new LinkedHashMap<>();
        for (String key : c.keySet()) {
            JsonObject entry = optObj(c, key);
            JsonObject inherit = entry == null ? null : optObj(entry, "inherit");
            Map<String, List<String>> values = new LinkedHashMap<>();
            if (inherit != null) {
                for (String value : inherit.keySet()) values.put(value, strList(inherit, value));
            }
            if (!values.isEmpty()) table.put(key, values);
        }
        try {
            return ContextInheritance.of(table);
        } catch (IllegalArgumentException e) {
            throw Json.wire("invalid context inheritance: " + e.getMessage());
        }
    }

    /** Encodes an inheritance in the wire shape {@link #contexts(JsonObject)} reads. */
    public static JsonObject contextsJson(ContextInheritance inheritance) {
        JsonObject out = new JsonObject();
        inheritance.inherit().forEach((key, values) -> {
            JsonObject inherit = new JsonObject();
            values.forEach((value, parents) -> inherit.add(value, Json.stringArray(parents)));
            JsonObject entry = new JsonObject();
            entry.add("inherit", inherit);
            out.add(key, entry);
        });
        return out;
    }

    /** Decodes a permission check result. */
    public static PermissionCheckResult checkResult(JsonObject o) {
        return new PermissionCheckResult(
                bool(o, "allowed"),
                PermissionSource.fromWire(str(o, "source")),
                optStr(o, "viaRoleId"),
                optStr(o, "viaGroupId"),
                context(o));
    }

    /**
     * Decodes an optional {@code context} object of string values; absent, null or empty is
     * {@link Context#GLOBAL}.
     */
    public static Context context(JsonObject o) {
        JsonObject c = optObj(o, "context");
        if (c == null || c.isEmpty()) return Context.GLOBAL;
        Map<String, String> values = new LinkedHashMap<>();
        for (String key : c.keySet()) {
            String value = optStr(c, key);
            if (value == null) throw Json.wire("context value for '" + key + "' is not a string");
            values.put(key, value);
        }
        return Context.fromWire(values);
    }

    /** Decodes a game ban. */
    public static Ban ban(JsonObject o) {
        return new Ban(
                str(o, "id"),
                str(o, "gameId"),
                str(o, "userId"),
                instant(o, "bannedAt"),
                optInstant(o, "expiresAt"),
                optStr(o, "reason"),
                optStr(o, "bannedBy"),
                optStr(o, "issuer"),
                optLong(o, "version", 0));
    }

    /** Decodes a ban history entry. */
    public static BanHistoryEntry banHistory(JsonObject o) {
        return new BanHistoryEntry(
                str(o, "id"),
                str(o, "gameId"),
                str(o, "userId"),
                str(o, "scope"),
                optStr(o, "groupId"),
                str(o, "kind"),
                optStr(o, "reason"),
                optInstant(o, "expiresAt"),
                instant(o, "eventAt"),
                optStr(o, "actorUserId"),
                optStr(o, "issuer"));
    }

    /** Decodes a moderation state. */
    public static Moderation moderation(JsonObject o) {
        JsonObject ban = optObj(o, "ban");
        JsonArray sanctions = optArr(o, "sanctions");
        return new Moderation(str(o, "userId"), optLong(o, "version", 0), ban == null ? null : ban(ban),
                sanctions == null ? List.of() : list(sanctions, "sanctions", Wire::sanction));
    }

    /** Decodes a linked identity. */
    public static LinkedIdentity linkedIdentity(JsonObject o) {
        return new LinkedIdentity(
                str(o, "userId"), optStr(o, "namespace"), instant(o, "linkedAt"), optStr(o, "displayName"));
    }

    /** Decodes a sanction. */
    public static Sanction sanction(JsonObject o) {
        return new Sanction(
                str(o, "id"),
                str(o, "userId"),
                str(o, "type"),
                optStr(o, "reason"),
                optStr(o, "issuer"),
                optStr(o, "issuedBy"),
                instant(o, "startedAt"),
                optInstant(o, "expiresAt"),
                optLong(o, "version", 0));
    }

    /** Decodes a sanction history entry. */
    public static SanctionHistoryEntry sanctionHistory(JsonObject o) {
        return new SanctionHistoryEntry(
                str(o, "id"),
                str(o, "gameId"),
                str(o, "userId"),
                str(o, "type"),
                str(o, "kind"),
                optStr(o, "reason"),
                optInstant(o, "expiresAt"),
                instant(o, "eventAt"),
                optStr(o, "actorUserId"),
                optStr(o, "issuer"));
    }

    /** Decodes a display name match. */
    public static DisplayNameMatch displayNameMatch(JsonObject o) {
        return new DisplayNameMatch(str(o, "userId"), str(o, "displayName"), instant(o, "displayNameUpdatedAt"));
    }

    /** Decodes a link code. */
    public static LinkCode linkCode(JsonObject o) {
        return new LinkCode(str(o, "code"), instant(o, "expiresAt"));
    }

    /** Decodes a link result. */
    public static IdentityLinkResult linkResult(JsonObject o) {
        return new IdentityLinkResult(
                str(o, "userId"),
                str(o, "linkedUserId"),
                list(arr(o, "identities"), "identities", Wire::linkedIdentity));
    }

    /** Decodes an unlink result. */
    public static IdentityUnlinkResult unlinkResult(JsonObject o) {
        return new IdentityUnlinkResult(
                str(o, "userId"),
                str(o, "unlinkedUserId"),
                list(arr(o, "identities"), "identities", Wire::linkedIdentity));
    }

    /** Decodes an invitation. */
    public static Invitation invitation(JsonObject o) {
        return new Invitation(
                str(o, "id"),
                str(o, "groupId"),
                str(o, "code"),
                optStr(o, "roleId"),
                optStr(o, "targetUserId"),
                optStr(o, "createdBy"),
                instant(o, "createdAt"),
                optInstant(o, "expiresAt"),
                optInstant(o, "usedAt"),
                optStr(o, "usedBy"));
    }

    /** Decodes a group relationship. */
    public static GroupRelationship relationship(JsonObject o) {
        return new GroupRelationship(
                str(o, "groupAId"), str(o, "groupBId"), str(o, "type"), instant(o, "since"), optStr(o, "setBy"));
    }

    /**
     * Decodes a group batch's answer for the ops that were sent. Each result is read as the kind
     * its op answers; a null result reads as {@link GroupBatchResult#NONE}. A result count that
     * differs from the op count is malformed wire data.
     */
    public static GroupBatchResponse batchResponse(JsonObject o, List<GroupBatchOp> ops) {
        JsonArray raw = arr(o, "results");
        if (raw.size() != ops.size()) {
            throw Json.wire("batch returned " + raw.size() + " results for " + ops.size() + " ops");
        }
        List<GroupBatchResult> results = new ArrayList<>(raw.size());
        for (int i = 0; i < raw.size(); i++) {
            JsonElement el = raw.get(i);
            if (el == null || el.isJsonNull()) {
                results.add(GroupBatchResult.NONE);
                continue;
            }
            if (!el.isJsonObject()) throw Json.wire("batch result " + i + " is not an object");
            results.add(batchResult(ops.get(i), el.getAsJsonObject()));
        }
        return new GroupBatchResponse(str(o, "version"), results);
    }

    private static GroupBatchResult batchResult(GroupBatchOp op, JsonObject r) {
        return switch (op) {
            case GroupBatchOp.GroupUpdate g -> new GroupBatchResult.GroupResult(group(r));
            case GroupBatchOp.RoleEntrySet s -> new GroupBatchResult.RoleResult(role(r));
            case GroupBatchOp.RoleEntryRemove s -> new GroupBatchResult.RoleResult(role(r));
            case GroupBatchOp.RelationshipSet s -> new GroupBatchResult.RelationshipResult(relationship(r));
            case GroupBatchOp.RelationshipClear c -> GroupBatchResult.NONE;
            case GroupBatchOp.MemberAdd m -> new GroupBatchResult.MemberResult(member(r));
            case GroupBatchOp.MemberKick m -> new GroupBatchResult.MemberResult(member(r));
            case GroupBatchOp.MemberLeave m -> new GroupBatchResult.MemberResult(member(r));
            case GroupBatchOp.MemberBan m -> new GroupBatchResult.MemberResult(member(r));
            case GroupBatchOp.MemberUnban m -> new GroupBatchResult.MemberResult(member(r));
            case GroupBatchOp.MemberUpdate m -> new GroupBatchResult.MemberResult(member(r));
            case GroupBatchOp.MemberRoleAdd m -> new GroupBatchResult.MemberResult(member(r));
            case GroupBatchOp.MemberRoleRemove m -> new GroupBatchResult.MemberResult(member(r));
        };
    }

    /** Decodes an import result. */
    public static ImportResult importResult(JsonObject o) {
        List<ImportResult.Item> items = new ArrayList<>();
        JsonArray raw = optArr(o, "items");
        if (raw != null) {
            for (JsonObject i : objects(raw, "items")) {
                items.add(new ImportResult.Item(str(i, "userId"), str(i, "status"), optLong(i, "version", 0)));
            }
        }
        return new ImportResult(
                optLong(o, "created", 0),
                optLong(o, "reactivated", 0),
                optLong(o, "updated", 0),
                optLong(o, "unchanged", 0),
                items);
    }

    /** Decodes a {@code { items, nextCursor }} page. */
    public static <T> Page<T> page(JsonObject o, Function<JsonObject, T> item) {
        return new Page<>(list(arr(o, "items"), "items", item), optStr(o, "nextCursor"));
    }

    /** Decodes an array of objects. */
    public static <T> List<T> list(JsonArray a, String name, Function<JsonObject, T> item) {
        List<T> out = new ArrayList<>(a.size());
        for (JsonObject o : objects(a, name)) out.add(item.apply(o));
        return List.copyOf(out);
    }
}
