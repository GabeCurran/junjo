package io.junjo.sdk.internal;

import io.junjo.sdk.model.AddSanctionInput;
import io.junjo.sdk.model.CreateBanInput;
import io.junjo.sdk.model.CreateGroupInput;
import io.junjo.sdk.model.CreateRoleInput;
import io.junjo.sdk.model.MemberImport;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.SetMemberNotesInput;
import io.junjo.sdk.model.UpdateRoleInput;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Every write route the SDK sends, in one place. The API namespaces and {@code QueuedWrite} both
 * build their requests here, so the two paths always send the same method, path and body. Every
 * caller-supplied id is encoded as one path segment.
 *
 * <p>Internal: not part of the supported API.
 */
public final class Routes {
    private Routes() {}

    // ------------------------------------------------------------------ groups

    public static Route createGroup(CreateGroupInput input) {
        return new Route("POST", "/v1/groups", input, false);
    }

    public static Route kick(String groupId, String userId, String reason) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (reason != null) body.put("reason", reason);
        return new Route("POST", member(groupId, userId) + "/kick", body, false);
    }

    public static Route groupBan(String groupId, String userId, String reason, Instant expiresAt, String actorUserId) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (reason != null) body.put("reason", reason);
        if (expiresAt != null) body.put("expiresAt", expiresAt.toString());
        if (actorUserId != null) body.put("actorUserId", actorUserId);
        return new Route("POST", member(groupId, userId) + "/ban", body, false);
    }

    public static Route groupUnban(String groupId, String userId, String actorUserId) {
        return new Route("DELETE", member(groupId, userId) + "/ban", actor(actorUserId), true);
    }

    // ------------------------------------------------------------------ members

    public static Route addMember(String groupId, String userId, String roleId, String actorUserId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("userId", userId);
        if (roleId != null) body.put("roleId", roleId);
        if (actorUserId != null) body.put("actorUserId", actorUserId);
        return new Route("POST", "/v1/groups/" + Paths.seg(groupId) + "/members", body, false);
    }

    public static Route importMembers(String groupId, MemberImport request) {
        return new Route("POST", "/v1/groups/" + Paths.seg(groupId) + "/members/import", request, false);
    }

    public static Route setMetadata(String groupId, String userId, Map<String, ?> metadata) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("metadata", metadata);
        return new Route("PATCH", member(groupId, userId), body, false);
    }

    public static Route setNotes(String groupId, String userId, SetMemberNotesInput notes) {
        return new Route("PATCH", member(groupId, userId), notes, false);
    }

    public static Route assignRole(String groupId, String userId, String roleId, String actorUserId) {
        return new Route("POST", memberRole(groupId, userId, roleId), actor(actorUserId), false);
    }

    public static Route removeRole(String groupId, String userId, String roleId, String actorUserId) {
        return new Route("DELETE", memberRole(groupId, userId, roleId), actor(actorUserId), false);
    }

    public static Route overridePermission(String groupId, String userId, String permission, boolean grant) {
        return new Route("POST", memberPermission(groupId, userId, permission), Map.of("grant", grant), false);
    }

    public static Route clearPermissionOverride(String groupId, String userId, String permission) {
        return new Route("DELETE", memberPermission(groupId, userId, permission), null, false);
    }

    // ------------------------------------------------------------------ roles

    public static Route createRole(String groupId, CreateRoleInput input) {
        return new Route("POST", "/v1/groups/" + Paths.seg(groupId) + "/roles", input, false);
    }

    public static Route updateRole(String roleId, UpdateRoleInput input) {
        return new Route("PATCH", role(roleId), input, false);
    }

    public static Route deleteRole(String roleId) {
        return new Route("DELETE", role(roleId), null, false);
    }

    public static Route setEntries(String roleId, List<PermissionEntry> entries) {
        List<Map<String, Object>> list = new ArrayList<>(entries.size());
        for (PermissionEntry e : entries) list.add(entry(e.permission(), e.value()));
        return new Route("PUT", role(roleId) + "/entries", Map.of("entries", list), false);
    }

    public static Route grantPermission(String roleId, String permission, boolean value) {
        return new Route("POST", role(roleId) + "/permissions", entry(permission, value), false);
    }

    public static Route revokePermission(String roleId, String permission) {
        return new Route("DELETE", role(roleId) + "/permissions/" + Paths.seg(permission), null, false);
    }

    public static Route setParents(String roleId, List<String> parents) {
        return new Route("PUT", role(roleId) + "/parents", Map.of("parents", List.copyOf(parents)), false);
    }

    // ------------------------------------------------------------------ moderation

    public static Route addBan(CreateBanInput input) {
        return new Route("POST", "/v1/bans", input, false);
    }

    public static Route removeBan(String userId, String actorUserId) {
        return new Route("DELETE", "/v1/bans/" + Paths.seg(userId), actor(actorUserId), true);
    }

    public static Route addSanction(AddSanctionInput input) {
        return new Route("POST", "/v1/sanctions", input, false);
    }

    public static Route removeSanction(String userId, String type, String actorUserId) {
        return new Route(
                "DELETE", "/v1/sanctions/" + Paths.seg(userId) + "/" + Paths.seg(type), actor(actorUserId), true);
    }

    // ------------------------------------------------------------------ identities

    public static Route setDisplayName(String userId, String displayName) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("displayName", displayName);
        return new Route("PUT", user(userId) + "/display-name", body, false);
    }

    public static Route requestLinkCode(String userId) {
        return new Route("POST", user(userId) + "/link-codes", null, false);
    }

    public static Route redeemLinkCode(String code, String userId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("userId", userId);
        return new Route("POST", "/v1/link-codes/redeem", body, false);
    }

    public static Route unlink(String userId) {
        return new Route("POST", user(userId) + "/unlink", null, false);
    }

    // ------------------------------------------------------------------ paths shared with reads

    public static String group(String groupId) {
        return "/v1/groups/" + Paths.seg(groupId);
    }

    public static String member(String groupId, String userId) {
        return group(groupId) + "/members/" + Paths.seg(userId);
    }

    public static String role(String roleId) {
        return "/v1/roles/" + Paths.seg(roleId);
    }

    public static String user(String userId) {
        return "/v1/users/" + Paths.seg(userId);
    }

    private static String memberRole(String groupId, String userId, String roleId) {
        return member(groupId, userId) + "/roles/" + Paths.seg(roleId);
    }

    private static String memberPermission(String groupId, String userId, String permission) {
        return member(groupId, userId) + "/permissions/" + Paths.seg(permission);
    }

    private static Map<String, Object> entry(String permission, boolean value) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("permission", permission);
        m.put("value", value);
        return m;
    }

    private static Map<String, Object> actor(String actorUserId) {
        return actorUserId == null ? null : Map.of("actorUserId", actorUserId);
    }
}
