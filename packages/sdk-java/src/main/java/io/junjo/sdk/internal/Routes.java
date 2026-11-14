package io.junjo.sdk.internal;

import io.junjo.sdk.model.AddSanctionInput;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.CreateBanInput;
import io.junjo.sdk.model.CreateGroupInput;
import io.junjo.sdk.model.CreateRoleInput;
import io.junjo.sdk.model.MemberImport;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.SetMemberNotesInput;
import io.junjo.sdk.model.UpdateGroupInput;
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

    public static Route updateGroup(String groupId, UpdateGroupInput input) {
        return new Route("PATCH", group(groupId), input, false);
    }

    public static Route deleteGroup(String groupId, boolean hard, String actorUserId) {
        String path = new Paths.Query()
                .add("hard", hard ? "true" : null)
                .add("actorUserId", actorUserId)
                .appendTo(group(groupId));
        return new Route("DELETE", path, null, false);
    }

    public static Route restoreGroup(String groupId) {
        return new Route("POST", group(groupId) + "/restore", null, false);
    }

    public static Route setParent(String groupId, String parentGroupId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("parentGroupId", parentGroupId);
        return new Route("PUT", group(groupId) + "/parent", body, false);
    }

    public static Route join(String groupId, String userId, String passcode) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("userId", userId);
        if (passcode != null) body.put("passcode", passcode);
        return new Route("POST", group(groupId) + "/join", body, false);
    }

    public static Route leave(String groupId, String userId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("userId", userId);
        return new Route("POST", group(groupId) + "/leave", body, false);
    }

    public static Route kick(String groupId, String userId, String reason) {
        return kick(groupId, userId, reason, null);
    }

    public static Route kick(String groupId, String userId, String reason, String actorUserId) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (reason != null) body.put("reason", reason);
        if (actorUserId != null) body.put("actorUserId", actorUserId);
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

    // ------------------------------------------------------------------ invitations

    /**
     * Creates an invitation. A null {@code targetUserId} makes an open invitation redeemable by
     * code.
     */
    public static Route invite(String groupId, String targetUserId, String roleId, String expiresIn) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (targetUserId != null) body.put("targetUserId", targetUserId);
        if (roleId != null) body.put("roleId", roleId);
        if (expiresIn != null) body.put("expiresIn", expiresIn);
        return new Route("POST", group(groupId) + "/invitations", body, false);
    }

    public static Route acceptInvitation(String code, String userId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("userId", userId);
        return new Route("POST", invitation(code) + "/accept", body, false);
    }

    public static Route declineInvitation(String code, String userId) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (userId != null) body.put("userId", userId);
        return new Route("POST", invitation(code) + "/decline", body, false);
    }

    public static Route revokeInvitation(String code) {
        return new Route("DELETE", invitation(code), null, false);
    }

    // ------------------------------------------------------------------ relationships

    public static Route setRelationship(
            String groupAId, String groupBId, String type, boolean mutual, String actorUserId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", type);
        if (mutual) body.put("mutual", true);
        if (actorUserId != null) body.put("actorUserId", actorUserId);
        return new Route("PUT", relationship(groupAId, groupBId), body, false);
    }

    public static Route clearRelationship(String groupAId, String groupBId, boolean mutual, String actorUserId) {
        String path = new Paths.Query()
                .add("mutual", mutual ? "true" : null)
                .add("actorUserId", actorUserId)
                .appendTo(relationship(groupAId, groupBId));
        return new Route("DELETE", path, null, false);
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
        return overridePermission(groupId, userId, permission, grant, Context.GLOBAL);
    }

    public static Route overridePermission(
            String groupId, String userId, String permission, boolean grant, Context context) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("grant", grant);
        putContext(body, context);
        return new Route("POST", memberPermission(groupId, userId, permission), body, false);
    }

    public static Route clearPermissionOverride(String groupId, String userId, String permission) {
        return clearPermissionOverride(groupId, userId, permission, Context.GLOBAL);
    }

    public static Route clearPermissionOverride(String groupId, String userId, String permission, Context context) {
        return new Route("DELETE", withContext(memberPermission(groupId, userId, permission), context), null, false);
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
        for (PermissionEntry e : entries) list.add(entry(e.permission(), e.value(), e.context()));
        return new Route("PUT", role(roleId) + "/entries", Map.of("entries", list), false);
    }

    public static Route grantPermission(String roleId, String permission, boolean value) {
        return grantPermission(roleId, permission, value, Context.GLOBAL);
    }

    public static Route grantPermission(String roleId, String permission, boolean value, Context context) {
        return new Route("POST", role(roleId) + "/permissions", entry(permission, value, context), false);
    }

    public static Route revokePermission(String roleId, String permission) {
        return revokePermission(roleId, permission, Context.GLOBAL);
    }

    public static Route revokePermission(String roleId, String permission, Context context) {
        return new Route(
                "DELETE", withContext(role(roleId) + "/permissions/" + Paths.seg(permission), context), null, false);
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

    public static String invitation(String code) {
        return "/v1/invitations/" + Paths.seg(code);
    }

    public static String relationship(String groupAId, String groupBId) {
        return group(groupAId) + "/relationships/" + Paths.seg(groupBId);
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

    /**
     * Appends a context as {@code context.<key>=<value>} query parameters, the form the check and
     * delete routes read; the global context adds none.
     */
    public static String withContext(String path, Context context) {
        return contextQuery(new Paths.Query(), context).appendTo(path);
    }

    /** Adds a context's {@code context.<key>=<value>} parameters to a query. */
    public static Paths.Query contextQuery(Paths.Query query, Context context) {
        if (context != null) context.values().forEach((k, v) -> query.add("context." + k, v));
        return query;
    }

    private static Map<String, Object> entry(String permission, boolean value, Context context) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("permission", permission);
        m.put("value", value);
        putContext(m, context);
        return m;
    }

    // A global write sends no context field; the server reads an absent context as global.
    private static void putContext(Map<String, Object> body, Context context) {
        if (context != null && !context.isGlobal()) body.put("context", context.values());
    }

    private static Map<String, Object> actor(String actorUserId) {
        return actorUserId == null ? null : Map.of("actorUserId", actorUserId);
    }
}
